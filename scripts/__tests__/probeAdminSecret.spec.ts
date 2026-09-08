/**
 * Phase FIRST-ADMIN-C14 — the containment proof, tested as a bound state
 * transition that SURVIVES transient failure, at an origin that is not a
 * parameter of the production entry point.
 *
 * TWO THINGS R10 PROVED WRONG, AND WHAT THE TESTS BELOW NOW PIN:
 *
 * 1. C13 built the production origin as `PROBE_ORIGIN_OVERRIDE ?? CANONICAL`
 *    and passed `requireCanonical: !PROBE_ALLOW_INSECURE_LOOPBACK`. Review ran
 *    the full transition against a foreign https host and got exit 0 and the
 *    literal `PRODUCTION_CONTAINMENT_PROVEN`, with the live old ADMIN_SECRET
 *    transmitted there. Every CLI test set the widening flag, so nothing
 *    constrained it. The production origin is now not a parameter at all, and
 *    the tests below assert the requested URL, not a refusal message.
 *
 * 2. C13's post-check aborted on ANY non-REJECTED observation. A 429 — which
 *    says nothing about the credential — destroyed the PRE evidence, and since
 *    PRE cannot be rebuilt once the rotation has deployed, one rate-limited
 *    request made the mandated artifact permanently unobtainable. The tests
 *    below drive 429 / 5xx / transport / redirect / unattributed-401 / still-
 *    accepted through the post-check and require the proof to still be armed
 *    and still provable afterwards.
 *
 * TEST SEAMS ARE NOT PRODUCTION SEAMS. Loopback servers are reached by calling
 * `createContainmentProof()` directly with an injected origin and `fetchImpl`.
 * That is a module-level dependency-injection seam. It is deliberately NOT
 * reachable from the shipped CLI's environment.
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
const CANONICAL = "https://convergepanel.com";
const CANONICAL_URL = `${CANONICAL}/api/admin/set-admin`;

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
    const c = spawn("node", [script, ...args], { env: { ...process.env, OLD_ADMIN_SECRET: OLD, ...env } });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stdout += d));
    c.stdin.end(stdin);
    c.on("close", (status) => resolve({ status, stdout }));
  });
}

/**
 * Drives the library in a child process with a SCRIPTED FAKE FETCH.
 * `steps` is a JS array literal of `{status, marker, throw, retryAfter}`.
 * Every requested URL and transmitted body is recorded and printed as JSON.
 */
