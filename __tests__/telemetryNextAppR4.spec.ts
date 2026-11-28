/**
 * PR #329 R4/R5 (owner A1/A3) — the telemetry URL invariant against the REAL
 * Next.js production build: real `instrumentation-client.ts` ordering (Sentry's
 * plugin prepends it to `main-app`), real hydration, real app router (soft
 * navigation, `router.refresh()`, back/forward restore), real /verify, /signup,
 * /login and /onboarding pages, real posthog-js and Sentry (Replay sampling forced).
 *
 * Opt-in: needs a production build of THIS tree in a directory WITHOUT any
 * `.env*` file (e.g. a `git archive` copy with node_modules linked), built with
 * synthetic public values only, e.g.
 *   NEXT_PUBLIC_VERCEL_ENV=production NEXT_PUBLIC_POSTHOG_KEY=phc_synthetic NEXT_PUBLIC_SENTRY_DSN=https://<32 hex>@o1.ingest.sentry.io/1 next build
 * then
 *   CP_NEXT_HARNESS_APP_DIR=<that dir> npx jest __tests__/telemetryNextAppR4.spec.ts
 *
 * CONTAINMENT (R5, R4 review MINOR-2) — external egress is impossible:
 *   - the spec starts `next start` ITSELF on 127.0.0.1 with an EMPTY environment (no Sentry / PostHog / Firebase /
 *     provider credentials, telemetry disabled) and the egress guard preloaded (`__tests__/helpers/egressGuard.cjs`):
 *     any outbound socket to a non-loopback host is refused before DNS and logged; the log must stay EMPTY;
 *   - the browser is default-deny (`__tests__/helpers/nextHarnessRouting.ts`): only the app origin is continued;
 *     `/monitoring` (the Sentry tunnel the app server would forward to real Sentry) and `/ingest/*` (the PostHog
 *     rewrite) are answered locally and NEVER reach the app server; every other host is aborted;
 *   - every test asserts that every request the browser even attempted was to a loopback host;
 *   - tunnelled envelopes count as Sentry requests in the leak checks; a positive control proves tunnel traffic
 *     was observed (and answered locally).
 * Synthetic sentinels only.
 */
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { chromium, type Browser, type Page, type Request } from "playwright";
import { safeRedirect } from "@/lib/utils/safeRedirect";
import { chromiumAvailable, decodeBodies, FORCE_REPLAY_SAMPLING, initScript, requestsContaining, type RecordedRequest, type StorageMode } from "./helpers/telemetryBrowserHarness";
import { decideRoute, isLoopbackUrl, type RouteDecision } from "./helpers/nextHarnessRouting";

jest.setTimeout(180_000);

const ROOT = resolve(__dirname, "..");
const APP_DIR = process.env.CP_NEXT_HARNESS_APP_DIR ?? "";
const PORT = Number(process.env.CP_NEXT_HARNESS_PORT ?? "3999");
const BASE = `http://127.0.0.1:${PORT}`;
const GUARD = join(ROOT, "__tests__/helpers/egressGuard.cjs");
const SENTINEL = "ZQX7NEXTSENTINEL";
const CLAIM = `the moon is hollow ${SENTINEL} & tides obey wind farms`;
const UTM = "utm_source=newsletter&utm_campaign=Spring%20Sale";
const enc = encodeURIComponent;
const d = APP_DIR && chromiumAvailable() ? describe : describe.skip;

type Recorded = RecordedRequest & { decision: RouteDecision };

let browser: Browser | null = null;
let bfcacheBrowser: Browser | null = null;
let server: ChildProcess | null = null;
let workDir = "";
let guardLog = "";
let serverOutput = "";
const allObserved: Recorded[] = [];

