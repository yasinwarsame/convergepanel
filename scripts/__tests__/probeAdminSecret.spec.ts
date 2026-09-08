/**
 * Phase FIRST-ADMIN-C13 — the containment proof, tested as a bound state
 * transition rather than as a single response.
 *
 * The prior version treated "401 + route marker" as proof. Review showed that
 * establishes only "the origin you contacted rejected the string you supplied",
 * and that BOTH halves fail open with no attacker: a preview deploy or a
 * mistyped host running this same code returns the GENUINE marker when its
 * ADMIN_SECRET is unset, and a shell-mangled secret is rejected by the LIVE
 * route. Either reads as a successful rotation.
 *
 * So the tests below are about the transition — same origin, same secret bytes,
 * same process, accepted-before and rejected-after — and about the pre-check
 * that makes a wrong host or a mangled secret unable to reach the proof at all.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const SCRIPT = join(process.cwd(), "scripts/probe-admin-secret.mjs");
const IMPL = join(process.cwd(), "scripts/lib/probe-admin-secret.mjs");
const OLD = "old-bootstrap-secret-CANARY-aaaaaaaaaaaa";
const MARKER = "x-convergepanel-admin-secret-probe";
const REJECTED = "credential-rejected";
const ACCEPTED = "credential-accepted";

// The library under test is ESM run by node; jest cannot import it, so the unit
// tests drive it through a tiny node -e harness and the CLI tests spawn it.
const nodeEval = (src: string): Promise<{ status: number | null; out: string }> =>
  new Promise((resolve) => {
    const c = spawn("node", ["--input-type=module", "-e", src]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (status) => resolve({ status, out }));
  });

type Hit = { url?: string; method?: string; body: string; headers: Record<string, unknown> };
async function server(reply: (n: number) => { status: number; headers?: Record<string, string> }) {
  const hits: Hit[] = [];
  const s: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url, method: req.method, body, headers: req.headers });
      const { status, headers } = reply(hits.length);
      res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  return { hits, origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => s.close(() => r())) };
}

type Ran = { status: number | null; stdout: string };
function runCli(args: string[], env: Record<string, string> = {}, stdin = "\n", script = SCRIPT): Promise<Ran> {
  return new Promise((resolve) => {
    const c = spawn("node", [script, ...args], {
      env: { ...process.env, OLD_ADMIN_SECRET: OLD, PROBE_ALLOW_INSECURE_LOOPBACK: "1", ...env },
    });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stdout += d));
    c.stdin.end(stdin);
    c.on("close", (status) => resolve({ status, stdout }));
  });
}

/** Answers ACCEPTED for the first n requests, then REJECTED — a rotation. */
const rotatingAfter = (n: number) => (i: number) =>
  i <= n ? { status: 400, headers: { [MARKER]: ACCEPTED } } : { status: 401, headers: { [MARKER]: REJECTED } };
const alwaysReject = () => ({ status: 401, headers: { [MARKER]: REJECTED } });
const alwaysAccept = () => ({ status: 400, headers: { [MARKER]: ACCEPTED } });

// ---------------------------------------------------------------------------

