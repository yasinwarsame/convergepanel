/**
 * Structural telemetry hardening (private advisory GHSA-655j-5f43-92pw follow-up): the browser-level invariants
 * against the REAL Next.js production build, contained exactly like __tests__/telemetryNextAppR4.spec.ts:
 *   - `next start` is spawned by this spec on 127.0.0.1 with an EMPTY environment and the egress guard preloaded
 *     (any outbound socket to a non-loopback host is refused and logged; the log must stay empty);
 *   - the browser is default-deny: only the app origin continues; `/monitoring` (Sentry tunnel) and `/ingest/*`
 *     (PostHog rewrite) are answered locally and counted as telemetry; every other host is aborted.
 * Synthetic sentinels only.
 *
 * Opt-in: CP_NEXT_HARNESS_APP_DIR=<production build of THIS tree, no .env*> CP_NEXT_HARNESS_PORT=<port>
 *   npx jest __tests__/telemetryStructuralHardening.spec.ts
 *
 * H1 every same-origin request carries at most the ORIGIN as Referer (`Referrer-Policy: strict-origin`), and the
 *    document response sends that header;
 * H2 canonical and %23-rewritten invitation links: no request at all carries the token or invitation id in its
 *    Referer, and no telemetry request is made (the #334 invariant is preserved);
 * H3 unrelated and unknown routes whose path carries credential-shaped values: telemetry still flows (positive
 *    control), carries route templates, and no telemetry request (URL, headers, any decoding of the body,
 *    including the uncompressed Replay recording and its meta href) contains the values;
 * H4 PostHog's `/flags` request is never made.
 */
import { spawn, type ChildProcess } from "child_process";
import { createServer, type Server } from "http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { chromium, type Browser, type Request } from "playwright";
import { chromiumAvailable, decodeBodies, FORCE_REPLAY_SAMPLING, initScript, type RecordedRequest } from "./helpers/telemetryBrowserHarness";
import { decideRoute, isLoopbackUrl, type RouteDecision } from "./helpers/nextHarnessRouting";

jest.setTimeout(240_000);

const ROOT = resolve(__dirname, "..");
const APP_DIR = process.env.CP_NEXT_HARNESS_APP_DIR ?? "";
const PORT = Number(process.env.CP_NEXT_HARNESS_PORT ?? "3998");
const BASE = `http://127.0.0.1:${PORT}`;
const GUARD = join(ROOT, "__tests__/helpers/egressGuard.cjs");
const PROBE = join(ROOT, "__tests__/helpers/proxyHeaderProbe.cjs");
// 43 base64url characters with both cases: the invitation token shape. Distinct sentinels per role.
const TOK = "Zq7xK2mPvR9tLwB4nYc8HdJ3fGs6Ue1Ao5Ti0Vb-W_y";
const INV = "INVSTRUCTSENTINEL0042";
const RID = "RUNSTRUCTSENTINEL0099";
const d = APP_DIR && chromiumAvailable() ? describe : describe.skip;

type Recorded = RecordedRequest & { decision: RouteDecision };

let browser: Browser | null = null;
let server: ChildProcess | null = null;
let workDir = "";
let guardLog = "";
let probeLog = "";
// Loopback stand-in for PostHog (containment hotfix): records method, path and header NAMES only, never values.
let echo: Server | null = null;
let echoPort = 0;
const echoHits: Array<{ method: string; path: string; headerNames: string[] }> = [];
let serverOutput = "";

function guardAttempts(): string[] {
  return existsSync(guardLog) ? readFileSync(guardLog, "utf8").split("\n").filter(Boolean) : [];
}