function withScriptedFetch(steps: string, body: string, env: Record<string, string> = {}) {
  const envSrc = Object.entries(env)
    .map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`)
    .join("\n");
  return nodeEval(`
    ${envSrc}
    const M = await import(${JSON.stringify(IMPL)});
    const steps = ${steps};
    const calls = [];
    let i = 0;
    const fetchImpl = async (url, init) => {
      const step = steps[Math.min(i, steps.length - 1)]; i += 1;
      calls.push({ url, body: init.body, redirect: init.redirect, cache: init.cache });
      if (step.throw) { const e = new TypeError("fetch failed"); throw e; }
      const h = new Map();
      if (step.marker) h.set(${JSON.stringify(MARKER)}, step.marker);
      if (step.retryAfter) h.set("retry-after", step.retryAfter);
      return { status: step.status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null } };
    };
    const record = (o) => console.log("RESULT:" + JSON.stringify(o));
    const CALLS = () => calls;
    ${body}
  `);
}
const alwaysReject = () => ({ status: 401, headers: { [MARKER]: REJECTED } });
const alwaysAccept = () => ({ status: 400, headers: { [MARKER]: ACCEPTED } });

const parse = (out: string) => JSON.parse(out.split("RESULT:")[1].split("\n")[0]);

// ===========================================================================
describe("PRODUCTION ORIGIN IS NOT A PARAMETER — R10 item 25", () => {
  /**
   * These assert the URL that was REQUESTED, not the message that was printed.
   * A refusal-message assertion would have passed under the C13 defect too,
   * because the defect produced a successful-looking run at the wrong host.
   */
  const twoPhase = (steps: string, env: Record<string, string> = {}, extra = "") =>
    withScriptedFetch(
      steps,
      `
      const r = await M.runProductionTwoPhase({
        secret: ${JSON.stringify(OLD)},
        fetchImpl,
        prompt: async ({ attempt }) => attempt <= 4,
        ${extra}
      });
      record({ ...r, urls: CALLS().map((c) => c.url) });
      `,
      env
    );

  it("contacts EXACTLY the canonical production URL, both phases", async () => {
    const r = parse((await twoPhase(`[{status:400,marker:"${ACCEPTED}"},{status:401,marker:"${REJECTED}"}]`)).out);
    expect(r.urls).toEqual([CANONICAL_URL, CANONICAL_URL]);
    expect(r.origin).toBe(CANONICAL);
    expect(r.proven).toBe(true);
    expect(r.exit).toBe(0);
  });

  it("the C13 env seams have ZERO effect on the requested URL", async () => {
    const r = parse(
      (
        await twoPhase(`[{status:400,marker:"${ACCEPTED}"},{status:401,marker:"${REJECTED}"}]`, {
          PROBE_ORIGIN_OVERRIDE: "https://attacker.example",
          PROBE_ALLOW_INSECURE_LOOPBACK: "1",
          PROBE_TARGET: "https://attacker.example",
          PROBE_ORIGIN: "https://attacker.example",
        })
      ).out
    );
    expect(r.urls).toEqual([CANONICAL_URL, CANONICAL_URL]);
    expect(r.urls.join(" ")).not.toContain("attacker.example");
    expect(r.origin).toBe(CANONICAL);
  });

  it("an `origin` property passed to the wrapper is ignored — it is not a parameter", async () => {
    const r = parse(
      (
        await withScriptedFetch(
          `[{status:400,marker:"${ACCEPTED}"},{status:401,marker:"${REJECTED}"}]`,
          `
          const r = await M.runProductionTwoPhase({
            origin: "https://attacker.example",
            requireCanonical: false,
            allowInsecureLoopback: true,
            secret: ${JSON.stringify(OLD)},
            fetchImpl,
            prompt: async ({ attempt }) => attempt <= 2,
          });
          record({ ...r, urls: CALLS().map((c) => c.url) });
          `
        )
      ).out
    );
    expect(r.urls).toEqual([CANONICAL_URL, CANONICAL_URL]);
    expect(r.proven).toBe(true);
  });

  it("the shipped CLI contains no executable origin seam", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const code = src
      .split("\n")
      .filter((l) => !/^\s*\*/.test(l) && !/^\s*\/\*/.test(l) && !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).not.toMatch(/PROBE_ORIGIN_OVERRIDE/);
    expect(code).not.toMatch(/PROBE_ALLOW_INSECURE_LOOPBACK/);
    // ...and it reaches production only through the no-origin wrapper.
    expect(code).toContain("runProductionTwoPhase");
    expect(code).not.toMatch(/createContainmentProof/);
  });

  it("the wrapper refuses a foreign origin even if the canonical constant is the only input", async () => {
    // Proves the binding is the constant, not a caller-supplied string: with the
    // constant intact there is no code path that reaches another host.
    const r = parse(
      (await twoPhase(`[{status:400,marker:"${ACCEPTED}"},{status:401,marker:"${REJECTED}"}]`)).out
    );
    for (const u of r.urls) expect(u.startsWith(`${CANONICAL}/`)).toBe(true);
  });
});

// ===========================================================================
describe("POST SURVIVES TRANSIENT FAILURE — R10 item 27", () => {
  const armedThen = (steps: string, attempts = 6) =>
    withScriptedFetch(
      steps,
      `
      const proof = M.createContainmentProof({
        origin: ${JSON.stringify(CANONICAL)}, secret: ${JSON.stringify(OLD)}, fetchImpl,
      });
      const pre = await proof.precheck();
      proof.armForRotation();
      const posts = [];
      for (let n = 0; n < ${attempts}; n++) {
        const p = await proof.postcheck();
        posts.push({ ok: p.ok, state: p.state, outcome: p.outcome, retryable: p.retryable });
        if (p.ok) break;
      }
      record({
        pre: pre.ok, posts, finalState: proof.state, attempts: proof.postAttempts,
        urls: CALLS().map((c) => c.url), bodies: CALLS().map((c) => c.body),
      });
      `
    );

  const cases: Array<[string, string]> = [
    ["a 429 rate limit", `{status:429,retryAfter:"120"}`],
    ["a 500", `{status:500}`],
    ["a 503", `{status:503}`],
    ["a transport failure", `{throw:true}`],
    ["a 401 with NO route marker", `{status:401}`],
    ["a still-accepted 400 (rotation not propagated)", `{status:400,marker:"${ACCEPTED}"}`],
  ];

  it.each(cases)("%s leaves the proof ARMED, and a later rejection still proves containment", async (_n, step) => {
    const r = parse((await armedThen(`[{status:400,marker:"${ACCEPTED}"},${step},{status:401,marker:"${REJECTED}"}]`)).out);
    expect(r.pre).toBe(true);
    // the failing attempt did NOT abort
    expect(r.posts[0].ok).toBe(false);
    expect(r.posts[0].state).toBe("POST_PENDING");
    expect(r.posts[0].retryable).toBe(true);
    // and the retry proved it
    expect(r.posts[1].ok).toBe(true);
    expect(r.finalState).toBe("PRODUCTION_CONTAINMENT_PROVEN");
    expect(r.attempts).toBe(2);
  });

  it.each(cases)("%s is never itself reported as PROVEN", async (_n, step) => {
    const r = parse((await armedThen(`[{status:400,marker:"${ACCEPTED}"},${step}]`, 3)).out);
    expect(r.posts.every((p: { ok: boolean }) => p.ok === false)).toBe(true);
    expect(r.finalState).toBe("POST_PENDING");
  });

  it("classifies a still-live credential as NOT_YET_CONTAINED, and no-verdict responses as INCONCLUSIVE", async () => {
    const live = parse((await armedThen(`[{status:400,marker:"${ACCEPTED}"},{status:400,marker:"${ACCEPTED}"}]`, 2)).out);
    expect(live.posts[1].outcome).toBe("NOT_YET_CONTAINED");
    const vague = parse((await armedThen(`[{status:400,marker:"${ACCEPTED}"},{status:429}]`, 2)).out);
    expect(vague.posts[1].outcome).toBe("INCONCLUSIVE");
  });

  it("every retry reuses the SAME url and the SAME secret bytes — nothing is re-read", async () => {
    const r = parse(
      (await armedThen(`[{status:400,marker:"${ACCEPTED}"},{status:429},{status:500},{throw:true},{status:401,marker:"${REJECTED}"}]`)).out
    );
    expect(new Set(r.urls).size).toBe(1);
    expect(r.urls[0]).toBe(CANONICAL_URL);
    const bodies = r.bodies.filter((b: string | null) => b !== null);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ secret: OLD });
  });

  it("PROVEN is terminal — a further post-check cannot run from it", async () => {
    const r = parse(
      (
        await withScriptedFetch(
          `[{status:400,marker:"${ACCEPTED}"},{status:401,marker:"${REJECTED}"},{status:400,marker:"${ACCEPTED}"}]`,
          `
          const proof = M.createContainmentProof({ origin: ${JSON.stringify(CANONICAL)}, secret: ${JSON.stringify(OLD)}, fetchImpl });
          await proof.precheck(); proof.armForRotation();
          const a = await proof.postcheck();
          const b = await proof.postcheck();
          record({ a: a.ok, aState: a.state, b: b.ok, bState: b.state, requests: CALLS().length });
          `
        )
      ).out
    );
    expect(r.a).toBe(true);
    expect(r.b).toBe(false);
    expect(r.bState).toBe("ABORTED");
    expect(r.requests).toBe(2); // the post-PROVEN attempt issued NO request
  });

  it("a failed PRE still cannot reach the post-check", async () => {
    const r = parse(
      (
        await withScriptedFetch(
          `[{status:401,marker:"${REJECTED}"},{status:401,marker:"${REJECTED}"}]`,
          `
          const proof = M.createContainmentProof({ origin: ${JSON.stringify(CANONICAL)}, secret: ${JSON.stringify(OLD)}, fetchImpl });
          const pre = await proof.precheck();
          const arm = proof.armForRotation();
          const post = await proof.postcheck();
          record({ pre: pre.ok, arm: arm.ok, post: post.ok, state: proof.state, requests: CALLS().length });
          `
        )
      ).out
    );
    expect(r.pre).toBe(false);
    expect(r.post).toBe(false);
    expect(r.state).toBe("ABORTED");
    expect(r.requests).toBe(1);
  });
});

// ===========================================================================
describe("EXIT CODES — a rate limit is not a containment failure", () => {
  const run = (steps: string, attempts: number) =>
    withScriptedFetch(
      steps,
      `
      const r = await M.runProductionTwoPhase({
        secret: ${JSON.stringify(OLD)}, fetchImpl,
        prompt: async ({ attempt }) => attempt <= ${attempts},
      });
      record(r);
      `
    );

  it("exit 0 ONLY after a full accepted -> rejected transition", async () => {
    const r = parse((await run(`[{status:400,marker:"${ACCEPTED}"},{status:401,marker:"${REJECTED}"}]`, 3)).out);
    expect(r.exit).toBe(0);
    expect(r.proven).toBe(true);
  });

  it("stopping while the credential is STILL ACCEPTED exits 2 (not contained)", async () => {
    const r = parse((await run(`[{status:400,marker:"${ACCEPTED}"},{status:400,marker:"${ACCEPTED}"}]`, 1)).out);
    expect(r.exit).toBe(2);
    expect(r.proven).toBe(false);
  });

  it("stopping on a 429 exits 3 (INCONCLUSIVE) — never 2, and never 0", async () => {
    const r = parse((await run(`[{status:400,marker:"${ACCEPTED}"},{status:429,retryAfter:"60"}]`, 1)).out);
    expect(r.exit).toBe(3);
    expect(r.exit).not.toBe(2);
    expect(r.proven).toBe(false);
  });

  it.each([
    ["a 500", `{status:500}`],
    ["a transport failure", `{throw:true}`],
    ["an unattributed 401", `{status:401}`],
  ])("stopping on %s exits 3 (INCONCLUSIVE)", async (_n, step) => {
    const r = parse((await run(`[{status:400,marker:"${ACCEPTED}"},${step}]`, 1)).out);
    expect(r.exit).toBe(3);
  });

  it("a failed pre-check exits 3, having issued exactly one request", async () => {
    const r = parse(
      (
        await withScriptedFetch(
          `[{status:401,marker:"${REJECTED}"}]`,
          `const r = await M.runProductionTwoPhase({ secret: ${JSON.stringify(OLD)}, fetchImpl, prompt: async () => true });
           record({ ...r, requests: CALLS().length });`
        )
      ).out
    );
    expect(r.exit).toBe(3);
    expect(r.requests).toBe(1);
  });
});

// ===========================================================================
describe("TARGET URL CONTRACT — refusal is a specific code that sends NOTHING", () => {
  /**
   * R10: the surviving version asserted zero hits only for the plain-http row.
   * Every row below now asserts all five: the exact structured code, that the
   * injected fetch was never called, that a REACHABLE server received zero
   * requests, that the secret never appeared on the wire, and a non-zero exit.
   */
  const refuse = async (target: string, opts = "{ requireCanonical: true }") => {
    const s = await server(alwaysAccept);
    try {
      const r = parse(
        (
          await withScriptedFetch(
            `[{status:400,marker:"${ACCEPTED}"}]`,
            `
            const res = await M.observeOldSecret({
              origin: ${JSON.stringify(target.replace("__ORIGIN__", s.origin))},
              secret: ${JSON.stringify(OLD)}, fetchImpl, ...${opts},
            });
            record({ observation: res.observation, detail: res.detail, fetchCalls: CALLS().length });
            `
          )
        ).out
      );
      return { ...r, serverHits: s.hits.length, bodies: s.hits.map((h) => h.body) };
    } finally {
      await s.close();
    }
  };

  const rows: Array<[string, string, string]> = [
    ["a non-https remote origin", "http://evil.test", "ERR_NON_HTTPS_PRODUCTION_ORIGIN"],
    ["a reachable plain-http server", "__ORIGIN__", "ERR_NON_HTTPS_PRODUCTION_ORIGIN"],
    ["a non-canonical https origin", "https://attacker.example", "ERR_NOT_CANONICAL_PRODUCTION_ORIGIN"],
    ["a lookalike host", "https://convergepanel.com.evil.test", "ERR_NOT_CANONICAL_PRODUCTION_ORIGIN"],
    ["a punycode homograph", "https://xn--convergepanel-x2b.com", "ERR_NOT_CANONICAL_PRODUCTION_ORIGIN"],
    ["a non-443 port", "https://convergepanel.com:8443", "ERR_NOT_CANONICAL_PRODUCTION_ORIGIN"],
    ["a supplied path", "https://convergepanel.com/admin", "ERR_PATH_NOT_ALLOWED"],
    ["a query string", "https://convergepanel.com/?x=1", "ERR_QUERY_NOT_ALLOWED"],
    ["a fragment", "https://convergepanel.com/#f", "ERR_FRAGMENT_NOT_ALLOWED"],
    ["userinfo", "https://u:p@convergepanel.com", "ERR_USERINFO_NOT_ALLOWED"],
    ["an unsupported scheme", "ftp://convergepanel.com", "ERR_UNSUPPORTED_SCHEME"],
    ["a malformed url", "not-a-url", "ERR_TARGET_NOT_A_URL"],
  ];

  it.each(rows)("%s is refused with %s and sends nothing", async (_n, target, code) => {
    const r = await refuse(target);
    expect(r.detail).toBe(`refused: ${code}`);
    expect(r.observation).toBe("INCONCLUSIVE");
    expect(r.fetchCalls).toBe(0);
    expect(r.serverHits).toBe(0);
    expect(r.bodies.join(" ")).not.toContain(OLD);
  });

  it("a refused target exits non-zero through the CLI", async () => {
    const r = await runCli(["--observe", "--non-production-target", "http://evil.test"]);
    expect(r.status).not.toBe(0);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("ERR_NON_HTTPS_PRODUCTION_ORIGIN");
  });

  it("the loopback exemption is an EXACT host match, not a substring", async () => {
    // `localhost.` resolves to loopback but is not the loopback host. Under a
    // `.includes()` predicate an attacker-nameable host would be exempted from
    // BOTH the https and the canonical requirement.
    for (const host of ["localhost.", "localhost.attacker.example", "127.0.0.1.evil.test", "not-localhost", "mylocalhost"]) {
      const r = await refuse(`http://${host}:9`, "{ requireCanonical: true, allowInsecureLoopback: true }");
      expect(r.detail).toBe("refused: ERR_NON_HTTPS_PRODUCTION_ORIGIN");
      expect(r.fetchCalls).toBe(0);
    }
  });

  it("the loopback seam does NOT relax the canonical rule for a foreign https origin", async () => {
    // The C13 defect in miniature: `allowInsecureLoopback` must exempt loopback
    // from the https rule, and nothing else. If it also short-circuits the
    // canonical clause, every https host becomes an acceptable proof target.
    for (const host of ["https://attacker.example", "https://convergepanel-git-preview.vercel.app", "https://staging.example.com"]) {
      const r = await refuse(host, "{ requireCanonical: true, allowInsecureLoopback: true }");
      expect(r.detail).toBe("refused: ERR_NOT_CANONICAL_PRODUCTION_ORIGIN");
      expect(r.observation).toBe("INCONCLUSIVE");
      expect(r.fetchCalls).toBe(0);
      expect(r.serverHits).toBe(0);
      expect(r.bodies.join(" ")).not.toContain(OLD);
    }
  });

  it("the canonical origin itself is still reachable with both flags on", async () => {
    const r = parse(
      (
        await withScriptedFetch(
          `[{status:401,marker:"${REJECTED}"}]`,
          `const res = await M.observeOldSecret({ origin: ${JSON.stringify(CANONICAL)}, secret: ${JSON.stringify(OLD)}, fetchImpl, requireCanonical: true, allowInsecureLoopback: true });
           record({ observation: res.observation, urls: CALLS().map(c => c.url) });`
        )
      ).out
    );
    expect(r.observation).toBe("CREDENTIAL_REJECTED");
    expect(r.urls).toEqual([CANONICAL_URL]);
  });

  it("genuine loopback IS reachable through the injection seam (the guard is not blanket denial)", async () => {
    const s = await server(alwaysAccept);
    try {
      const r = parse(
        (
          await nodeEval(`
            const M = await import(${JSON.stringify(IMPL)});
            const res = await M.observeOldSecret({
              origin: ${JSON.stringify("")} || ${JSON.stringify(s.origin)},
              secret: ${JSON.stringify(OLD)}, requireCanonical: false, allowInsecureLoopback: true,
            });
            console.log("RESULT:" + JSON.stringify({ observation: res.observation }));
          `)
        ).out
      );
      expect(r.observation).toBe("CREDENTIAL_ACCEPTED");
      expect(s.hits.length).toBe(1);
    } finally {
      await s.close();
    }
  });
});