describe("TARGET URL CONTRACT — every refusal is a specific code, and sends NOTHING", () => {
  /**
   * The previous block asserted `/refused|INCONCLUSIVE/`. Every non-proof line
   * this tool emits begins with an INCONCLUSIVE-ish token, so the alternation
   * could not fail: disabling EVERY url guard at once left the suite green,
   * and with the http guard gone the tool would POST a live ADMIN_SECRET in
   * cleartext to an attacker-nameable host.
   *
   * Each case now asserts the exact structured reason AND that a real server
   * received zero requests.
   */
  it.each([
    ["a query string", "https://convergepanel.com/?q=1", "ERR_QUERY_NOT_ALLOWED"],
    ["a path", "https://convergepanel.com/some/path", "ERR_PATH_NOT_ALLOWED"],
    ["a fragment", "https://convergepanel.com/#frag", "ERR_FRAGMENT_NOT_ALLOWED"],
    ["embedded credentials", "https://u:p@convergepanel.com", "ERR_USERINFO_NOT_ALLOWED"],
    ["a non-http scheme", "file:///etc/passwd", "ERR_UNSUPPORTED_SCHEME"],
    ["nonsense", "not-a-url", "ERR_TARGET_NOT_A_URL"],
  ])("refuses %s with %s", async (_label, url, code) => {
    const res = await nodeEval(`
      import { resolveEndpoint } from ${JSON.stringify(IMPL)};
      const r = resolveEndpoint(${JSON.stringify(url)}, { requireCanonical: true });
      console.log(JSON.stringify(r));
    `);
    expect(JSON.parse(res.out)).toEqual({ ok: false, reason: code });
  });

  it("refuses plain http to a REACHABLE host, and the host receives nothing", async () => {
    // The old row used an unresolvable reserved TLD, so it "passed" via DNS
    // failure whether or not the guard existed.
    const s = await server(alwaysReject);
    try {
      const res = await nodeEval(`
        import { observeOldSecret } from ${JSON.stringify(IMPL)};
        const r = await observeOldSecret({ origin: ${JSON.stringify(s.origin)}, secret: "x", requireCanonical: false, allowInsecureLoopback: false });
        console.log(JSON.stringify(r));
      `);
      expect(res.out).toContain("ERR_NON_HTTPS_PRODUCTION_ORIGIN");
      expect(s.hits).toHaveLength(0);          // nothing was sent
    } finally { await s.close(); }
  });

  it("refuses a non-canonical https origin in production mode, sending nothing", async () => {
    const res = await nodeEval(`
      import { resolveEndpoint } from ${JSON.stringify(IMPL)};
      console.log(JSON.stringify(resolveEndpoint("https://staging.example.com", { requireCanonical: true })));
    `);
    expect(JSON.parse(res.out)).toEqual({ ok: false, reason: "ERR_NOT_CANONICAL_PRODUCTION_ORIGIN" });
  });

  it("ANCHOR: the canonical origin IS accepted and builds the exact endpoint", async () => {
    // Without this, "refuse everything" would satisfy every row above.
    const res = await nodeEval(`
      import { resolveEndpoint, CANONICAL_PRODUCTION_ORIGIN } from ${JSON.stringify(IMPL)};
      console.log(JSON.stringify(resolveEndpoint(CANONICAL_PRODUCTION_ORIGIN, { requireCanonical: true })));
    `);
    expect(JSON.parse(res.out)).toEqual({
      ok: true,
      url: "https://convergepanel.com/api/admin/set-admin",
      origin: "https://convergepanel.com",
    });
  });
});