beforeAll(async () => {
  if (!APP_DIR || !chromiumAvailable()) return;
  expect(readdirSync(APP_DIR).filter((f) => f.startsWith(".env") && !f.endsWith(".example"))).toEqual([]);
  let portBusy = false;
  try {
    await fetch(`${BASE}/`);
    portBusy = true;
  } catch {
    portBusy = false;
  }
  if (portBusy) throw new Error(`${BASE} is already answering: stop that server first`);
  workDir = mkdtempSync(join(tmpdir(), "cp-struct-harness-"));
  guardLog = join(workDir, "egress.log");
  writeFileSync(guardLog, "");
  probeLog = join(workDir, "proxy-probe.log");
  writeFileSync(probeLog, "");
  echo = createServer((req, res) => {
    echoHits.push({ method: String(req.method), path: String(req.url).split("?")[0], headerNames: Object.keys(req.headers).map((k) => k.toLowerCase()).sort() });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "echo=1" });
      res.end('{"status":1}');
    });
  });
  await new Promise<void>((r) => echo!.listen(0, "127.0.0.1", () => r()));
  echoPort = (echo.address() as { port: number }).port;
  server = spawn(process.execPath, [join(APP_DIR, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: APP_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_OPTIONS: `--require ${GUARD} --require ${PROBE}`,
      CP_EGRESS_GUARD_LOG: guardLog,
      CP_PROXY_PROBE_LOG: probeLog,
      // Test-only upstream override (honoured only off Vercel and only for a loopback origin).
      CP_TEST_ANALYTICS_PROXY_ORIGIN: `http://127.0.0.1:${echoPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (b) => (serverOutput += String(b)));
  server.stderr?.on("data", (b) => (serverOutput += String(b)));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/pricing`)).status < 500) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`next start did not come up:\n${serverOutput.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const buildId = readFileSync(join(APP_DIR, ".next/BUILD_ID"), "utf8").trim();
  if ((await fetch(`${BASE}/_next/static/${buildId}/_buildManifest.js`)).status !== 200) throw new Error(`${BASE} is not serving build ${buildId}`);
});

afterAll(async () => {
  if (browser) await browser.close();
  if (server) server.kill("SIGTERM");
  if (echo) echo.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function open(path: string) {
  if (!browser) browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  const network: Recorded[] = [];
  const pending: Promise<void>[] = [];
  const websockets: string[] = [];
  context.on("request", (req: Request) => {
    pending.push(
      (async () => {
        let headers: Record<string, string> = {};
        try {
          headers = await req.allHeaders();
        } catch {
          headers = req.headers();
        }
        network.push({ layer: "network", kind: req.resourceType(), url: req.url(), headers, bodies: decodeBodies(req.postDataBuffer()), decision: decideRoute(req.url(), BASE) });
      })()
    );
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    switch (decideRoute(url.href, BASE)) {
      case "app":
        return route.continue();
      case "sentry-tunnel":
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      case "posthog":
        if (url.pathname.startsWith("/ingest/flags") || url.pathname.startsWith("/ingest/decide")) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ featureFlags: {}, featureFlagPayloads: {}, flags: {} }) });
        }
        return route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' });
      case "posthog-static": {
        const file = join(ROOT, "node_modules/posthog-js/dist", url.pathname.replace(/^\/ingest\/(static|array\/[^/]+)\//, ""));
        if (existsSync(file)) return route.fulfill({ status: 200, contentType: "application/javascript", body: readFileSync(file, "utf8") });
        return route.fulfill({ status: 404, body: "" });
      }
      default:
        return route.abort();
    }
  });
  await context.addInitScript(initScript("normal"));
  await context.addInitScript(FORCE_REPLAY_SAMPLING);
  const page = await context.newPage();
  page.on("websocket", (ws) => websockets.push(ws.url()));
  const response = await page.goto(BASE + path, { waitUntil: "load" });
  return {
    page,
    response,
    all: async (): Promise<Recorded[]> => {
      await Promise.all(pending);
      return [...network];
    },
    close: async () => {
      await Promise.all(pending);
      await context.close();
    },
    websockets,
  };
}

const isTelemetry = (r: Recorded) => r.decision === "sentry-tunnel" || r.decision === "posthog";
// The browser's own Cookie header on same-origin requests is first-party; what the `/ingest` proxy forwards to
// PostHog is checked server-side (H5). Every other header, the URL and every decoding of the body are checked.
const carries = (r: Recorded, needles: string[]) => {
  const hay = [r.url, ...Object.entries(r.headers).filter(([k]) => k.toLowerCase() !== "cookie").map(([, v]) => v), ...r.bodies].join("\n");
  return needles.some((n) => hay.includes(n) || hay.includes(encodeURIComponent(n)));
};
const label = (r: Recorded) => `${r.kind} ${r.decision} ${r.url.slice(0, 140)}`;

async function assertContained(all: Recorded[], websockets: string[]): Promise<void> {
  expect(all.filter((r) => /^(https?|wss?):/i.test(r.url) && !isLoopbackUrl(r.url)).map(label)).toEqual([]);
  expect(websockets.filter((u) => !isLoopbackUrl(u.replace(/^ws/, "http")))).toEqual([]);
  expect(guardAttempts()).toEqual([]);
}

/** H1: every same-origin request's Referer is absent or exactly the origin. */
function badReferers(all: Recorded[]): string[] {
  return all
    .filter((r) => r.decision !== "deny")
    .filter((r) => {
      const ref = r.headers["referer"] ?? r.headers["Referer"];
      return ref !== undefined && ref !== `${BASE}/`;
    })
    .map((r) => `${label(r)} <- ${String(r.headers["referer"]).slice(0, 120)}`);
}

d("structural telemetry hardening: real Next.js production build (contained)", () => {
  it("H1: same-origin requests carry the origin only; the document sends Referrer-Policy: strict-origin", async () => {
    const run = await open(`/pricing?utm_source=newsletter&openResearchRun=${RID}`);
    try {
      expect(run.response?.headers()["referrer-policy"]).toBe("strict-origin");
      await run.page.waitForTimeout(6_000);
      // A soft navigation (RSC fetch) and a full navigation from a page whose URL carries ids.
      await run.page.evaluate(() => (window as any).next.router.push("/about"));
      await run.page.waitForURL(/\/about/);
      await run.page.waitForTimeout(3_000);
      await run.page.goto(`${BASE}/learn/${TOK}?openResearchRun=${RID}`, { waitUntil: "load" });
      await run.page.waitForTimeout(3_000);
      await run.page.evaluate(() => fetch("/api/user/usage").catch(() => undefined));
      await run.page.waitForTimeout(3_000);
      const all = await run.all();
      await assertContained(all, run.websockets);
      const sameOrigin = all.filter((r) => r.decision !== "deny");
      expect(sameOrigin.filter((r) => r.headers["referer"] === `${BASE}/`).length).toBeGreaterThan(5); // the policy was exercised
      expect(badReferers(all)).toEqual([]);
      const leaking = all.filter((r) => isTelemetry(r) && carries(r, [RID, TOK]));
      if (process.env.CP_STRUCT_DEBUG) {
        for (const r of leaking) {
          const hay = [r.url, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`), ...r.bodies].join("\n");
          for (const n of [RID, TOK, encodeURIComponent(RID)]) {
            let i = hay.indexOf(n);
            let shown = 0;
            while (i !== -1 && shown < 3) {
              // eslint-disable-next-line no-console
              console.log(`[debug] ${label(r)} :: ...${hay.slice(Math.max(0, i - 160), i + 40).replace(/\s+/g, " ")}...`);
              i = hay.indexOf(n, i + 1);
              shown++;
            }
          }
        }
      }
      expect(leaking.map(label)).toEqual([]);
    } finally {
      await run.close();
    }
  });

  it.each([
    ["canonical fragment link", `/workspace-invitations/accept#invitationId=${INV}&token=${TOK}`],
    ["%23-rewritten link", `/workspace-invitations/accept%23invitationId%3D${INV}%26token%3D${TOK}`],
  ])("H2 %s: no Referer carries the credential and no telemetry is sent", async (_name, path) => {
    const run = await open(path);
    try {
      await run.page.waitForTimeout(6_000);
      const all = await run.all();
      await assertContained(all, run.websockets);
      expect(badReferers(all)).toEqual([]);
      expect(all.filter((r) => /token|invitationId/.test(r.headers["referer"] ?? "")).map(label)).toEqual([]);
      expect(all.filter(isTelemetry).map(label)).toEqual([]);
      // No request URL other than the document the user opened carries the token.
      expect(all.filter((r) => r.kind !== "document" && (r.url.includes(TOK) || r.url.includes(encodeURIComponent(TOK)))).map(label)).toEqual([]);
      // Observation only (first-party request headers other than Referer, e.g. Next.js router state on prefetches):
      const headerCarriers = all.filter((r) => r.kind !== "document" && Object.entries(r.headers).some(([k, v]) => k !== "referer" && (v.includes(TOK) || v.includes(encodeURIComponent(TOK)))));
      // eslint-disable-next-line no-console
      console.log(`[structural harness] ${_name}: first-party non-Referer headers carrying the token: ${headerCarriers.length} ${JSON.stringify(headerCarriers.map((r) => Object.keys(r.headers).filter((k) => r.headers[k].includes(TOK) || r.headers[k].includes(encodeURIComponent(TOK)))))}`);
    } finally {
      await run.close();
    }
  });

  // `flows`: ids that are not token-shaped -> telemetry is sent (positive control) and must carry only templates.
  // A 43-character token-shaped component makes the whole document telemetry-free (#334, conservative): then NO
  // telemetry may be sent at all.
  it.each([
    ["unrelated route, sensitive ids", `/workspace/team/${INV}/members?openResearchRun=${RID}`, "/workspace/team/[workspaceId]/members", true],
    ["unrelated route, ids in path and query", `/workspace/research/${RID}?workspace=${INV}`, "/workspace/research/[runId]", true],
    ["unknown route, sensitive ids", `/no-such-route/${INV}/${RID}`, "/[unmatched]", true],
    ["SEO slug not in the allowlist", `/learn/${RID.toLowerCase()}`, "/learn/[slug]", true],
    ["unrelated route, token-shaped id", `/workspace/team/${TOK}/members?openResearchRun=${RID}`, "", false],
    ["unknown route, token-shaped", `/no-such-route/${TOK}/${INV}`, "", false],
    ["unknown route, double-encoded token", `/no-such-route/x%2523token%253D${TOK}`, "", false],
  ])("H3 %s: telemetry carries only templates", async (_name, path, template, flows) => {
    const run = await open(path as string);
    try {
      await run.page.waitForTimeout(8_000);
      const all = await run.all();
      await assertContained(all, run.websockets);
      const telemetry = all.filter(isTelemetry);
      if (!flows) {
        expect(telemetry.map(label)).toEqual([]);
        return;
      }
      // Positive control: PostHog events were sent (pageview), so the absence below is meaningful.
      expect(telemetry.filter((r) => r.decision === "posthog").length).toBeGreaterThan(0);
      expect(telemetry.filter((r) => carries(r, [TOK, INV, RID, RID.toLowerCase()])).map(label)).toEqual([]);
      expect(badReferers(all)).toEqual([]);
      const bodies = telemetry.flatMap((r) => r.bodies).join("\n");
      // The page either stayed on the route (template present) or redirected to /login (redirect value redacted).
      expect(bodies.includes(template as string) || bodies.includes("/login")).toBe(true);
    } finally {
      await run.close();
    }
  });

  it("H3 Replay: the uncompressed recording is sent and its meta href is templated (sampling forced)", async () => {
    const run = await open(`/workspace/team/${INV}/members?openResearchRun=${RID}`);
    try {
      await run.page.waitForTimeout(8_000);
      // Replay flushes on page hide; trigger it, then give the transport time.
      await run.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await run.page.goto(`${BASE}/pricing`, { waitUntil: "load" });
      await run.page.waitForTimeout(6_000);
      const all = await run.all();
      await assertContained(all, run.websockets);
      const tunnel = all.filter((r) => r.decision === "sentry-tunnel");
      expect(tunnel.length).toBeGreaterThan(0); // positive control: Sentry traffic observed
      expect(tunnel.filter((r) => carries(r, [INV, RID])).map(label)).toEqual([]);
      const recordings = tunnel.flatMap((r) => r.bodies).filter((b) => b.includes('"type":"replay_recording"'));
      expect(recordings.length).toBeGreaterThan(0);
      const hrefs = recordings.join("\n").match(/"href":"[^"]*"/g) ?? [];
      expect(hrefs.length).toBeGreaterThan(0);
      for (const h of hrefs) expect(h).not.toMatch(new RegExp(`${INV}|${RID}`));
    } finally {
      await run.close();
    }
  });

  it("H4: PostHog /flags is never requested", async () => {
    const run = await open(`/pricing`);
    try {
      await run.page.waitForTimeout(6_000);
      const all = await run.all();
      expect(all.filter((r) => r.decision === "posthog").length).toBeGreaterThan(0);
      expect(all.filter((r) => /\/ingest\/(flags|decide)/.test(r.url)).map(label)).toEqual([]);
    } finally {
      await run.close();
    }
  });

  it("H6: the real build registers no rewrite to PostHog or Sentry (no external proxy forwards request headers)", () => {
    const manifest = JSON.parse(readFileSync(join(APP_DIR, ".next/routes-manifest.json"), "utf8"));
    const rw = manifest.rewrites;
    const all: Array<{ source: string; destination: string }> = Array.isArray(rw) ? rw : [...(rw.beforeFiles ?? []), ...(rw.afterFiles ?? []), ...(rw.fallback ?? [])];
    expect(all.filter((r) => /posthog|sentry/i.test(r.destination)).map((r) => `${r.source} -> ${r.destination}`)).toEqual([]);
  });

  // Containment hotfix: the proxy is app code; the upstream is a loopback echo server, so the REAL route handler
  // and middleware run and the headers that actually arrive upstream are observed (names only).
  it("H5: canonical /ingest requests arrive upstream without Cookie or Authorization (any case); variants never reach it", async () => {
    const dummy = (casing: "lower" | "upper" | "mixed") => {
      const c = { lower: ["cookie", "authorization"], upper: ["COOKIE", "AUTHORIZATION"], mixed: ["Cookie", "Authorization"] }[casing];
      return { [c[0]]: `__session=DUMMYSESSION${RID}; ph_phc_synthetic_posthog=x`, [c[1]]: `Bearer DUMMYBEARER${RID}`, "proxy-authorization": "Basic DUMMY", "x-firebase-appcheck": "DUMMY", "content-type": "text/plain" };
    };
    const canonical = ["/ingest/e/?ip=0", "/ingest/i/v0/e/", "/ingest/static/array.js", "/ingest/array/phc_synthetic/config.js"];
    for (const casing of ["lower", "upper", "mixed"] as const) {
      for (const path of canonical) {
        const post = !path.includes("static") && !path.includes("array");
        const before = echoHits.length;
        const res = await fetch(`${BASE}${path}`, { method: post ? "POST" : "GET", headers: dummy(casing), body: post ? "payload" : undefined });
        expect([casing, path, res.status]).toEqual([casing, path, 200]);
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(echoHits.length).toBe(before + 1); // positive control: it really reached the upstream
        const hit = echoHits[echoHits.length - 1];
        expect(hit.headerNames).not.toContain("cookie");
        expect(hit.headerNames).not.toContain("authorization");
        expect(hit.headerNames).not.toContain("proxy-authorization");
        expect(hit.headerNames).not.toContain("x-firebase-appcheck");
      }
    }
    const variants = ["/INGEST/e/", "/Ingest/static/array.js", "/iNgEsT/e/", "/ingest./e/", "//ingest/e/", "/ingest//e/", "/%69ngest/e/", "/ingest%2Fe", "/Monitoring?o=1&p=2", "/MONITORING/?o=1&p=2&r=de"];
    const before = echoHits.length;
    for (const path of variants) {
      const res = await fetch(`${BASE}${path}`, { method: "POST", headers: dummy("mixed"), body: "payload", redirect: "manual" });
      expect([path, res.status === 404 || res.status === 308]).toEqual([path, true]);
    }
    expect(echoHits.length).toBe(before); // no variant reached the upstream
    // Nothing tried to leave the machine (no rewrite to PostHog or Sentry exists any more for these paths).
    expect(guardAttempts()).toEqual([]);
    const allNames = [...new Set(echoHits.flatMap((h) => h.headerNames))].sort();
    // eslint-disable-next-line no-console
    console.log(`[structural harness] upstream header names: ${JSON.stringify(allNames)}`);
  });
});