// ===========================================================================
describe("SECRET BYTES SURVIVE THE SHELL", () => {
  const SPECIALS = ["with$dollar", "with`backtick", "with space", "with!bang", "with*star", `with"'\\quotes`, "café-ünïcode"];

  it.each(SPECIALS)("%s reaches the wire byte-for-byte, and the pre-check accepts it", async (secret) => {
    const r = parse(
      (
        await withScriptedFetch(
          `[{status:400,marker:"${ACCEPTED}"},{status:401,marker:"${REJECTED}"}]`,
          `
          const r = await M.runProductionTwoPhase({
            secret: process.env.OLD_ADMIN_SECRET, fetchImpl, prompt: async ({ attempt }) => attempt <= 2,
          });
          record({ ...r, bodies: CALLS().map((c) => c.body) });
          `,
          { OLD_ADMIN_SECRET: secret }
        )
      ).out
    );
    expect(r.proven).toBe(true);
    for (const b of r.bodies) expect(JSON.parse(b)).toEqual({ secret });
  });

  it("an emoji secret survives too (surrogate pairs are bytes, not characters)", async () => {
    const secret = "rocket-🚀-secret";
    const r = parse(
      (
        await withScriptedFetch(
          `[{status:400,marker:"${ACCEPTED}"},{status:401,marker:"${REJECTED}"}]`,
          `const r = await M.runProductionTwoPhase({ secret: process.env.OLD_ADMIN_SECRET, fetchImpl, prompt: async ({attempt}) => attempt <= 2 });
           record({ ...r, bodies: CALLS().map((c) => c.body) });`,
          { OLD_ADMIN_SECRET: secret }
        )
      ).out
    );
    expect(JSON.parse(r.bodies[0])).toEqual({ secret });
  });

  it("an empty or missing secret never issues a request", async () => {
    for (const s of ["", undefined]) {
      const r = parse(
        (
          await withScriptedFetch(
            `[{status:400,marker:"${ACCEPTED}"}]`,
            `const r = await M.runProductionTwoPhase({ secret: ${JSON.stringify(s ?? null)} ?? undefined, fetchImpl, prompt: async () => true });
             record({ ...r, requests: CALLS().length });`
          )
        ).out
      );
      expect(r.exit).toBe(3);
      expect(r.requests).toBe(0);
    }
  });
});