describe("STATE MACHINE — there is no edge from INITIAL to PROVEN", () => {
  const drive = (body: string) => nodeEval(`
    import { createContainmentProof, STATES } from ${JSON.stringify(IMPL)};
    const mk = (reply) => createContainmentProof({
      origin: "http://127.0.0.1:9/", secret: "s", allowInsecureLoopback: true, requireCanonical: false,
      fetchImpl: async () => reply,
    });
    const ok400 = { status: 400, headers: { get: (h) => h === ${JSON.stringify(MARKER)} ? ${JSON.stringify(ACCEPTED)} : null } };
    const ok401 = { status: 401, headers: { get: (h) => h === ${JSON.stringify(MARKER)} ? ${JSON.stringify(REJECTED)} : null } };
    ${body}
  `);

  it("postcheck alone cannot prove containment", async () => {
    const r = await drive(`
      const p = mk(ok401);
      const post = await p.postcheck();
      console.log(JSON.stringify({ ok: post.ok, state: p.state }));
    `);
    expect(JSON.parse(r.out)).toEqual({ ok: false, state: "ABORTED" });
  });

  it("a REJECTED precheck aborts and can never reach PROVEN", async () => {
    const r = await drive(`
      const p = mk(ok401);
      const pre = await p.precheck();
      const arm = p.armForRotation();
      const post = await p.postcheck();
      console.log(JSON.stringify({ pre: pre.ok, arm: arm.ok, post: post.ok, state: p.state }));
    `);
    expect(JSON.parse(r.out)).toEqual({ pre: false, arm: false, post: false, state: "ABORTED" });
  });

  it("skipping the arm step aborts", async () => {
    const r = await drive(`
      const p = mk(ok400);
      await p.precheck();
      const post = await p.postcheck();
      console.log(JSON.stringify({ post: post.ok, state: p.state }));
    `);
    expect(JSON.parse(r.out)).toEqual({ post: false, state: "ABORTED" });
  });

  it("the full transition — accepted then rejected — reaches PROVEN", async () => {
    const r = await nodeEval(`
      import { createContainmentProof } from ${JSON.stringify(IMPL)};
      let n = 0;
      const p = createContainmentProof({
        origin: "http://127.0.0.1:9/", secret: "s", allowInsecureLoopback: true, requireCanonical: false,
        fetchImpl: async () => (++n === 1
          ? { status: 400, headers: { get: () => ${JSON.stringify(ACCEPTED)} } }
          : { status: 401, headers: { get: () => ${JSON.stringify(REJECTED)} } }),
      });
      const pre = await p.precheck(); p.armForRotation(); const post = await p.postcheck();
      console.log(JSON.stringify({ pre: pre.ok, post: post.ok, state: p.state, calls: n }));
    `);
    expect(JSON.parse(r.out)).toEqual({ pre: true, post: true, state: "PRODUCTION_CONTAINMENT_PROVEN", calls: 2 });
  });

  it("an UNATTESTED 401 at POST does not prove containment", async () => {
    /**
     * The marker requirement must bind on the POST side too. Without this, a
     * bare 401 — a WAF, an SSO gate, deployment protection, a foreign origin —
     * closes the transition. Pinned because the mutation dropping the marker
     * conjunct from `classify` was otherwise unobservable: every other fixture
     * supplies the marker.
     */
    const r = await nodeEval(`
      import { createContainmentProof } from ${JSON.stringify(IMPL)};
      let n = 0;
      const p = createContainmentProof({
        origin: "http://127.0.0.1:9/", secret: "s", allowInsecureLoopback: true, requireCanonical: false,
        fetchImpl: async () => (++n === 1
          ? { status: 400, headers: { get: () => ${JSON.stringify(ACCEPTED)} } }
          : { status: 401, headers: { get: () => null } }),   // bare 401, no marker
      });
      const pre = await p.precheck(); p.armForRotation(); const post = await p.postcheck();
      console.log(JSON.stringify({ pre: pre.ok, post: post.ok, state: p.state }));
    `);
    expect(JSON.parse(r.out)).toEqual({ pre: true, post: false, state: "ABORTED" });
  });

  it("an UNATTESTED 400 at PRE does not confirm the credential is live", async () => {
    const r = await nodeEval(`
      import { createContainmentProof } from ${JSON.stringify(IMPL)};
      const p = createContainmentProof({
        origin: "http://127.0.0.1:9/", secret: "s", allowInsecureLoopback: true, requireCanonical: false,
        fetchImpl: async () => ({ status: 400, headers: { get: () => null } }),
      });
      const pre = await p.precheck();
      console.log(JSON.stringify({ pre: pre.ok, state: p.state }));
    `);
    expect(JSON.parse(r.out)).toEqual({ pre: false, state: "ABORTED" });
  });

  it("an ACCEPTED postcheck (rotation did not take) does NOT prove containment", async () => {
    const r = await drive(`
      const p = mk(ok400);
      await p.precheck(); p.armForRotation();
      const post = await p.postcheck();
      console.log(JSON.stringify({ post: post.ok, state: p.state }));
    `);
    expect(JSON.parse(r.out)).toEqual({ post: false, state: "ABORTED" });
  });
});

describe("BINDING — the second observation uses the same origin and the same bytes", () => {
  it("mutating OLD_ADMIN_SECRET between phases does not retarget the postcheck", async () => {
    const r = await nodeEval(`
      import { createContainmentProof } from ${JSON.stringify(IMPL)};
      process.env.OLD_ADMIN_SECRET = "original";
      const sent = [];
      const p = createContainmentProof({
        origin: "http://127.0.0.1:9/", secret: process.env.OLD_ADMIN_SECRET,
        allowInsecureLoopback: true, requireCanonical: false,
        fetchImpl: async (_u, init) => { sent.push(JSON.parse(init.body).secret);
          return sent.length === 1
            ? { status: 400, headers: { get: () => ${JSON.stringify(ACCEPTED)} } }
            : { status: 401, headers: { get: () => ${JSON.stringify(REJECTED)} } }; },
      });
      await p.precheck();
      process.env.OLD_ADMIN_SECRET = "SWAPPED-AFTER-PRECHECK";   // the attack
      p.armForRotation();
      await p.postcheck();
      console.log(JSON.stringify(sent));
    `);
    expect(JSON.parse(r.out)).toEqual(["original", "original"]);
  });

  it("mutating the origin between phases does not retarget the postcheck", async () => {
    const r = await nodeEval(`
      import { createContainmentProof } from ${JSON.stringify(IMPL)};
      process.env.PROBE_ORIGIN_OVERRIDE = "http://127.0.0.1:9/";
      const urls = [];
      const p = createContainmentProof({
        origin: process.env.PROBE_ORIGIN_OVERRIDE, secret: "s",
        allowInsecureLoopback: true, requireCanonical: false,
        fetchImpl: async (u) => { urls.push(u);
          return urls.length === 1
            ? { status: 400, headers: { get: () => ${JSON.stringify(ACCEPTED)} } }
            : { status: 401, headers: { get: () => ${JSON.stringify(REJECTED)} } }; },
      });
      await p.precheck();
      process.env.PROBE_ORIGIN_OVERRIDE = "http://127.0.0.1:10/";  // the attack
      p.armForRotation();
      await p.postcheck();
      console.log(JSON.stringify(urls));
    `);
    const urls = JSON.parse(r.out);
    expect(urls[0]).toBe(urls[1]);
    expect(urls[0]).toContain(":9/api/admin/set-admin");
  });
});

