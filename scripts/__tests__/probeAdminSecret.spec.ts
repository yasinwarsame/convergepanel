/**
 * Phase FIRST-ADMIN-C12 — the canonical containment probe, tested as the real
 * CLI against real servers.
 *
 * C11's version had three independent ways to report "containment proven"
 * while proving nothing, all found by review: a silent no-op on paths needing
 * percent-encoding or traversing a symlink; a 307 that forwarded the live
 * secret to another origin whose 401 was then accepted as proof; and a verdict
 * derived from a bare status, so any WAF/SSO/preview-gate 401 counted.
 *
 * Every assertion below is on real wire bytes and real exit codes.
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

type Hit = { url?: string; method?: string; body: string; headers: Record<string, string | string[] | undefined> };

/** A server that records every request and answers with a fixed response. */
async function server(handler: (hits: Hit[]) => { status: number; headers?: Record<string, string> }) {
  const hits: Hit[] = [];
  const s: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url, method: req.method, body, headers: req.headers });
      const { status, headers } = handler(hits);
      res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  return { hits, origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => s.close(() => r())) };
}

type Ran = { status: number | null; stdout: string; stderr: string };
/** MUST be async: spawnSync blocks the event loop and would deadlock the server. */
function run(script: string, args: string[], env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const c = spawn("node", [script, ...args], {
      env: { ...process.env, OLD_ADMIN_SECRET: OLD, PROBE_ALLOW_INSECURE_LOOPBACK: "1", ...env },
    });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const ok = (extra?: Record<string, string>) => () => ({ status: 401, headers: { [MARKER]: REJECTED, ...extra } });

describe("ANCHOR — the harness observes real requests", () => {
  it("a probe run reaches the server exactly once, at the right path", async () => {
    const s = await server(ok());
    try {
      const r = await run(SCRIPT, [s.origin]);
      expect(r.status).toBe(0);
      expect(s.hits).toHaveLength(1);
      expect(s.hits[0].method).toBe("POST");
      expect(s.hits[0].url).toBe("/api/admin/set-admin");
    } finally { await s.close(); }
  });
});

describe("FILESYSTEM INVOCATION MATRIX — no invocation may silently no-op", () => {
  /**
   * C11 exited 0 with no output and no request from a path containing a space
   * or reached through a symlink, because its entry guard compared
   * `import.meta.url` to a raw `process.argv[1]`. There is no entry guard now.
   */
  const staged = (() => {
    const root = mkdtempSync(join(tmpdir(), "probe-fs-"));
    const spaced = join(root, "dir with spaces");
    mkdirSync(join(spaced, "lib"), { recursive: true });
    copyFileSync(SCRIPT, join(spaced, "probe-admin-secret.mjs"));
    copyFileSync(IMPL, join(spaced, "lib/probe-admin-secret.mjs"));
    const link = join(root, "link");
    try { symlinkSync(spaced, link); } catch { /* platform without symlinks */ }
    return { spaced, link };
  })();

  it.each([
    ["absolute path", () => SCRIPT],
    ["path containing spaces", () => join(staged.spaced, "probe-admin-secret.mjs")],
    ["through a symlinked directory", () => join(staged.link, "probe-admin-secret.mjs")],
  ])("%s: issues exactly one request and reports a verdict", async (_label, path) => {
    const s = await server(ok());
    try {
      const r = await run(path(), [s.origin]);
      expect(s.hits).toHaveLength(1);          // it actually ran
      expect(r.stdout.trim()).not.toBe("");    // it actually said something
      expect(r.status).toBe(0);                // and the verdict is the real one
    } finally { await s.close(); }
  });

  it("a run that issues NO request can never exit 0", async () => {
    // The failure mode C11 had: exit 0 with nothing sent.
    const r = await run(SCRIPT, ["https://127.0.0.1:1"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/INCONCLUSIVE/);
  });
});

describe("FALSE-PROOF MATRIX — only an attested 401 is proof", () => {
  it("intended app, 401 + rejected marker -> exit 0, PROVEN", async () => {
    const s = await server(ok());
    try { expect((await run(SCRIPT, [s.origin])).status).toBe(0); } finally { await s.close(); }
  });

  it("intended app, 400 + accepted marker -> non-zero, CONTAINMENT FAILED", async () => {
    const s = await server(() => ({ status: 400, headers: { [MARKER]: ACCEPTED } }));
    try {
      const r = await run(SCRIPT, [s.origin]);
      expect(r.status).toBe(2);
      expect(r.stdout).toMatch(/CONTAINMENT FAILED/);
    } finally { await s.close(); }
  });

  it("generic 401 with NO marker -> non-zero, and says why", async () => {
    // A WAF, an SSO gate, a preview-deployment wall, a typo'd host.
    const s = await server(() => ({ status: 401 }));
    try {
      const r = await run(SCRIPT, [s.origin]);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toMatch(/no application attestation/);
    } finally { await s.close(); }
  });

  it("401 with the WRONG marker value -> non-zero", async () => {
    const s = await server(() => ({ status: 401, headers: { [MARKER]: "something-else" } }));
    try { expect((await run(SCRIPT, [s.origin])).status).not.toBe(0); } finally { await s.close(); }
  });

  it("400 carrying the REJECTED marker -> non-zero (mismatched pair)", async () => {
    const s = await server(() => ({ status: 400, headers: { [MARKER]: REJECTED } }));
    try { expect((await run(SCRIPT, [s.origin])).status).not.toBe(0); } finally { await s.close(); }
  });

  it.each([[429], [500], [503], [200], [204]])("HTTP %i -> non-zero", async (status) => {
    const s = await server(() => ({ status: status as number, headers: { [MARKER]: REJECTED } }));
    try { expect((await run(SCRIPT, [s.origin])).status).not.toBe(0); } finally { await s.close(); }
  });

  it("network failure -> non-zero", async () => {
    const r = await run(SCRIPT, ["https://127.0.0.1:1"]);
    expect(r.status).not.toBe(0);
  });

  it("missing OLD_ADMIN_SECRET -> non-zero and sends nothing", async () => {
    const s = await server(ok());
    try {
      const r = await run(SCRIPT, [s.origin], { OLD_ADMIN_SECRET: "" });
      expect(r.status).not.toBe(0);
      expect(s.hits).toHaveLength(0);
    } finally { await s.close(); }
  });

  it("missing origin -> non-zero with usage", async () => {
    const r = await run(SCRIPT, []);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/usage/i);
  });
});

describe("REDIRECTS — a redirect is a refusal, never a result", () => {
  /**
   * C11 followed redirects by default. 307/308 preserve the POST body, so the
   * live credential was delivered to an origin the operator never named — and
   * that origin's 401 was then reported as "containment proven".
   */
  it.each([[307], [308], [301], [302], [303]])(
    "HTTP %i: target receives NOTHING and the probe exits non-zero",
    async (code) => {
      const target = await server(ok());
      const redirector = await server(() => ({
        status: code as number,
        headers: { location: `${target.origin}/api/admin/set-admin` },
      }));
      try {
        const r = await run(SCRIPT, [redirector.origin]);
        expect(target.hits).toHaveLength(0);                 // the secret never left
        expect(r.status).not.toBe(0);                        // and it is not proof
        expect(r.stdout).toMatch(/INCONCLUSIVE/);
      } finally { await redirector.close(); await target.close(); }
    }
  );

  it("a redirect cannot carry the secret to another origin", async () => {
    const target = await server(ok());
    const redirector = await server(() => ({
      status: 307,
      headers: { location: `${target.origin}/api/admin/set-admin` },
    }));
    try {
      await run(SCRIPT, [redirector.origin]);
      expect(JSON.stringify(target.hits)).not.toContain(OLD);
    } finally { await redirector.close(); await target.close(); }
  });
});

describe("TARGET URL CONTRACT — the operator names an origin, nothing else", () => {
  it.each([
    ["a query string", "https://example.test/?q=1"],
    ["a path", "https://example.test/some/path"],
    ["a fragment", "https://example.test/#frag"],
    ["embedded credentials", "https://user:pw@example.test"],
    ["a non-http scheme", "file:///etc/passwd"],
    ["plain http to a non-loopback host", "http://example.test"],
    ["nonsense", "not-a-url"],
  ])("refuses %s without sending anything", async (_label, url) => {
    const r = await run(SCRIPT, [url], { PROBE_ALLOW_INSECURE_LOOPBACK: "0" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/refused|INCONCLUSIVE/);
    expect(r.stdout).not.toContain(OLD);
  });

  it("accepts a bare https origin", async () => {
    // Reaches the network layer (and fails there), rather than being refused.
    const r = await run(SCRIPT, ["https://example.invalid"], { PROBE_ALLOW_INSECURE_LOOPBACK: "0" });
    expect(r.stdout).toMatch(/request failed/);
  });
});

describe("REQUEST SHAPE — one key, no claim target, no secret outside the body", () => {
  it("body key set is exactly [secret]", async () => {
    const s = await server(ok());
    try {
      await run(SCRIPT, [s.origin]);
      expect(Object.keys(JSON.parse(s.hits[0].body))).toEqual(["secret"]);
    } finally { await s.close(); }
  });

  it("no claim target appears anywhere in the request", async () => {
    const s = await server(ok());
    try {
      await run(SCRIPT, [s.origin], { UID: "victim", TARGET_UID: "victim", EMAIL: "v@x.test" });
      const wire = `${s.hits[0].url} ${s.hits[0].body} ${JSON.stringify(s.hits[0].headers)}`.toLowerCase();
      for (const f of ["uid", "userid", "targetuid", "email", "claim", "role"]) expect(wire).not.toContain(f);
    } finally { await s.close(); }
  });

  it("the secret appears in the body and NOWHERE else", async () => {
    const s = await server(ok());
    try {
      await run(SCRIPT, [s.origin]);
      const h = s.hits[0];
      expect(h.body).toContain(OLD);
      expect(JSON.stringify(h.headers)).not.toContain(OLD);   // not in any header
      expect(h.url).not.toContain(OLD);                       // not in the URL
    } finally { await s.close(); }
  });

  it("buildProbeBody has no second parameter that could become a claim target", () => {
    /**
     * The behavioural one-key property is proven on the wire above. This pins
     * the SHAPE: a mutation adding a `uid` parameter left the wire unchanged
     * (one argument passed, `undefined` dropped by JSON.stringify) while giving
     * the tool the ability to carry a claim target. Source check, labelled as
     * one, on the ~40-line file that is the security boundary.
     */
    const src = readFileSync(IMPL, "utf8");
    const sig = src.match(/export function buildProbeBody\(([^)]*)\)/)![1];
    expect(sig.split(",").filter((x) => x.trim()).length).toBe(1);
    expect(sig).not.toMatch(/uid/i);
    // And no claim-target identifier exists anywhere in the executable source.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\buid\b/i);
  });
});

describe("SECRET NON-DISCLOSURE across every outcome", () => {
  it.each([
    ["attested 401", 401, REJECTED],
    ["attested 400", 400, ACCEPTED],
    ["unattested 401", 401, undefined],
    ["429", 429, undefined],
    ["500", 500, undefined],
  ])("%s: output never contains the secret", async (_l, status, marker) => {
    const s = await server(() => ({ status: status as number, headers: marker ? { [MARKER]: marker as string } : {} }));
    try {
      const r = await run(SCRIPT, [s.origin]);
      expect(r.stdout + r.stderr).not.toContain(OLD);
    } finally { await s.close(); }
  });

  it("a redirect refusal never contains the secret", async () => {
    const t = await server(ok());
    const rd = await server(() => ({ status: 307, headers: { location: `${t.origin}/api/admin/set-admin` } }));
    try {
      const r = await run(SCRIPT, [rd.origin]);
      expect(r.stdout + r.stderr).not.toContain(OLD);
    } finally { await rd.close(); await t.close(); }
  });

  it("a network error never contains the secret", async () => {
    const r = await run(SCRIPT, ["https://127.0.0.1:1"]);
    expect(r.stdout + r.stderr).not.toContain(OLD);
  });
});

describe("ATTESTATION CONTRACT — the two copies of the constants agree", () => {
  /**
   * The route imports TS constants; the probe is plain ESM run by node outside
   * the Next build and duplicates them. A drift would make every real probe
   * INCONCLUSIVE, which fails safe — but it would also make the tool useless
   * exactly when it is needed.
   */
  it("header name and both marker values match the route's module", () => {
    const ts = readFileSync("lib/security/adminSecretProbeAttestation.ts", "utf8");
    const mjs = readFileSync("scripts/lib/probe-admin-secret.mjs", "utf8");
    for (const literal of [`"${MARKER}"`, `"${REJECTED}"`, `"${ACCEPTED}"`]) {
      expect({ literal, inTs: ts.includes(literal), inMjs: mjs.includes(literal) })
        .toEqual({ literal, inTs: true, inMjs: true });
    }
  });
});