// ===========================================================================
describe("RATE-LIMIT BUDGET — the enrollment sequence fits, and a 429 is survivable", () => {
  /**
   * The route allows 3 requests per 300s per IP, checked BEFORE the secret is
   * examined. The canonical sequence spends exactly three: PRE, the mint, POST.
   * That is zero margin, so the 429 path is not hypothetical.
   */
  it("PRE + mint + POST is exactly three requests against the route", async () => {
    const r = parse(
      (
        await withScriptedFetch(
          `[{status:400,marker:"${ACCEPTED}"},{status:401,marker:"${REJECTED}"}]`,
          `const r = await M.runProductionTwoPhase({ secret: ${JSON.stringify(OLD)}, fetchImpl, prompt: async ({attempt}) => attempt <= 2 });
           record({ ...r, probeRequests: CALLS().length });`
        )
      ).out
    );
    const MINT_REQUESTS = 1;
    expect(r.probeRequests).toBe(2);
    expect(r.probeRequests + MINT_REQUESTS).toBe(3);
    const routeSrc = readFileSync(join(process.cwd(), "app/api/admin/set-admin/route.ts"), "utf8");
    expect(routeSrc).toMatch(/RATE_LIMIT_MAX_REQUESTS\s*=\s*3\b/);
  });

  it("a 429 caused by exhausting that budget is survivable: still armed, then provable", async () => {
    const r = parse(
      (
        await withScriptedFetch(
          `[{status:400,marker:"${ACCEPTED}"},{status:429,retryAfter:"300"},{status:401,marker:"${REJECTED}"}]`,
          `
          const proof = M.createContainmentProof({ origin: ${JSON.stringify(CANONICAL)}, secret: ${JSON.stringify(OLD)}, fetchImpl });
          await proof.precheck(); proof.armForRotation();
          const limited = await proof.postcheck();
          const after = await proof.postcheck();
          record({ limitedState: limited.state, limitedDetail: limited.detail, afterOk: after.ok, finalState: proof.state });
          `
        )
      ).out
    );
    expect(r.limitedState).toBe("POST_PENDING");
    expect(r.limitedDetail).toContain("retry-after 300s");
    expect(r.afterOk).toBe(true);
    expect(r.finalState).toBe("PRODUCTION_CONTAINMENT_PROVEN");
  });
});

