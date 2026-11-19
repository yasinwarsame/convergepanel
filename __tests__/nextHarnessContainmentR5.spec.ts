/**
 * PR #329 R5 (R4 review MINOR-2, A1 containment) — the production-build harness
 * (`__tests__/telemetryNextAppR4.spec.ts`) must make external egress IMPOSSIBLE:
 *
 *  1. Browser side: a default-deny routing decision. Only the local app origin
 *     (127.0.0.1 / localhost) is reachable; `/monitoring` (the Sentry tunnel,
 *     which the app server would forward to real Sentry ingest) and `/ingest/*`
 *     (the PostHog rewrite) are answered by the harness and NEVER continued to the
 *     app server; every other host is denied.
 *  2. Server side: the harness starts `next start` with a preloaded egress guard
 *     (`__tests__/helpers/egressGuard.cjs`) that refuses every outbound socket to a
 *     non-loopback host and records the attempt, and with no Sentry / PostHog /
 *     Firebase credentials in its environment.
 * Both are exercised here without a build: (1) as a pure function, (2) in a child
 * Node process that tries to reach Sentry, PostHog and an arbitrary host with
 * http(s), fetch and a raw socket — every attempt must be refused before any DNS
 * lookup or connection, and logged. Synthetic hosts / payloads only.
 */
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const ROOT = resolve(__dirname, "..");
const BASE = "http://127.0.0.1:3999";

describe("browser routing decision (default deny)", () => {
  const decide = (url: string) => require("./helpers/nextHarnessRouting").decideRoute(url, BASE);
  it.each([
    [`${BASE}/verify?source=extension`, "app"],
    [`${BASE}/_next/static/chunks/main.js`, "app"],
    [`${BASE}/monitoring?o=1&p=1`, "sentry-tunnel"],
    [`${BASE}/monitoring/`, "sentry-tunnel"],
    [`${BASE}/ingest/flags/?v=2`, "posthog"],
    [`${BASE}/ingest/e/`, "posthog"],
    [`${BASE}/ingest/static/array.js`, "posthog-static"],
    [`${BASE}/ingest/array/phc_x/config.js`, "posthog-static"],
    ["https://o1.ingest.sentry.io/api/1/envelope/", "deny"],
    ["https://us.i.posthog.com/flags", "deny"],
    ["https://us-assets.i.posthog.com/static/array.js", "deny"],
    ["https://identitytoolkit.googleapis.com/v1/accounts", "deny"],
    ["https://fonts.gstatic.com/x.woff2", "deny"],
    ["http://127.0.0.1:4000/other-port", "deny"],
    ["http://localhost:3999/same-port-other-host-name", "deny"],
  ])("%s -> %s", (url, expected) => {
    expect(decide(url)).toBe(expected);
  });
  it("only loopback hosts count as local for the 'nothing left the machine' assertion", () => {
    const { isLoopbackUrl } = require("./helpers/nextHarnessRouting");
    expect(isLoopbackUrl(`${BASE}/x`)).toBe(true);
    expect(isLoopbackUrl("http://localhost:1/x")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1/x")).toBe(true);
    expect(isLoopbackUrl("https://o1.ingest.sentry.io/api/1/envelope/")).toBe(false);
    expect(isLoopbackUrl("https://127.0.0.1.nip.io/x")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("server-side egress guard (preloaded into `next start` by the harness)", () => {
  it("refuses http(s), fetch and raw sockets to non-loopback hosts, logs each attempt, and allows loopback", () => {
    const guard = join(ROOT, "__tests__/helpers/egressGuard.cjs");
    expect(existsSync(guard)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "cp-egress-guard-"));
    const log = join(dir, "egress.log");
    const script = `
      const http = require("http"), https = require("https"), net = require("net");
      const results = {};
      const done = () => { process.stdout.write(JSON.stringify(results)); process.exit(0); };
      const server = http.createServer((req, res) => res.end("local-ok")).listen(0, "127.0.0.1", async () => {
        const port = server.address().port;
        const one = (name, fn) => new Promise((r) => { try { fn((v) => { results[name] = v; r(); }); } catch (e) { results[name] = "threw:" + e.code; r(); } });
        await one("https", (cb) => https.get("https://o1.ingest.sentry.io/api/1/envelope/", () => cb("CONNECTED")).on("error", (e) => cb("error:" + e.code)));
        await one("http", (cb) => http.get("http://us.i.posthog.com/flags", () => cb("CONNECTED")).on("error", (e) => cb("error:" + e.code)));
        await one("fetch", (cb) => fetch("https://us.i.posthog.com/e/").then(() => cb("CONNECTED"), (e) => cb("error:" + ((e.cause && e.cause.code) || e.code || e.name))));
        await one("socket", (cb) => net.connect(443, "example.com").on("connect", () => cb("CONNECTED")).on("error", (e) => cb("error:" + e.code)));
        await one("local", (cb) => http.get("http://127.0.0.1:" + port + "/", (res) => { let b = ""; res.on("data", (c) => b += c); res.on("end", () => cb(b)); }).on("error", (e) => cb("error:" + e.code)));
        server.close(); done();
      });`;
    const out = spawnSync(process.execPath, ["--require", guard, "-e", script], {
      env: { PATH: process.env.PATH ?? "", CP_EGRESS_GUARD_LOG: log },
      encoding: "utf8",
      timeout: 30_000,
    });
    try {
      expect(out.status).toBe(0);
      const results = JSON.parse(out.stdout);
      expect(results.https).toBe("error:CP_EGRESS_BLOCKED");
      expect(results.http).toBe("error:CP_EGRESS_BLOCKED");
      expect(results.fetch).toBe("error:CP_EGRESS_BLOCKED");
      expect(results.socket).toBe("error:CP_EGRESS_BLOCKED");
      expect(results.local).toBe("local-ok");
      const attempts = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).host).sort();
      expect(attempts).toEqual(["example.com", "o1.ingest.sentry.io", "us.i.posthog.com", "us.i.posthog.com"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("telemetryNextAppR4.spec.ts uses the containment (source pins)", () => {
  const src = readFileSync(join(ROOT, "__tests__/telemetryNextAppR4.spec.ts"), "utf8");
  it("routes every request through decideRoute; continue() only for the local app", () => {
    expect(src).toMatch(/decideRoute\(/);
    expect(src.match(/route\.continue\(/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/case "app":\s*return route\.continue\(\)/);
    expect(src).not.toMatch(/endsWith\("\.sentry\.io"\)\)\s*return route\.fulfill/);
  });
  it("starts its own server with the egress guard and no inherited environment; asserts loopback-only traffic and an empty guard log", () => {
    expect(src).toMatch(/egressGuard\.cjs/);
    expect(src).not.toMatch(/\.\.\.process\.env/);
    expect(src).toMatch(/isLoopbackUrl/);
    expect(src).toMatch(/CP_EGRESS_GUARD_LOG/);
    expect(src).not.toMatch(/CP_NEXT_HARNESS_BASE/);
  });
});