describe("WRONG HOST — a foreign instance cannot produce a proof", () => {
  it("an origin whose ADMIN_SECRET is unset rejects at PRE and the run aborts", async () => {
    // This is the attacker-free false proof: a preview/staging instance returns
    // the GENUINE marker because its own secret is unset.
    const foreign = await server(alwaysReject);
    try {
      const r = await runCli(["--production-two-phase"], { PROBE_ORIGIN_OVERRIDE: foreign.origin });
      expect(r.stdout).toContain("[PRE] ABORT");
      expect(r.stdout).toContain("NOT PROVEN");
      expect(r.stdout).not.toContain("PRODUCTION_CONTAINMENT_PROVEN");
      expect(r.status).not.toBe(0);
      expect(foreign.hits).toHaveLength(1);   // it tried once, then stopped
    } finally { await foreign.close(); }
  });

  it("ANCHOR: the same workflow against an origin that DOES hold the secret proves containment", async () => {
    // Without this, "always abort" would satisfy the row above.
    const prod = await server(rotatingAfter(1));
    try {
      const r = await runCli(["--production-two-phase"], { PROBE_ORIGIN_OVERRIDE: prod.origin });
      expect(r.stdout).toContain("PRECHECK_OLD_CREDENTIAL_CONFIRMED_LIVE");
      expect(r.stdout).toContain("PRODUCTION_CONTAINMENT_PROVEN");
      expect(r.status).toBe(0);
      expect(prod.hits).toHaveLength(2);
      // Same endpoint both times, same secret both times.
      expect(prod.hits[0].url).toBe(prod.hits[1].url);
      expect(JSON.parse(prod.hits[0].body).secret).toBe(JSON.parse(prod.hits[1].body).secret);
    } finally { await prod.close(); }
  });
});

describe("MANGLED SECRET — a wrong credential cannot reach the proof", () => {
  it.each([
    ["a dollar sign", "secret-with-$VAR-inside-aaaaaaaaaaaa"],
    ["a backtick", "secret-with-`cmd`-inside-aaaaaaaaaaa"],
    ["a space", "secret with spaces inside aaaaaaaaaa"],
    ["a bang", "secret-with-!-inside-aaaaaaaaaaaaaaa"],
    ["a glob", "secret-with-*-inside-aaaaaaaaaaaaaaa"],
    ["quotes and backslash", `secret-with-"'\\-inside-aaaaaaaaaa`],
    ["unicode", "secret-with-café-😀-inside-aaaaaaaa"],
  ])("%s: the exact bytes are transmitted, and a mismatch aborts at PRE", async (_label, secret) => {
    // The env var is passed through the process environment, never interpolated
    // into a shell command line — which is the operator mechanism the runbook
    // now prescribes.
    const prod = await server(rotatingAfter(1));
    try {
      const r = await runCli(["--production-two-phase"], { PROBE_ORIGIN_OVERRIDE: prod.origin, OLD_ADMIN_SECRET: secret });
      expect(JSON.parse(prod.hits[0].body).secret).toBe(secret);   // byte-exact
      expect(r.status).toBe(0);
    } finally { await prod.close(); }

    // Now the mangled form: the live route rejects it, so PRE aborts.
    const live = await server(alwaysReject);
    try {
      const r = await runCli(["--production-two-phase"], { PROBE_ORIGIN_OVERRIDE: live.origin, OLD_ADMIN_SECRET: secret });
      expect(r.stdout).toContain("[PRE] ABORT");
      expect(r.status).not.toBe(0);
    } finally { await live.close(); }
  });
});

describe("SINGLE-SHOT MODE can never claim containment", () => {
  it.each([
    ["a rejection", alwaysReject],
    ["an acceptance", alwaysAccept],
  ])("%s reports an observation only", async (_l, reply) => {
    const s = await server(reply);
    try {
      const r = await runCli(["--observe", s.origin]);
      expect(r.stdout).toContain("OBSERVATION ONLY");
      expect(r.stdout).not.toContain("PRODUCTION_CONTAINMENT_PROVEN");
      expect(r.status).not.toBe(0);
    } finally { await s.close(); }
  });
});