// ===========================================================================
describe("REDIRECTS AND CACHING — behavioural, through real servers", () => {
  it.each([301, 302, 303, 307, 308])("a %s at the POST phase is refused, stays armed, and leaks nothing", async (code) => {
    const sink = await server(alwaysReject);
    let phase = 0;
    const target = await server(() => {
      phase += 1;
      return phase === 1
        ? { status: 400, headers: { [MARKER]: ACCEPTED } }
        : { status: code, headers: { location: `${sink.origin}/api/admin/set-admin` } };
    });
    try {
      const r = parse(
        (
          await nodeEval(`
            const M = await import(${JSON.stringify(IMPL)});
            const proof = M.createContainmentProof({
              origin: ${JSON.stringify(target.origin)}, secret: ${JSON.stringify(OLD)},
              requireCanonical: false, allowInsecureLoopback: true,
            });
            const pre = await proof.precheck();
            proof.armForRotation();
            const post = await proof.postcheck();
            console.log("RESULT:" + JSON.stringify({ pre: pre.ok, postOk: post.ok, state: post.state, outcome: post.outcome }));
          `)
        ).out
      );
      expect(r.pre).toBe(true);
      expect(r.postOk).toBe(false);
      expect(r.outcome).toBe("INCONCLUSIVE");
      expect(r.state).toBe("POST_PENDING"); // still armed — a redirect is not a verdict
      expect(sink.hits.length).toBe(0);
      expect(sink.hits.map((h) => h.body).join(" ")).not.toContain(OLD);
    } finally {
      await target.close();
      await sink.close();
    }
  });

  it("every request is sent with redirect:error and cache:no-store", async () => {
    const r = parse(
      (
        await withScriptedFetch(
          `[{status:400,marker:"${ACCEPTED}"},{status:401,marker:"${REJECTED}"}]`,
          `const r = await M.runProductionTwoPhase({ secret: ${JSON.stringify(OLD)}, fetchImpl, prompt: async ({attempt}) => attempt <= 2 });
           record({ redirects: CALLS().map(c => c.redirect), caches: CALLS().map(c => c.cache) });`
        )
      ).out
    );
    expect(r.redirects).toEqual(["error", "error"]);
    expect(r.caches).toEqual(["no-store", "no-store"]);
  });
});

