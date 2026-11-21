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
  server = spawn(process.execPath, [join(APP_DIR, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: APP_DIR,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: `--require ${GUARD}`, CP_EGRESS_GUARD_LOG: guardLog },
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
const carries = (r: Recorded, needles: string[]) => {
  const hay = [r.url, ...Object.values(r.headers), ...r.bodies].join("\n");
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
      expect(all.filter((r) => isTelemetry(r) && carries(r, [RID, TOK])).map(label)).toEqual([]);
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

  it.each([
    ["unrelated route, credential-shaped id", `/workspace/team/${TOK}/members?openResearchRun=${RID}`, "/workspace/team/[workspaceId]/members"],
    ["unrelated API-shaped id route", `/workspace/research/${RID}?token=${TOK}`, "/workspace/research/[runId]"],
    ["unknown route", `/no-such-route/${TOK}/${INV}`, "/[unmatched]"],
    ["unknown route, double-encoded", `/no-such-route/x%2523token%253D${TOK}`, "/[unmatched]"],
    ["SEO slug that is not in the allowlist", `/learn/${TOK}`, "/learn/[slug]"],
  ])("H3 %s: telemetry flows with templates and never carries the values", async (_name, path, template) => {
    const run = await open(path);
    try {
      await run.page.waitForTimeout(8_000);
      const all = await run.all();
      await assertContained(all, run.websockets);
      const telemetry = all.filter(isTelemetry);
      // Positive control: PostHog events were sent (pageview), so the absence below is meaningful.
      expect(telemetry.filter((r) => r.decision === "posthog").length).toBeGreaterThan(0);
      expect(telemetry.filter((r) => carries(r, [TOK, INV, RID])).map(label)).toEqual([]);
      expect(badReferers(all)).toEqual([]);
      const bodies = telemetry.flatMap((r) => r.bodies).join("\n");
      // The page either stayed on the route (template present) or redirected to /login (redirect value redacted).
      expect(bodies.includes(template) || bodies.includes("/login")).toBe(true);
    } finally {
      await run.close();
    }
  });

  it("H3 Replay: the uncompressed recording is sent and its meta href is templated (sampling forced)", async () => {
    const run = await open(`/workspace/team/${TOK}/members?openResearchRun=${RID}`);
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
      expect(tunnel.filter((r) => carries(r, [TOK, INV, RID])).map(label)).toEqual([]);
      const recordings = tunnel.flatMap((r) => r.bodies).filter((b) => b.includes('"type":"replay_recording"'));
      expect(recordings.length).toBeGreaterThan(0);
      const hrefs = recordings.join("\n").match(/"href":"[^"]*"/g) ?? [];
      expect(hrefs.length).toBeGreaterThan(0);
      for (const h of hrefs) expect(h).not.toMatch(new RegExp(`${TOK}|${RID}`));
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
});
