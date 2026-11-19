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
 *   NEXT_PUBLIC_POSTHOG_KEY=phc_synthetic NEXT_PUBLIC_SENTRY_DSN=https://<32 hex>@o1.ingest.sentry.io/1 next build
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
});

afterAll(async () => {
  if (browser) await browser.close();
  if (server) server.kill("SIGTERM");
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function open(path: string, mode: StorageMode) {
  if (!browser) browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
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
      expect(all.some((r) => r.url.includes("/ingest/flags"))).toBe(true);
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
        expect(all.some((r) => r.url.includes("/ingest/flags"))).toBe(true);
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
          expect(all.some((r) => r.url.includes("/ingest/flags"))).toBe(true);
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