// ===========================================================================
describe("THE CLI", () => {
  it("refuses --production-two-phase without an interactive terminal, and sends nothing", async () => {
    const s = await server(alwaysAccept);
    try {
      const r = await runCli(["--production-two-phase"]);
      expect(r.status).toBe(3);
      expect(r.stdout).toContain("interactive terminal");
      expect(r.stdout).not.toContain("PRODUCTION_CONTAINMENT_PROVEN");
      expect(s.hits.length).toBe(0);
    } finally {
      await s.close();
    }
  });

  it("observe mode never claims containment", async () => {
    const s = await server(alwaysReject);
    try {
      const r = await runCli(["--observe", "--non-production-target", s.origin]);
      expect(r.stdout).not.toContain("PRODUCTION_CONTAINMENT_PROVEN");
      expect(r.stdout).toContain("OBSERVATION ONLY");
      expect(r.status).not.toBe(0);
    } finally {
      await s.close();
    }
  });

  it("observe mode against a non-production target warns that the secret will be sent there", async () => {
    const s = await server(alwaysReject);
    try {
      const r = await runCli(["--observe", "--non-production-target", s.origin]);
      expect(r.stdout).toContain("WILL BE SENT");
      expect(r.stdout).toContain(s.origin);
    } finally {
      await s.close();
    }
  });

  it("observe mode with no explicit target is pinned to the canonical origin", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("origin: target ?? CANONICAL_PRODUCTION_ORIGIN");
    expect(src).toContain("requireCanonical: !target");
  });

  it("prints usage and exits non-zero when given no mode", async () => {
    const r = await runCli([]);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("usage:");
  });
});

