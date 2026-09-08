/**
 * Phase FIRST-ADMIN-C11 — the safe probe is tested as CODE, not as prose.
 *
 * Driven as the real CLI against a real local HTTP server, so the exit codes
 * and the bytes on the wire are the actual ones an operator would produce.
 * Every prior attempt to keep operators safe here was a regex over English,
 * and three review rounds put a uid-bearing "verification" back into the docs
 * regardless. This asserts on the request the tool physically sends.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/probe-admin-secret.mjs");
const OLD = "old-bootstrap-secret-aaaaaaaaaaaaaaaaaaaa";
const UID = "victim-uid-000000000001";

type Captured = { url?: string; method?: string; body?: string };

/**
 * Starts a server that answers with `status` and records the request.
 *
 * The child MUST be spawned asynchronously: `spawnSync` blocks Node's event
 * loop, so this in-process server would never accept the connection and the
 * test would deadlock rather than fail.
 */
async function withServer(status: number, fn: (base: string, captured: Captured) => Promise<void>) {
  const captured: Captured = {};
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.url = req.url;
      captured.method = req.method;
      captured.body = body;
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, captured);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

type Ran = { status: number | null; stdout: string; stderr: string };

function runAsync(args: string[], env: Record<string, string>): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn("node", args, { env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const run = (base: string, env: Record<string, string> = {}) =>
  runAsync([SCRIPT, base], { OLD_ADMIN_SECRET: OLD, ...env });

describe("the probe's request cannot carry a claim target", () => {
  it("ANCHOR: the CLI really reaches the bootstrap route", async () => {
    await withServer(401, async (base, cap) => {
      const r = await run(base);
      expect(r.error).toBeUndefined();
      expect(cap.method).toBe("POST");
      expect(cap.url).toBe("/api/admin/set-admin");
    });
  });

  it("the body contains the secret and NOTHING else", async () => {
    await withServer(401, async (base, cap) => {
      await run(base);
      const body = JSON.parse(cap.body!);
      // Exact key set — not "does not contain uid", which would miss userId,
      // targetUid, email and every other claim target.
      expect(Object.keys(body)).toEqual(["secret"]);
      expect(body.secret).toBe(OLD);
    });
  });

  it("no claim target appears anywhere in the outgoing request", async () => {
    await withServer(400, async (base, cap) => {
      await run(base, { UID, TARGET_UID: UID });
      const wire = `${cap.url} ${cap.body}`.toLowerCase();
      for (const forbidden of ["uid", "userid", "targetuid", "email", "claim"]) {
        expect(wire).not.toContain(forbidden);
      }
    });
  });
});

describe("verdict semantics — only 401 is proof", () => {
  it.each([
    [401, 0, /CREDENTIAL_REJECTED/],
    [400, 2, /CREDENTIAL_ACCEPTED/],
    [429, 3, /INCONCLUSIVE/],
    [500, 3, /INCONCLUSIVE/],
    [503, 3, /INCONCLUSIVE/],
    [200, 3, /INCONCLUSIVE/],
  ])("HTTP %i exits %i", async (status, exit, pattern) => {
    await withServer(status as number, async (base) => {
      const r = await run(base);
      expect(r.status).toBe(exit);
      expect(r.stdout).toMatch(pattern as RegExp);
    });
  });

  it("400 states plainly that containment FAILED", async () => {
    await withServer(400, async (base) => {
      expect((await run(base)).stdout).toMatch(/CONTAINMENT FAILED/);
    });
  });

  it("a network failure is INCONCLUSIVE, never proof", async () => {
    // Nothing listening on this port.
    const r = await run("http://127.0.0.1:1");
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/INCONCLUSIVE/);
  });

  it("a missing OLD_ADMIN_SECRET is INCONCLUSIVE and sends nothing", async () => {
    await withServer(401, async (base, cap) => {
      const r = await runAsync([SCRIPT, base], { OLD_ADMIN_SECRET: "" });
      expect(r.status).not.toBe(0);
      expect(cap.body).toBeUndefined();
    });
  });

  it("a missing base URL exits non-zero without contacting anything", async () => {
    const r = await runAsync([SCRIPT], { OLD_ADMIN_SECRET: OLD });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage/i);
  });
});

describe("the secret is never disclosed by the tool's output", () => {
  it.each([[401], [400], [429], [500]])("HTTP %i output omits the secret", async (status) => {
    await withServer(status as number, async (base) => {
      const r = await run(base);
      expect(r.stdout + r.stderr).not.toContain(OLD);
    });
  });

  it("a network error omits the secret", async () => {
    const r = await run("http://127.0.0.1:1");
    expect(r.stdout + r.stderr).not.toContain(OLD);
  });
});