function guardAttempts(): string[] {
  return existsSync(guardLog) ? readFileSync(guardLog, "utf8").split("\n").filter(Boolean) : [];
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/pricing`);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`next start did not come up on ${BASE}:\n${serverOutput.slice(-2000)}`);
}

beforeAll(async () => {
  if (!APP_DIR || !chromiumAvailable()) return;
  // The build directory must not carry any environment file: `next start` would load it.
  expect(readdirSync(APP_DIR).filter((f) => f.startsWith(".env") && !f.endsWith(".example"))).toEqual([]);
  // Review R4 MINOR-1: never test a server this spec did not start (a stale `next start` on the port would answer).
  let portBusy = false;
  try {
    await fetch(`${BASE}/`);
    portBusy = true;
  } catch {
    portBusy = false;
  }
  if (portBusy) throw new Error(`${BASE} is already answering: stop that server first (the harness must test ${APP_DIR})`);
  workDir = mkdtempSync(join(tmpdir(), "cp-next-harness-"));
  guardLog = join(workDir, "egress.log");
  writeFileSync(guardLog, "");
  server = spawn(process.execPath, [join(APP_DIR, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: APP_DIR,
    // An EMPTY environment: nothing inherited (no DSN, no keys, no credentials), Next telemetry off, egress guard on.
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_OPTIONS: `--require ${GUARD}`,
      CP_EGRESS_GUARD_LOG: guardLog,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (b) => (serverOutput += String(b)));
  server.stderr?.on("data", (b) => (serverOutput += String(b)));
  await waitForServer();
  // ...and the server answering is the build under test.
  const buildId = readFileSync(join(APP_DIR, ".next/BUILD_ID"), "utf8").trim();
  const manifest = await fetch(`${BASE}/_next/static/${buildId}/_buildManifest.js`);
  if (manifest.status !== 200) throw new Error(`the server on ${BASE} is not serving build ${buildId} of ${APP_DIR}`);
});

afterAll(async () => {
  if (browser) await browser.close();
  if (bfcacheBrowser) await bfcacheBrowser.close();
  if (server) server.kill("SIGTERM");
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function open(path: string, mode: StorageMode, opts: { bfcache?: boolean } = {}) {
  if (!browser) browser = await chromium.launch({ headless: true });
  // Review R3 MAJOR-1: Playwright disables the back/forward cache by default and the headless shell cannot use it;
  // the full Chromium build with that default argument removed does.
  if (opts.bfcache && !bfcacheBrowser) bfcacheBrowser = await chromium.launch({ headless: true, channel: "chromium", ignoreDefaultArgs: ["--disable-back-forward-cache"] });
  const context = await (opts.bfcache ? bfcacheBrowser! : browser).newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  const network: Recorded[] = [];
  const websockets: string[] = [];
  const pending: Promise<void>[] = [];
  const saved: Recorded[] = [];
  context.on("request", (req: Request) => {
    pending.push(
      (async () => {
        let headers: Record<string, string> = {};
        try {
          headers = await req.allHeaders();
        } catch {
          headers = req.headers();
        }
        const rec: Recorded = { layer: "network", kind: req.resourceType(), url: req.url(), headers, bodies: decodeBodies(req.postDataBuffer()), decision: decideRoute(req.url(), BASE) };
        network.push(rec);
        allObserved.push(rec);
      })()
    );
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    switch (decideRoute(url.href, BASE)) {
      case "app": return route.continue();
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
  await context.addInitScript(initScript(mode));
  await context.addInitScript(FORCE_REPLAY_SAMPLING);
  const page = await context.newPage();
  page.on("websocket", (ws) => websockets.push(ws.url()));
  await page.goto(BASE + path, { waitUntil: "load" });
  const pageRecords = async (p: Page): Promise<Recorded[]> => {
    try {
      const recs: Array<{ kind: string; url: string; body: string }> = await p.evaluate(() => (window as any).__cpRequests ?? []);
      return recs.map((r) => {
        const abs = new URL(r.url, BASE).href;
        return { layer: "page" as const, kind: r.kind, url: abs, headers: {}, bodies: r.body ? [r.body] : [], decision: decideRoute(abs, BASE) };
      });
    } catch {
      return [];
    }
  };
  return {
    page,
    websockets,
    /** A point in time: network records so far and saved (earlier-document) page records so far. */
    mark: async () => {
      await Promise.all(pending);
      return { network: network.length, saved: saved.length };
    },
    /** Every record after `m`: later network records, later saved page records, and the current document's page records. */
    since: async (m: { network: number; saved: number }): Promise<Recorded[]> => {
      await Promise.all(pending);
      return [...network.slice(m.network), ...saved.slice(m.saved), ...(await pageRecords(page))];
    },
    save: async () => {
      saved.push(...(await pageRecords(page)));
    },
    all: async (): Promise<Recorded[]> => {
      await Promise.all(pending);
      return [...network, ...saved, ...(await pageRecords(page))];
    },
    close: async () => {
      await Promise.all(pending);
      await context.close();
    },
  };
}

const isTelemetry = (r: Recorded) => r.decision === "sentry-tunnel" || r.decision === "posthog" || /(^|\.)sentry\.io$/.test(safeHost(r.url));
function safeHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

/** Nothing left the machine: every attempted request (both layers) and websocket was to loopback; the server guard saw nothing. */
async function assertContained(run: Awaited<ReturnType<typeof open>>) {
  const all = await run.all();
  const httpish = all.filter((r) => /^(https?|wss?):/i.test(r.url));
  expect(httpish.filter((r) => !isLoopbackUrl(r.url)).map((r) => `${r.layer}:${r.kind} ${r.url.slice(0, 120)}`)).toEqual([]);
  expect(run.websockets.filter((u) => !isLoopbackUrl(u.replace(/^ws/, "http")))).toEqual([]);
  expect(guardAttempts()).toEqual([]);
  return all;
}

async function textareaValue(page: Page): Promise<string> {
  await page.waitForSelector("#verify-text:not([disabled])", { timeout: 20_000 });
  return page.$eval("#verify-text", (el) => (el as HTMLTextAreaElement).value);
}
const leakList = (reqs: RecordedRequest[]) => reqs.map((r) => `${r.layer}:${r.kind} ${r.url.slice(0, 160)}`);

d("real Next.js production build (contained)", () => {
  it("extension #text= (sessionStorage working): clean before init; router refresh / soft nav / back never restore it; reload keeps the text", async () => {
    const run = await open(`/verify?source=extension&${UTM}#text=${enc(CLAIM)}`, "normal");
    try {
      expect(await run.page.evaluate(() => location.href)).toBe(`${BASE}/verify?source=extension&${UTM}`);
      expect(await textareaValue(run.page)).toBe(CLAIM);
      await run.page.waitForTimeout(4_000);
      await run.page.evaluate(() => (window as any).next.router.refresh());
      await run.page.waitForTimeout(2_000);
      expect(await run.page.evaluate(() => location.href)).toBe(`${BASE}/verify?source=extension&${UTM}`);
      await run.page.evaluate(() => (window as any).next.router.push("/pricing"));
      await run.page.waitForURL(/\/pricing/);
      await run.page.goBack();
      await run.page.waitForURL(/\/verify/);
      await run.page.waitForTimeout(1_000);
      expect(await run.page.evaluate(() => location.href)).toBe(`${BASE}/verify?source=extension&${UTM}`);
      expect(JSON.stringify(await run.page.evaluate(() => history.state))).not.toContain(SENTINEL);
      await run.page.goForward();
      await run.page.waitForURL(/\/pricing/);
      await run.page.goBack();
      await run.page.waitForURL(/\/verify/);
      await run.save();
      await run.page.reload({ waitUntil: "load" });
      expect(await textareaValue(run.page)).toBe(CLAIM); // sessionStorage hand-off survives the reload
      await run.page.waitForTimeout(6_000);
      const all = await assertContained(run);
      expect(all.some((r) => r.url.includes("/ingest/flags"))).toBe(false); // structural hardening: PostHog /flags is disabled
      expect(all.some((r) => r.url.includes("/ingest/e"))).toBe(true);
      expect(leakList(requestsContaining(all, SENTINEL))).toEqual([]);
    } finally {
      await run.close();
    }
  });

  for (const mode of ["session-getter-throws", "session-setitem-throws"] as StorageMode[]) {
    it(`extension #text= (${mode}): URL clean, text shown from memory with the notice; after reload gone + notice; no request carries it`, async () => {
      const run = await open(`/verify?source=extension&${UTM}#text=${enc(CLAIM)}`, mode);
      try {
        expect(await run.page.evaluate(() => location.href)).toBe(`${BASE}/verify?source=extension&${UTM}`);
        expect(await textareaValue(run.page)).toBe(CLAIM); // the memory hold reached the page (same document)
        expect((await run.page.textContent("main"))?.toLowerCase()).toContain("paste the claim manually");
        await run.page.waitForTimeout(4_000);
        await run.page.evaluate(() => (window as any).next.router.refresh());
        await run.page.waitForTimeout(2_000);
        expect(await run.page.evaluate(() => location.href)).not.toContain(SENTINEL);
        await run.save();
        await run.page.reload({ waitUntil: "load" });
        expect(await textareaValue(run.page)).toBe(""); // fail closed: not recoverable from the URL
        expect((await run.page.textContent("main"))?.toLowerCase()).toContain("paste the claim manually");
        await run.page.waitForTimeout(4_000);
        const all = await assertContained(run);
        expect(all.some((r) => r.url.includes("/ingest/flags"))).toBe(false); // structural hardening: PostHog /flags is disabled
        expect(leakList(requestsContaining(all, SENTINEL))).toEqual([]);
      } finally {
        await run.close();
      }
    });
  }

  // Legacy / nested links from the producer inventory (P1 main, P3, P4, P5, P6, P8, H3): stripped before any SDK
  // initializes; the nested redirect is rewritten to its clean target, which the real page still navigates to.
  for (const [label, path, clean, landing] of [
    ["P1 /verify?text=", `/verify?source=extension&text=${enc(CLAIM)}&${UTM}`, `/verify?source=extension&${UTM}`, null],
    ["P5 /?tab=verify&claim=", `/?tab=verify&claim=${enc(CLAIM)}&${UTM}`, `/?tab=verify&${UTM}`, null],
    ["P6 /?tab=research&q=", `/?tab=research&q=${enc(CLAIM)}&${UTM}`, `/?tab=research&${UTM}`, null],
    ["P3 /signup?redirect=/verify?text=", `/signup?redirect=${enc(`/verify?source=extension&text=${enc(CLAIM)}`)}&${UTM}`, `/signup?redirect=${enc("/verify?source=extension")}&${UTM}`, "/verify?source=extension"],
    ["P4 /login?redirect=/verify?text=", `/login?redirect=${enc(`/verify?source=extension&text=${enc(CLAIM)}`)}`, `/login?redirect=${enc("/verify?source=extension")}`, "/verify?source=extension"],
    ["P8 /onboarding (over-decoded)", `/onboarding?redirect=${enc(`/verify?source=extension&text=${CLAIM}`)}`, `/onboarding?redirect=${enc("/verify?source=extension")}`, "/verify?source=extension"],
    ["H3 login -> signup -> verify", `/login?redirect=${enc(`/signup?redirect=${enc(`/verify?text=${enc(CLAIM)}`)}`)}`, `/login?redirect=${enc(`/signup?redirect=${enc("/verify")}`)}`, "/signup?redirect=/verify" /* safeRedirect decodes once more (pre-existing) */],
  ] as const) {
    for (const mode of ["normal", "session-getter-throws"] as StorageMode[]) {
      it(`${label} (${mode}): stripped before any SDK initializes; no telemetry request (incl. tunnelled Sentry) and no later request URL carries it`, async () => {
        const run = await open(path, mode);
        try {
          const href = await run.page.evaluate(() => location.href);
          expect(href).toBe(`${BASE}${clean}`);
          if (landing) {
            const u = new URL(href);
            expect(safeRedirect(u.searchParams.get("redirect") || u.searchParams.get("next"), "/")).toBe(landing);
          }
          await run.page.waitForTimeout(7_000);
          await run.save();
          const all = await assertContained(run);
          expect(all.some((r) => r.url.includes("/ingest/flags"))).toBe(false); // structural hardening: PostHog /flags is disabled
          expect(leakList(requestsContaining(all.filter(isTelemetry), SENTINEL))).toEqual([]);
          // Server-visible URL (documented residual): the document request and the Referer of the parser-loaded
          // first-party assets carry it. Next 14 also keeps search params in the page segment of its router tree, which
          // it sends back to OUR origin in the `Next-Router-State-Tree` header — recorded, not asserted (see PR body).
          const firstPartyUrlLeaks = all.filter((r) => r.kind !== "document" && r.decision === "app" && safeDecode(r.url).includes(SENTINEL));
          expect(leakList(firstPartyUrlLeaks)).toEqual([]);
          const treeHeader = all.filter((r) => Object.entries(r.headers).some(([k, v]) => k.toLowerCase() === "next-router-state-tree" && safeDecode(v).includes(SENTINEL)));
          // eslint-disable-next-line no-console
          console.log(`[next harness] ${label} (${mode}): Next-Router-State-Tree header carrying the legacy param on ${treeHeader.length} first-party request(s)`);
        } finally {
          await run.close();
        }
      });
    }
  }

  // GHSA-655j-5f43-92pw — the workspace invitation acceptance credential. Real build: real instrumentation-client
  // ordering, real hydration, real AcceptInvitationClient, real posthog-js persistence, Sentry Replay forced on.
  const INV_TOKEN = "ZQX7INVITETOKENSENTINEL";
  const INV_ID = "inv_ZQX7SYNTHETIC";
  const ACCEPT = "/workspace-invitations/accept";
  const browserState = (page: Page) =>
    page.evaluate(() => {
      const dumpStore = (s: Storage) => {
        let out = "";
        for (let i = 0; i < s.length; i++) out += `${s.key(i)}=${s.getItem(s.key(i)!)};`;
        return out;
      };
      const safe = (f: () => string) => {
        try {
          return f();
        } catch (e) {
          return `<blocked:${(e as Error).name}>`;
        }
      };
      return {
        href: location.href,
        origin: location.origin,
        local: safe(() => dumpStore(window.localStorage)),
        session: safe(() => dumpStore(window.sessionStorage)),
        historyState: safe(() => JSON.stringify(history.state)),
        referrer: document.referrer,
      };
    }).then(async (s) => ({ ...s, cookie: JSON.stringify(await page.context().cookies()) })); // every cookie, incl. HttpOnly
  for (const mode of ["normal", "session-getter-throws"] as StorageMode[]) {
    it(`invitation acceptance link (${mode}): the document never initializes telemetry; credential in no request, cookie, localStorage or history entry`, async () => {
      const run = await open(`${ACCEPT}#invitationId=${INV_ID}&token=${INV_TOKEN}`, mode);
      try {
        const atLoad = await browserState(run.page);
        expect(atLoad.href).toBe(`${BASE}${ACCEPT}`);
        // Signed out (no Firebase in the harness): the page must still have RECEIVED the credential (positive control:
        // on the pre-existing continuity path it lands in the existing sessionStorage envelope), then go to the static login URL.
        if (mode === "normal") await run.page.waitForURL(/\/login\?redirect=/, { timeout: 20_000 });
        else await run.page.waitForTimeout(6_000); // PRE-EXISTING: the page reads window.sessionStorage directly and cannot proceed when site data is blocked
        await run.page.waitForTimeout(6_000); // well past both SDKs' init + first flush in every other test
        const afterRedirect = await browserState(run.page);
        // The acceptance-link DOCUMENT never initializes telemetry — also after its client-side redirect to /login: no
        // Sentry tunnel request, no PostHog request, no PostHog persistence. (The navigation timing entry keeps the
        // original URL for the document's lifetime; no SDK may run in it.)
        await run.save();
        const inAcceptanceDocument = await run.all();
        expect(leakList(inAcceptanceDocument.filter(isTelemetry))).toEqual([]);
        expect(afterRedirect.local).not.toMatch(/(^|;)ph_/);
        expect(await run.page.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceEntry | undefined)?.name ?? "")).toContain(INV_TOKEN); // why: the entry is immutable
        if (mode === "normal") {
          expect(afterRedirect.href).toBe(`${BASE}/login?redirect=${enc(ACCEPT)}`);
          expect(afterRedirect.session).toContain("convergepanel.invitationAcceptance.v1=");
          expect(afterRedirect.session).toContain(INV_TOKEN);
          // The ONLY place it may exist: that pre-existing, tab-scoped envelope.
          expect(afterRedirect.session.replace(/convergepanel\.invitationAcceptance\.v1=[^;]*;/, "")).not.toContain(INV_TOKEN);
        }
        // Back/forward: the credential-bearing entry no longer exists (replaced before any SDK initialized; the redirect to
        // /login is itself a replace). Back leaves the app (about:blank, the context's first entry); forward returns to a
        // clean URL — never to the credential-bearing one.
        await run.page.goBack();
        await run.page.waitForTimeout(1_000);
        const back = await run.page.evaluate(() => location.href);
        expect(back).toBe("about:blank");
        await run.page.goForward();
        await run.page.waitForTimeout(2_000);
        const forward = await browserState(run.page);
        expect(forward.href).toBe(mode === "normal" ? `${BASE}/login?redirect=${enc(ACCEPT)}` : `${BASE}${ACCEPT}`);
        for (const s of [atLoad, afterRedirect, forward]) {
          expect(s.origin).toBe(BASE); // every storage read below is a real read of the app origin, never a blocked stub
          expect(s.local).not.toMatch(/^<blocked/);
          expect(s.href).not.toContain(INV_TOKEN);
          expect(s.cookie).not.toContain(INV_TOKEN);
          expect(s.local).not.toContain(INV_TOKEN); // includes posthog-js persistence ($initial_person_info, session props)
          expect(s.historyState).not.toContain(INV_TOKEN);
          expect(s.referrer).not.toContain(INV_TOKEN);
        }
        await run.page.waitForTimeout(6_000);
        await run.save();
        const all = await assertContained(run);
        // Every request at both layers — URL, every header (Cookie, Referer, Next-Router-State-Tree) and decoded body,
        // telemetry or first-party — is free of the credential. The document request never carries a fragment.
        expect(leakList(requestsContaining(all, INV_TOKEN))).toEqual([]);
        expect(leakList(requestsContaining(all, INV_ID))).toEqual([]);
      } finally {
        await run.close();
      }
    });
  }

  // Correction round (owner decision on review R2 MINOR-1 / MINOR-2).
  const ENVELOPE_KEY = "convergepanel.invitationAcceptance.v1";
  const INV_TOKEN2 = "ZQX7SECONDINVITETOKEN";
  const INV_ID2 = "inv_ZQX7SECONDSYNTH";
  const navName = (page: Page) => page.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceEntry | undefined)?.name ?? "");
  const telemetryDuring = async (run: Awaited<ReturnType<typeof open>>, from: { network: number; saved: number }) => (await run.since(from)).filter(isTelemetry);
  /** The acceptance POST exactly as AcceptInvitationClient sends it after restoring the envelope (signed-in branch; no Firebase in the harness). */
  const acceptancePost = (page: Page) =>
    page.evaluate(async (key) => {
      const env = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (!env) return "no-envelope";
      const res = await fetch(`/api/workspace-invitations/${encodeURIComponent(env.invitationId)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ token: env.token }),
      });
      return String(res.status);
    }, ENVELOPE_KEY);

  it("MINOR-1: invitation link → /login → full-page RELOAD with the envelope live → acceptance POST: that document never initializes telemetry; the credential reaches only the first-party POST; telemetry returns once the envelope is gone", async () => {
    const run = await open(`${ACCEPT}#invitationId=${INV_ID}&token=${INV_TOKEN}`, "normal");
    try {
      await run.page.route("**/api/workspace-invitations/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, workspaceId: "ws_ZQX7SYNTH", alreadyMember: false }) }));
      await run.page.waitForURL(/\/login\?redirect=/, { timeout: 20_000 });
      await run.page.waitForTimeout(2_000);
      await run.save();
      const before = await run.mark();
      await run.page.reload({ waitUntil: "load" });
      // A NEW document whose own URL is /login (navigation entry is clean) but whose tab holds the raw-token envelope.
      expect(await navName(run.page)).toBe(`${BASE}/login?redirect=${enc(ACCEPT)}`);
      expect((await browserState(run.page)).session).toContain(INV_TOKEN);
      await run.page.waitForTimeout(6_000);
      expect(await acceptancePost(run.page)).toBe("200");
      await run.page.waitForTimeout(6_000);
      await run.save();
      const reloadedTelemetry = await telemetryDuring(run, before);
      console.log(`[next harness] MINOR-1 reloaded /login document: ${reloadedTelemetry.length} telemetry request(s); carrying token: ${requestsContaining(reloadedTelemetry, INV_TOKEN).length}; carrying invitation id: ${requestsContaining(reloadedTelemetry, INV_ID).length}`);
      expect(leakList(reloadedTelemetry)).toEqual([]);
      expect((await browserState(run.page)).local).not.toMatch(/(^|;)ph_/);
      // Positive control: the credential DID travel — only in the one first-party acceptance POST body.
      const carrying = requestsContaining(await run.all(), INV_TOKEN);
      expect(carrying.map((r) => `${r.decision}:${new URL(r.url).pathname}`)).toEqual(expect.arrayContaining([`app:/api/workspace-invitations/${INV_ID}/accept`]));
      expect(carrying.filter((r) => !new URL(r.url).pathname.startsWith("/api/workspace-invitations/"))).toEqual([]);
      // Telemetry resumes: the page clears the envelope on success; the next clean full-page load is an ordinary document.
      await run.page.evaluate((key) => sessionStorage.removeItem(key), ENVELOPE_KEY);
      await run.save();
      const beforeClean = await run.mark();
      await run.page.goto(`${BASE}/pricing`, { waitUntil: "load" });
      await run.page.waitForTimeout(6_000);
      await run.save();
      const cleanTelemetry = await telemetryDuring(run, beforeClean);
      expect(cleanTelemetry.length).toBeGreaterThan(0);
      expect(requestsContaining(cleanTelemetry, INV_TOKEN)).toEqual([]);
      const all = await assertContained(run);
      expect(leakList(requestsContaining(all.filter(isTelemetry), INV_TOKEN))).toEqual([]);
      expect(leakList(requestsContaining(all.filter(isTelemetry), INV_ID))).toEqual([]);
    } finally {
      await run.close();
    }
  });

  for (const origin of ["acceptance", "ordinary"] as const) {
    it(`MINOR-2: a second invitation link by same-document fragment navigation (${origin} document) is carried to a fresh telemetry-free document, never dropped; neither credential reaches telemetry`, async () => {
      const run = await open(origin === "acceptance" ? ACCEPT : "/pricing", "normal");
      try {
        if (origin === "acceptance") {
          // No fragment, no envelope: the acceptance document shows 'Invitation unavailable' and stays on the path.
          await run.page.waitForSelector("text=Invitation unavailable", { timeout: 20_000 });
        } else {
          await run.page.waitForTimeout(6_000); // an ordinary, telemetry-ON document (both SDKs running)
          await run.save();
          expect((await run.all()).filter(isTelemetry).length).toBeGreaterThan(0);
          await run.page.evaluate((p) => history.replaceState(history.state, "", p), ACCEPT); // now on the acceptance path, same document
        }
        await run.page.evaluate(() => ((window as any).__cpFirstDocument = true)); // marks THIS document
        await run.save();
        // Same-document fragment navigation (as when a second link is opened in this tab).
        await run.page.evaluate((h) => {
          location.hash = h;
        }, `invitationId=${INV_ID2}&token=${INV_TOKEN2}`);
        // Signed out (no Firebase): the fresh document restores it and goes to sign-in with the SECOND credential in the envelope.
        await run.page.waitForURL(/\/login\?redirect=/, { timeout: 20_000 });
        expect(await run.page.evaluate(() => (window as any).__cpFirstDocument ?? false)).toBe(false); // a NEW document
        expect(await navName(run.page)).toBe(`${BASE}${ACCEPT}`); // a clean acceptance document (no fragment in its navigation entry)
        const state = await browserState(run.page);
        expect(state.session).toContain(INV_TOKEN2);
        expect(state.session).toContain(INV_ID2);
        expect(state.href).not.toContain(INV_TOKEN2);
        expect(state.historyState).not.toContain(INV_TOKEN2);
        await run.page.waitForTimeout(6_000);
        await run.save();
        const all = await assertContained(run);
        expect(leakList(requestsContaining(all, INV_TOKEN2))).toEqual([]);
        expect(leakList(requestsContaining(all, INV_ID2))).toEqual([]);
        await run.page.goBack();
        await run.page.waitForTimeout(1_500);
        expect(await run.page.evaluate(() => location.href)).not.toContain(INV_TOKEN2);
      } finally {
        await run.close();
      }
    });
  }

  it("review R3 MAJOR-1: an ordinary telemetry-on /login document restored from the back/forward cache after the invitation wrote the envelope never uses it with telemetry running", async () => {
    const run = await open(`/login?redirect=${enc(ACCEPT)}`, "normal", { bfcache: true });
    try {
      await run.page.route("**/api/workspace-invitations/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, workspaceId: "ws_ZQX7SYNTH", alreadyMember: false }) }));
      await run.page.evaluate(() => {
        (window as any).__cpLoginDocument = true;
        addEventListener("pageshow", (e) => ((window as any).__cpRestoredFromCache = (e as PageTransitionEvent).persisted));
      });
      await run.page.waitForTimeout(6_000); // L: an ordinary document, both SDKs running
      await run.save();
      expect((await run.all()).filter(isTelemetry).length).toBeGreaterThan(0);
      // Same tab: the invitation link (new, telemetry-free document Y) writes the envelope and soft-redirects to /login.
      // HARNESS LIMITATION (observed, R3): while L is frozen into the back/forward cache, one of L's own Sentry tunnel
      // requests escapes Playwright's request routing, reaches the local app server, and the server's tunnel forward is
      // refused by the egress guard (nothing leaves the machine). It is L's telemetry from BEFORE the invitation link
      // was opened in this tab, so it cannot carry the credential. Those refused entries are checked and set aside here
      // (host must be the Sentry ingest host); containment stays strict for everything after.
      const guardBefore = guardAttempts().length;
      await run.page.goto(`${BASE}${ACCEPT}#invitationId=${INV_ID}&token=${INV_TOKEN}`, { waitUntil: "load" });
      await run.page.waitForURL(/\/login\?redirect=/, { timeout: 20_000 });
      await run.page.waitForTimeout(2_000);
      const escaped = guardAttempts().slice(guardBefore);
      expect(escaped.every((line) => JSON.parse(line).host === "o1.ingest.sentry.io")).toBe(true);
      // Review R4 MINOR-2: each set-aside entry must predate the moment the invitation document finished downloading
      // its FIRST script file: no telemetry code of that document (it has no inline SDK code) can have run before
      // then, so the entry can only come from L. The server logs the attempt after the browser sent the request.
      // Review R5 NIT-1: the bound is taken from the invitation document itself (its navigation entry).
      expect(await navName(run.page)).toBe(`${BASE}${ACCEPT}#invitationId=${INV_ID}&token=${INV_TOKEN}`);
      const firstScriptReady = await run.page.evaluate(() => {
        const ends = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((e) => e.initiatorType === "script").map((e) => e.responseEnd);
        return ends.length > 0 ? performance.timeOrigin + Math.min(...ends) : 0;
      });
      console.log(`[next harness] R3 MAJOR-1: set-aside timing margin(s) ms: ${escaped.map((l) => Math.round(firstScriptReady - Date.parse(JSON.parse(l).at))).join(",") || "n/a"}`);
      for (const line of escaped) expect(Date.parse(JSON.parse(line).at)).toBeLessThan(firstScriptReady);
      if (escaped.length > 0) {
        console.log(`[next harness] R3 MAJOR-1: ${escaped.length} pre-invitation tunnel request(s) from the frozen /login document refused by the server egress guard (set aside)`);
        // Review R5 MINOR-2: remove exactly the lines checked above (once each); anything appended since stays.
        // Review R6 NIT-2: a checked line that is no longer in the log fails the test explicitly (never splice(-1)), and
        // the rewrite is refused if the server appended to the log between the read and the write (nothing is lost).
        const snapshot = readFileSync(guardLog, "utf8");
        const remaining = snapshot.split("\n").filter(Boolean);
        for (const line of escaped) {
          const at = remaining.indexOf(line);
          if (at < 0) throw new Error(`set-aside: a checked egress-guard entry is missing from the log: ${line}`);
          remaining.splice(at, 1);
        }
        if (readFileSync(guardLog, "utf8") !== snapshot) throw new Error("set-aside: the egress-guard log changed while it was being rewritten");
        writeFileSync(guardLog, remaining.map((l) => `${l}\n`).join(""));
      }
      await run.save();
      const before = await run.mark();
      // Back → L. Without the guard, L is restored from the cache WITH telemetry running and the envelope present.
      await run.page.goBack({ waitUntil: "commit" }); // a cache restore fires no load event
      await run.page.waitForTimeout(3_000);
      const restoredLiveDocument = await run.page.evaluate(() => (window as any).__cpLoginDocument === true);
      await run.save();
      const fresh = await run.mark(); // from here on: the fresh document only
      console.log(`[next harness] R3 MAJOR-1: after Back the telemetry-on /login document is ${restoredLiveDocument ? "STILL LIVE (restored from the cache)" : "gone (fresh document)"}`);
      expect(restoredLiveDocument).toBe(false);
      expect((await browserState(run.page)).session).toContain(INV_TOKEN); // the envelope is intact for the page
      // After sign-in the login page soft-navigates to the acceptance page; then the acceptance POST; then an error (flushes Sentry).
      await run.page.evaluate((p) => (window as any).next?.router?.push(p), ACCEPT);
      await run.page.waitForTimeout(3_000);
      await acceptancePost(run.page);
      await run.page.evaluate(() => setTimeout(() => { throw new Error("zqx7 harness probe"); }, 0));
      await run.page.waitForTimeout(6_000);
      await run.save();
      // Everything after Back: only the restored document's own unload flush (queued before the invitation existed)
      // may appear, and it carries neither part of the credential. The fresh document after it sends nothing.
      const afterBack = await telemetryDuring(run, before);
      console.log(`[next harness] R3 MAJOR-1: ${afterBack.length} telemetry request(s) after Back (unload flush of the restored document)`);
      expect(leakList(requestsContaining(afterBack, INV_TOKEN))).toEqual([]);
      expect(leakList(requestsContaining(afterBack, INV_ID))).toEqual([]);
      expect(leakList(await telemetryDuring(run, fresh))).toEqual([]);
      const all = await assertContained(run);
      expect(leakList(requestsContaining(all.filter(isTelemetry), INV_TOKEN))).toEqual([]);
      expect(leakList(requestsContaining(all.filter(isTelemetry), INV_ID))).toEqual([]);
    } finally {
      await run.close();
    }
  });

  it("NIT-1: a non-canonical acceptance URL (percent-encoded path) fails closed: no credential hand-off, no telemetry in that document, the credential in no request", async () => {
    const run = await open(`/workspace-invitations/%61ccept#invitationId=${INV_ID}&token=${INV_TOKEN}`, "normal");
    try {
      await run.page.waitForTimeout(8_000);
      const state = await browserState(run.page);
      expect(state.href).not.toContain(INV_TOKEN);
      expect(state.session).not.toContain(INV_TOKEN); // never accepted from a non-canonical URL
      expect(await navName(run.page)).toContain(INV_TOKEN); // why: the immutable entry still holds it
      await run.save();
      const all = await assertContained(run);
      expect(leakList(all.filter(isTelemetry))).toEqual([]);
      expect(leakList(requestsContaining(all, INV_TOKEN))).toEqual([]);
      expect(leakList(requestsContaining(all, INV_ID))).toEqual([]);
    } finally {
      await run.close();
    }
  });

  // Review R6 (MINOR-1 / MINOR-2): rewritten, malformed and over-encoded invitation links. Each document must start
  // WITHOUT telemetry (the classifier fails closed), must never accept the credential (detection is not acceptance),
  // and no telemetry request may carry it. Then a clean full load restores telemetry.
  const R6_CRED = `invitationId=${INV_ID}&token=${INV_TOKEN}`;
  const layers = (v: string, n: number) => {
    for (let i = 0; i < n; i++) v = encodeURIComponent(v);
    return v;
  };
  const r6Links: Array<[string, string]> = [
    ["`#` rewritten to %23: the credential is in the PATH", `${ACCEPT}%23${layers(R6_CRED, 1)}`],
    ["stray `%` plus an encoded credential fragment (non-canonical path)", `/workspace-invitations/%61ccept#${layers(R6_CRED, 1)}%`],
    ["credential fragment encoded 4 times (beyond the former 3-layer limit)", `/workspace-invitations/%61ccept#${layers(R6_CRED, 4)}`],
    ["credential in the QUERY on a non-canonical path", `/workspace-invitations/%61ccept?${R6_CRED}`],
    ["credential in the QUERY on an ordinary route", `/pricing?${R6_CRED}`],
  ];
  for (const [name, link] of r6Links) {
    it(`R6: ${name} → that document never initializes telemetry, nothing is accepted, no telemetry request carries the credential; a clean load restores telemetry`, async () => {
      const run = await open(link, "normal");
      try {
        expect(await navName(run.page)).toContain(INV_TOKEN); // the immutable entry holds it: the reason for the gate
        await run.page.waitForTimeout(8_000);
        await run.save();
        const inDocument = (await run.all()).filter(isTelemetry);
        console.log(`[next harness] R6 ${name}: ${inDocument.length} telemetry request(s); carrying token: ${requestsContaining(inDocument, INV_TOKEN).length}`);
        expect(leakList(inDocument)).toEqual([]);
        const state = await browserState(run.page);
        expect(state.session).not.toContain(INV_TOKEN); // never accepted / carried from a rewritten link
        expect(state.local).not.toContain(INV_TOKEN);
        expect(state.cookie).not.toContain(INV_TOKEN);
        // Restoration: a demonstrably clean new document (no envelope, clean navigation entry) runs telemetry again.
        const beforeClean = await run.mark();
        await run.page.goto(`${BASE}/pricing`, { waitUntil: "load" });
        expect(await navName(run.page)).toBe(`${BASE}/pricing`);
        await run.page.waitForTimeout(6_000);
        await run.save();
        const clean = await telemetryDuring(run, beforeClean);
        expect(clean.length).toBeGreaterThan(0);
        const all = await assertContained(run);
        expect(leakList(requestsContaining(all.filter(isTelemetry), INV_TOKEN))).toEqual([]);
        expect(leakList(requestsContaining(all.filter(isTelemetry), INV_ID))).toEqual([]);
      } finally {
        await run.close();
      }
    });
  }

  it("R6 MINOR-3: invitation A's page logic, released after a second link B took over the tab, cannot restore A or clear B; the fresh document carries B only", async () => {
    const run = await open("/pricing", "normal");
    const step = (m: string) => console.log(`[next harness] R6 MINOR-3 step: ${m}`);
    let releaseChunk: () => void = () => undefined;
    let releaseSuccessor: () => void = () => undefined;
    try {
      // Hold the acceptance page's own code (React page chunk) so the FIRST acceptance document's page logic for A runs
      // only after B has been handed off; hold the successor document's request so A's logic gets to run at all.
      const chunkHeld = new Promise<void>((r) => (releaseChunk = r));
      const successorHeld = new Promise<void>((r) => (releaseSuccessor = r));
      let documents = 0;
      let chunkSeen = false;
      await run.page.route(/\/_next\/static\/chunks\/app\/workspace-invitations\/accept\/page-[^/]+\.js/, async (route) => {
        chunkSeen = true;
        await chunkHeld;
        await route.fallback();
      });
      await run.page.route((u) => u.pathname === ACCEPT, async (route) => {
        if (route.request().resourceType() === "document" && ++documents === 2) await successorHeld;
        await route.fallback();
      });
      step("routes installed");
      await run.page.goto(`${BASE}${ACCEPT}#invitationId=${INV_ID}&token=${INV_TOKEN}`, { waitUntil: "commit" });
      step("document A committed");
      // The pre-SDK scrub has run (fragment gone) while the page chunk is still held.
      await run.page.waitForFunction(() => location.hash === "" && location.pathname === "/workspace-invitations/accept", null, { timeout: 20_000 });
      step(`scrub ran; chunk held: ${chunkSeen}`);
      expect(chunkSeen).toBe(true);
      // What each new document sees in this tab's sessionStorage at its very start (before any page script).
      await run.page.addInitScript((key) => {
        (window as any).__cpEnvelopeAtStart = sessionStorage.getItem(key) ?? "";
      }, ENVELOPE_KEY);
      // Second link B in the same tab (same-document fragment navigation). The guard hands off and requests the
      // successor document, which is held; nothing is evaluated in the page while that navigation is pending.
      await run.page.evaluate((h) => {
        location.hash = h;
      }, `invitationId=${INV_ID2}&token=${INV_TOKEN2}`);
      const deadline = Date.now() + 10_000;
      while (documents < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      step(`second link set; documents requested: ${documents}`);
      expect(documents).toBe(2); // the guard handed off and the successor document has been requested (held)
      // Now release A's page logic in the still-live first document; it holds the in-memory credential A.
      releaseChunk();
      await new Promise((r) => setTimeout(r, 5_000));
      step("A's page logic released and given 5 s");
      releaseSuccessor();
      step("successor released");
      await run.page.waitForURL(/\/login\?redirect=/, { timeout: 20_000 });
      await run.page.waitForTimeout(2_000);
      const atStart = String(await run.page.evaluate(() => (window as any).__cpEnvelopeAtStart ?? ""));
      console.log(`[next harness] R6 MINOR-3: successor document started with envelope holding A: ${atStart.includes(INV_TOKEN)}, B: ${atStart.includes(INV_TOKEN2)}`);
      expect(atStart).toContain(INV_TOKEN2); // B survived A's late page logic
      expect(atStart).not.toContain(INV_TOKEN);
      expect(await navName(run.page)).not.toContain(INV_TOKEN2);
      const final = await browserState(run.page);
      expect(final.session).toContain(INV_TOKEN2);
      expect(final.session).not.toContain(INV_TOKEN);
      await run.page.waitForTimeout(4_000);
      await run.save();
      const all = await assertContained(run);
      for (const needle of [INV_TOKEN, INV_ID, INV_TOKEN2, INV_ID2]) expect(leakList(requestsContaining(all.filter(isTelemetry), needle))).toEqual([]);
    } finally {
      releaseChunk();
      releaseSuccessor();
      await run.close();
    }
  });

  // Review R7 F1 / F2: key-less token-shaped material and mangled credential keys. Same contract as the R6 cases.
  const TOK43 = "ZQX7keylessSentinelAbCdEfGhIjKlMnOpQrSt0123"; // the real token format: 43 base64url characters
  if (!/^[A-Za-z0-9_-]{43}$/.test(TOK43)) throw new Error("TOK43 must be a 43-character base64url sentinel");
  const pctAll = (v: string) => v.split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()).join("");
  const fullyDecoded = (v: string) => {
    for (let i = 0; i < 8; i++) {
      const n = safeDecode(v);
      if (n === v) break;
      v = n;
    }
    return v;
  };
  const r7Links: Array<[string, string, string]> = [
    ["key-less token as a path segment", `/pricing/${TOK43}`, TOK43],
    ["key-less token as a bare query component", `/pricing?${TOK43}`, TOK43],
    ["key-less token as a bare query component after another", `/pricing?a=1&${TOK43}`, TOK43],
    ["fully percent-encoded key-less token in the query", `/pricing?${pctAll(TOK43)}`, TOK43],
    ["key-less token after an encoded slash", `/pricing%2F${TOK43}`, TOK43],
    ["fullwidth = (as Chromium encodes it)", `/pricing?invitationId%EF%BC%9D${INV_ID}&token%EF%BC%9D${INV_TOKEN}`, INV_TOKEN],
    ["overlong encoded =", `/pricing?token%C0%BD${INV_TOKEN}`, INV_TOKEN],
    ["Cyrillic letter in the key", `/pricing?t%D0%BEken=${INV_TOKEN}`, INV_TOKEN],
    ["NUL inside the key", `/pricing?t%00oken=${INV_TOKEN}`, INV_TOKEN],
    ["colon separator", `/pricing?token:${INV_TOKEN}`, INV_TOKEN],
  ];
  for (const [name, link, needle] of r7Links) {
    it(`R7: ${name} → that document never initializes telemetry; nothing accepted or persisted; a clean load restores telemetry`, async () => {
      const run = await open(link, "normal");
      try {
        expect(fullyDecoded(await navName(run.page))).toContain(needle); // the immutable entry holds it
        await run.page.waitForTimeout(8_000);
        await run.save();
        const inDocument = (await run.all()).filter(isTelemetry);
        console.log(`[next harness] R7 ${name}: ${inDocument.length} telemetry request(s); carrying it: ${requestsContaining(inDocument, needle).length}`);
        expect(leakList(inDocument)).toEqual([]);
        const state = await browserState(run.page);
        for (const v of [state.session, state.local, state.cookie]) expect(fullyDecoded(v)).not.toContain(needle);
        // When the token IS the document's path, Next's own history.state mirrors that path (exactly like the address bar
        // and the browser history entry); no client code can remove it without rewriting the route. Anywhere else it must
        // not appear. This is recorded, not hidden; it is not a telemetry channel (no SDK runs in this document).
        const pathHoldsIt = fullyDecoded(new URL(state.href).pathname).includes(needle);
        if (pathHoldsIt) console.log(`[next harness] R7 ${name}: token is the URL path; history.state mirrors the path: ${fullyDecoded(state.historyState).includes(needle)}`);
        else expect(fullyDecoded(state.historyState)).not.toContain(needle);
        const beforeClean = await run.mark();
        await run.page.goto(`${BASE}/pricing`, { waitUntil: "load" });
        await run.page.waitForTimeout(6_000);
        await run.save();
        expect((await telemetryDuring(run, beforeClean)).length).toBeGreaterThan(0);
        const all = await assertContained(run);
        expect(leakList(requestsContaining(all.filter(isTelemetry), needle))).toEqual([]);
      } finally {
        await run.close();
      }
    });
  }

  for (const [name, link] of [
    ["43 token characters inside a longer identifier", `/pricing?ref=${TOK43}xyz`],
    ["a 43-character lower-case slug", "/pricing?slug=how-to-compare-answers-from-many-llms-fast"],
  ] as const) {
    it(`R7 benign control: ${name} → an ordinary document: telemetry runs`, async () => {
      const run = await open(link, "normal");
      try {
        await run.page.waitForTimeout(6_000);
        await run.save();
        expect((await run.all()).filter(isTelemetry).length).toBeGreaterThan(0);
        await assertContained(run);
      } finally {
        await run.close();
      }
    });
  }

  it("R7 F4: an envelope-restore acceptance document whose page code loads only after a second link B took over shows no 'Invitation unavailable' and changes nothing; the fresh document carries B", async () => {
    const run = await open(`${ACCEPT}#invitationId=${INV_ID}&token=${INV_TOKEN}`, "normal");
    let releaseChunk: () => void = () => undefined;
    let releaseSuccessor: () => void = () => undefined;
    try {
      await run.page.waitForURL(/\/login\?redirect=/, { timeout: 20_000 }); // envelope A written (signed out)
      // Every document records, in this tab's storage (survives into the next document), whether it ever rendered the
      // 'Invitation unavailable' view, and what the envelope held at its start.
      await run.page.addInitScript(() => {
        (window as any).__cpEnvelopeAtStart = sessionStorage.getItem("convergepanel.invitationAcceptance.v1") ?? "";
        const watch = () => {
          if ((document.body?.innerText ?? "").includes("Invitation unavailable")) sessionStorage.setItem("cp.harness.sawUnavailable", location.pathname);
        };
        new MutationObserver(watch).observe(document, { subtree: true, childList: true, characterData: true });
      });
      const chunkHeld = new Promise<void>((r) => (releaseChunk = r));
      const successorHeld = new Promise<void>((r) => (releaseSuccessor = r));
      let documents = 0;
      await run.page.route(/\/_next\/static\/chunks\/app\/workspace-invitations\/accept\/page-[^/]+\.js/, async (route) => {
        await chunkHeld;
        await route.fallback();
      });
      await run.page.route((u) => u.pathname === ACCEPT, async (route) => {
        if (route.request().resourceType() === "document" && ++documents === 2) await successorHeld;
        await route.fallback();
      });
      await run.page.goto(`${BASE}${ACCEPT}`, { waitUntil: "commit" }); // envelope-restore document, page code held
      await run.page.waitForFunction(() => performance.getEntriesByType("resource").some((e) => /main-app/.test(e.name)), null, { timeout: 20_000 });
      await run.page.waitForTimeout(1_000); // the pre-SDK guard is installed (main-app ran)
      await run.page.evaluate((h) => {
        location.hash = h;
      }, `invitationId=${INV_ID2}&token=${INV_TOKEN2}`);
      const deadline = Date.now() + 10_000;
      while (documents < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(documents).toBe(2); // handed off; successor held
      releaseChunk(); // the superseded document's page mounts late
      await new Promise((r) => setTimeout(r, 5_000));
      releaseSuccessor();
      await run.page.waitForURL(/\/login\?redirect=/, { timeout: 20_000 });
      await run.page.waitForTimeout(2_000);
      const saw = await run.page.evaluate(() => sessionStorage.getItem("cp.harness.sawUnavailable"));
      const atStart = String(await run.page.evaluate(() => (window as any).__cpEnvelopeAtStart ?? ""));
      console.log(`[next harness] R7 F4: superseded document rendered 'Invitation unavailable': ${saw !== null}; successor started with B: ${atStart.includes(INV_TOKEN2)}, A: ${atStart.includes(INV_TOKEN)}`);
      expect(saw).toBeNull();
      expect(atStart).toContain(INV_TOKEN2);
      expect(atStart).not.toContain(INV_TOKEN);
      await run.page.waitForTimeout(4_000);
      await run.save();
      const all = await assertContained(run);
      for (const needle of [INV_TOKEN, INV_ID, INV_TOKEN2, INV_ID2]) expect(leakList(requestsContaining(all.filter(isTelemetry), needle))).toEqual([]);
    } finally {
      releaseChunk();
      releaseSuccessor();
      await run.close();
    }
  });

  it("positive control: Sentry traffic went through the /monitoring tunnel and was answered locally; the server guard log is empty", () => {
    const tunnel = allObserved.filter((r) => r.decision === "sentry-tunnel");
    expect(tunnel.length).toBeGreaterThan(0);
    expect(tunnel.some((r) => r.bodies.some((b) => b.includes("replay_event") || b.includes("replay_recording")))).toBe(true);
    expect(allObserved.filter((r) => /^(https?|wss?):/i.test(r.url) && !isLoopbackUrl(r.url))).toEqual([]);
    expect(guardAttempts()).toEqual([]);
  });
});

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