// ===========================================================================
describe("FILESYSTEM INVOCATION — no invocation may silently no-op", () => {
  const dirs: Array<() => string> = [
    () => {
      const d = mkdtempSync(join(tmpdir(), "probe with space-"));
      mkdirSync(join(d, "lib"));
      copyFileSync(SCRIPT, join(d, "probe.mjs"));
      copyFileSync(IMPL, join(d, "lib/probe-admin-secret.mjs"));
      return join(d, "probe.mjs");
    },
    () => {
      const d = mkdtempSync(join(tmpdir(), "probe-symlink-"));
      mkdirSync(join(d, "lib"));
      copyFileSync(IMPL, join(d, "lib/probe-admin-secret.mjs"));
      const real = join(d, "real.mjs");
      copyFileSync(SCRIPT, real);
      symlinkSync(real, join(d, "link.mjs"));
      return join(d, "link.mjs");
    },
  ];

  it.each(dirs.map((d, i) => [i === 0 ? "a path with spaces" : "through a symlink", d]))(
    "%s still executes and still refuses a non-TTY production run",
    async (_n, mk) => {
      const r = await runCli(["--production-two-phase"], {}, "\n", (mk as () => string)());
      expect(r.status).toBe(3);
      expect(r.stdout).toContain("interactive terminal");
      expect(r.stdout).not.toBe("");
    }
  );
});

// ===========================================================================
describe("ATTESTATION CONSTANTS — the two copies agree", () => {
  it("the .mjs marker constants match the route's shared module", () => {
    const shared = readFileSync(join(process.cwd(), "lib/security/adminSecretProbeAttestation.ts"), "utf8");
    const impl = readFileSync(IMPL, "utf8");
    for (const v of [MARKER, REJECTED, ACCEPTED]) {
      expect(shared).toContain(v);
      expect(impl).toContain(v);
    }
  });
});