describe("REDIRECTS — a redirect is a refusal, never a result", () => {
  it.each([[301], [302], [303], [307], [308]])(
    "HTTP %i: the target receives NOTHING and the run aborts",
    async (code) => {
      const target = await server(alwaysReject);
      const redirector = await server(() => ({ status: code as number, headers: { location: `${target.origin}/api/admin/set-admin` } }));
      try {
        const r = await runCli(["--production-two-phase"], { PROBE_ORIGIN_OVERRIDE: redirector.origin });
        expect(target.hits).toHaveLength(0);
        expect(JSON.stringify(target.hits)).not.toContain(OLD);
        expect(r.status).not.toBe(0);
        expect(r.stdout).not.toContain("PRODUCTION_CONTAINMENT_PROVEN");
      } finally { await redirector.close(); await target.close(); }
    }
  );
});

describe("REQUEST SHAPE and SECRET HANDLING", () => {
  it("body key set is exactly [secret]; the secret appears nowhere else", async () => {
    const prod = await server(rotatingAfter(1));
    try {
      await runCli(["--production-two-phase"], { PROBE_ORIGIN_OVERRIDE: prod.origin, UID: "victim", EMAIL: "v@x.test" });
      for (const h of prod.hits) {
        expect(Object.keys(JSON.parse(h.body))).toEqual(["secret"]);
        expect(JSON.stringify(h.headers)).not.toContain(OLD);
        expect(h.url).not.toContain(OLD);
        const wire = `${h.url} ${JSON.stringify(h.headers)}`.toLowerCase();
        for (const f of ["uid", "userid", "email", "claim", "role"]) expect(wire).not.toContain(f);
      }
    } finally { await prod.close(); }
  });

  it.each([
    ["proven run", rotatingAfter(1)],
    ["aborted run", alwaysReject],
  ])("%s: the secret never appears in output", async (_l, reply) => {
    const s = await server(reply);
    try {
      const r = await runCli(["--production-two-phase"], { PROBE_ORIGIN_OVERRIDE: s.origin });
      expect(r.stdout).not.toContain(OLD);
    } finally { await s.close(); }
  });

  it("the fetch uses no-store and refuses redirects", () => {
    const src = readFileSync(IMPL, "utf8");
    expect(src).toContain('redirect: "error"');
    expect(src).toContain('cache: "no-store"');
  });

  it("buildProbeBody has no second parameter that could become a claim target", () => {
    const src = readFileSync(IMPL, "utf8");
    const sig = src.match(/export function buildProbeBody\(([^)]*)\)/)![1];
    expect(sig.split(",").filter((x) => x.trim()).length).toBe(1);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\buid\b/i);
  });
});

describe("FILESYSTEM INVOCATION — no invocation may silently no-op", () => {
  const staged = (() => {
    const root = mkdtempSync(join(tmpdir(), "probe-fs-"));
    const spaced = join(root, "dir with spaces");
    mkdirSync(join(spaced, "lib"), { recursive: true });
    copyFileSync(SCRIPT, join(spaced, "probe-admin-secret.mjs"));
    copyFileSync(IMPL, join(spaced, "lib/probe-admin-secret.mjs"));
    const link = join(root, "link");
    try { symlinkSync(spaced, link); } catch { /* no symlinks */ }
    return { spaced, link };
  })();

  it.each([
    ["absolute path", () => SCRIPT],
    ["path containing spaces", () => join(staged.spaced, "probe-admin-secret.mjs")],
    ["through a symlinked directory", () => join(staged.link, "probe-admin-secret.mjs")],
  ])("%s: runs and reports", async (_label, path) => {
    const prod = await server(rotatingAfter(1));
    try {
      const r = await runCli(["--production-two-phase"], { PROBE_ORIGIN_OVERRIDE: prod.origin }, "\n", path());
      expect(prod.hits).toHaveLength(2);
      expect(r.stdout.trim()).not.toBe("");
      expect(r.status).toBe(0);
    } finally { await prod.close(); }
  });
});

describe("ATTESTATION CONTRACT — the two copies of the constants agree", () => {
  it("header name and both marker values match the route's module", () => {
    const ts = readFileSync("lib/security/adminSecretProbeAttestation.ts", "utf8");
    const mjs = readFileSync(IMPL, "utf8");
    for (const literal of [`"${MARKER}"`, `"${REJECTED}"`, `"${ACCEPTED}"`]) {
      expect({ literal, ts: ts.includes(literal), mjs: mjs.includes(literal) })
        .toEqual({ literal, ts: true, mjs: true });
    }
  });
});
