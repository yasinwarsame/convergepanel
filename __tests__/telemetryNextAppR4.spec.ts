/**
 * PR #329 R4 (owner A1/A3) — the telemetry URL invariant against the REAL
 * Next.js production build: real `instrumentation-client.ts` ordering (Sentry's
 * plugin prepends it to `main-app`), real hydration, real app router (soft
 * navigation, `router.refresh()`, back/forward restore), real /verify page, real
 * posthog-js and Sentry.
 *
 * Opt-in (needs a running production server, so it is skipped otherwise):
 *   NEXT_PUBLIC_POSTHOG_KEY=phc_synthetic NEXT_PUBLIC_SENTRY_DSN=https://<32 hex>@o1.ingest.sentry.io/1 npx next build
 *   npx next start -p 3999
 *   CP_NEXT_HARNESS_BASE=http://localhost:3999 npx jest __tests__/telemetryNextAppR4.spec.ts
 * Every request leaving the page is recorded (network layer incl. headers and
 * decoded bodies, plus in-page fetch/XHR/sendBeacon/image wrappers). PostHog
 * (`/ingest/*`) and Sentry are answered locally; every other non-app request is
 * aborted (nothing leaves the machine). Synthetic sentinels only.
 */
import { chromium, type Browser, type Page, type Request } from "playwright";
import { chromiumAvailable, decodeBodies, initScript, isSentryRequest, requestsContaining, type RecordedRequest, type StorageMode } from "./helpers/telemetryBrowserHarness";

jest.setTimeout(180_000);

const BASE = process.env.CP_NEXT_HARNESS_BASE ?? "";
const SENTINEL = "ZQX7NEXTSENTINEL";
const CLAIM = `the moon is hollow ${SENTINEL} & tides obey wind farms`;
const UTM = "utm_source=newsletter&utm_campaign=Spring%20Sale";
const d = BASE && chromiumAvailable() ? describe : describe.skip;

let browser: Browser | null = null;
afterAll(async () => {
  if (browser) await browser.close();
});

async function open(path: string, mode: StorageMode) {
  if (!browser) browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  const network: RecordedRequest[] = [];
  const pending: Promise<void>[] = [];
  const saved: RecordedRequest[] = [];
  context.on("request", (req: Request) => {
    pending.push(
      (async () => {
        let headers: Record<string, string> = {};
        try {
          headers = await req.allHeaders();
        } catch {
          headers = req.headers();
        }
        network.push({ layer: "network", kind: req.resourceType(), url: req.url(), headers, bodies: decodeBodies(req.postDataBuffer()) });
      })()
    );
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(BASE).origin) {
      if (url.pathname.startsWith("/ingest/flags") || url.pathname.startsWith("/ingest/decide")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ featureFlags: {}, featureFlagPayloads: {}, flags: {} }) });
      }
      if (url.pathname.startsWith("/ingest/")) return route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' });
      return route.continue();
    }
    if (url.hostname.endsWith(".sentry.io")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    return route.abort();
  });
  await context.addInitScript(initScript(mode));
  const page = await context.newPage();
  await page.goto(BASE + path, { waitUntil: "load" });
  const pageRecords = async (p: Page) => {
    try {
      const recs: Array<{ kind: string; url: string; body: string }> = await p.evaluate(() => (window as any).__cpRequests ?? []);
      return recs.map((r) => ({ layer: "page" as const, kind: r.kind, url: r.url, headers: {}, bodies: r.body ? [r.body] : [] }));
    } catch {
      return [];
    }
  };
  return {
    page,
    save: async () => {
      saved.push(...(await pageRecords(page)));
    },
    all: async () => {
      await Promise.all(pending);
      return [...network, ...saved, ...(await pageRecords(page))];
    },
    close: () => context.close(),
  };
}

async function textareaValue(page: Page): Promise<string> {
  await page.waitForSelector("#verify-text:not([disabled])", { timeout: 20_000 });
  return page.$eval("#verify-text", (el) => (el as HTMLTextAreaElement).value);
}
const leakList = (reqs: RecordedRequest[]) => reqs.map((r) => `${r.layer}:${r.kind} ${r.url.slice(0, 160)}`);

d("real Next.js production build", () => {
  it("extension #text= (sessionStorage working): clean before init; router refresh / soft nav / back never restore it; reload keeps the text", async () => {
    const run = await open(`/verify?source=extension&${UTM}#text=${encodeURIComponent(CLAIM)}`, "normal");
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
      await run.page.waitForTimeout(4_000);
      const all = await run.all();
      expect(all.some((r) => r.url.includes("/ingest/flags"))).toBe(true);
      // (Sentry sends only sampled traces / replays here — tracesSampleRate 0.1 — so its requests are checked when present.)
      expect(all.some((r) => r.url.includes("/ingest/e"))).toBe(true);
      expect(leakList(requestsContaining(all, SENTINEL))).toEqual([]);
    } finally {
      await run.close();
    }
  });

  for (const mode of ["session-getter-throws", "session-setitem-throws"] as StorageMode[]) {
    it(`extension #text= (${mode}): URL clean, text shown from memory with the notice; after reload gone + notice; no request carries it`, async () => {
      const run = await open(`/verify?source=extension&${UTM}#text=${encodeURIComponent(CLAIM)}`, mode);
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
        const all = await run.all();
        expect(all.some((r) => r.url.includes("/ingest/flags"))).toBe(true);
        expect(leakList(requestsContaining(all, SENTINEL))).toEqual([]);
      } finally {
        await run.close();
      }
    });
  }

  for (const [label, path, clean] of [
    ["/verify?text=", `/verify?source=extension&text=${encodeURIComponent(CLAIM)}&${UTM}`, `/verify?source=extension&${UTM}`],
    ["/?tab=verify&claim=", `/?tab=verify&claim=${encodeURIComponent(CLAIM)}&${UTM}`, `/?tab=verify&${UTM}`],
    ["/?tab=research&q=", `/?tab=research&q=${encodeURIComponent(CLAIM)}&${UTM}`, `/?tab=research&${UTM}`],
  ] as const) {
    for (const mode of ["normal", "session-getter-throws"] as StorageMode[]) {
      it(`legacy ${label} (${mode}): stripped before any SDK initializes; no telemetry request and no later request URL carries it`, async () => {
        const run = await open(path, mode);
        try {
          const href = await run.page.evaluate(() => location.href);
          expect(href.startsWith(`${BASE}${clean}`)).toBe(true);
          await run.page.waitForTimeout(5_000);
          const all = await run.all();
          expect(all.some((r) => r.url.includes("/ingest/flags"))).toBe(true);
          const telemetry = all.filter((r) => r.url.includes("/ingest/") || isSentryRequest(r));
          expect(leakList(requestsContaining(telemetry, SENTINEL))).toEqual([]);
          // Server-visible legacy URL (documented residual): the document request and the Referer of the parser-loaded
          // first-party assets carry it. Next 14 also keeps search params in the page segment of its router tree, which
          // it sends back to OUR origin in the `Next-Router-State-Tree` header — recorded, not asserted (see PR body).
          const firstPartyUrlLeaks = all.filter((r) => r.kind !== "document" && !r.url.includes("/ingest/") && safeDecode(r.url).includes(SENTINEL));
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
});

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
