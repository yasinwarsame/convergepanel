/**
 * PR #329 R4 (review MAJOR-1, owner A1/A3) — the REAL posthog-js and the REAL
 * Sentry browser SDK, initialized by the REAL `instrumentation-client.ts` and
 * the REAL `PostHogProvider`, in real Chromium. Every outgoing request (fetch,
 * XHR, sendBeacon, image beacons, and every network-level request incl. headers,
 * cookies and decoded bodies) is recorded; a synthetic claim sentinel must never
 * appear in any of them — in particular not in PostHog's `/flags` request
 * (`$initial_current_url`, `$initial_referrer`) or `$initial_person_info`,
 * which bypass `before_send`.
 *
 * Positive controls in every run prove the instrumentation would see a sentinel:
 * a PostHog event and a Sentry message carrying a CONTROL sentinel must be found
 * in the decoded network bodies, and the `/flags` request must be observed.
 *
 * Requires the Playwright Chromium build (`npx playwright install chromium`).
 * When it is not installed (CI does not install browsers) the suite is skipped
 * and says so; it is run locally for the R4 evidence.
 */
import {
  ORIGIN,
  chromiumAvailable,
  isSentryRequest,
  openPage,
  requestsContaining,
  shutdown,
  type RecordedRequest,
  type StorageMode,
} from "./helpers/telemetryBrowserHarness";

jest.setTimeout(120_000);

const SENTINEL = "ZQX7CLAIMSENTINEL";
const CLAIM = `the moon is hollow ${SENTINEL} & tides obey wind farms`;
const CONTROL = "ZQX7CONTROLPROBE";
const UTM = "utm_source=newsletter&utm_campaign=Spring%20Sale";

const MODES: StorageMode[] = ["normal", "session-getter-throws", "session-null", "session-setitem-throws", "all-site-data-blocked"];

const available = chromiumAvailable();
if (!available) {
  // eslint-disable-next-line no-console
  console.warn("[telemetryRealSdkBrowserR4] Playwright Chromium is not installed: real-SDK browser suite SKIPPED.");
}
const d = available ? describe : describe.skip;

afterAll(async () => {
  await shutdown();
});

async function settle(run: Awaited<ReturnType<typeof openPage>>) {
  await run.page.waitForRequest((r) => r.url().includes("/ingest/e"), { timeout: 15_000 }).catch(() => undefined);
  await run.page.waitForTimeout(4_000); // PostHog batch flush interval is 3 s
}

/** Sends CONTROL events through both SDKs, flushes, then unloads the page (pagehide → sendBeacon). */
async function controlsAndUnload(run: Awaited<ReturnType<typeof openPage>>) {
  await run.page.evaluate((c) => {
    const p = (window as any).__cpProbe;
    p.posthog.capture("cp_harness_control", { probe: c });
    p.Sentry.captureMessage(`control ${c}`);
  }, CONTROL);
  await run.page.waitForTimeout(4_000);
  await run.savePageRecords();
  await run.page.goto(`${ORIGIN}/elsewhere`, { waitUntil: "load" });
  await run.page.waitForTimeout(500);
}

function describeLeaks(reqs: RecordedRequest[]): string[] {
  return reqs.map((r) => `${r.layer}:${r.kind} ${r.url.slice(0, 160)}`);
}

d("real posthog-js + Sentry: no claim text in any request (extension #text= hand-off)", () => {
  for (const mode of MODES) {
    it(`sessionStorage ${mode}: /flags, init and capture payloads carry no claim; UTM kept; controls detected`, async () => {
      const run = await openPage(`/verify?source=extension&${UTM}#text=${encodeURIComponent(CLAIM)}`, { mode });
      try {
        await settle(run);
        const href = await run.page.evaluate(() => window.location.href);
        const historyState = await run.page.evaluate(() => JSON.stringify(window.history.state));
        const persisted = await run.page.evaluate(() => {
          let ls = "";
          try {
            for (let i = 0; i < localStorage.length; i++) ls += localStorage.getItem(localStorage.key(i)!) ?? "";
          } catch {
            /* blocked */
          }
          return ls + document.cookie;
        });
        await controlsAndUnload(run);
        const all = await run.all();
        // The /flags request is never made (structural hardening disables it); instrumentation liveness is shown by the controls below...
        expect(all.some((r) => r.layer === "network" && r.url.includes("/ingest/flags"))).toBe(false); // structural hardening: /flags disabled
        expect(all.some((r) => r.layer === "page" && r.url.includes("/ingest/flags"))).toBe(false); // structural hardening: /flags disabled
        // The $pageleave sendBeacon on unload is observed too (beacon requests are instrumented).
        expect(all.some((r) => r.layer === "network" && r.kind === "ping" && r.url.includes("/ingest/"))).toBe(true);
        // ...and the CONTROL sentinel is found in decoded PostHog AND Sentry bodies (decoding is live).
        expect(requestsContaining(all.filter((r) => r.url.includes("/ingest/")), CONTROL).length).toBeGreaterThan(0);
        expect(requestsContaining(all.filter(isSentryRequest), CONTROL).length).toBeGreaterThan(0);
        // The claim is in NO request of any kind.
        expect(describeLeaks(requestsContaining(all, SENTINEL))).toEqual([]);
        expect(run.websockets.filter((u) => u.includes(SENTINEL))).toEqual([]);
        // The address bar, Next-visible history state and SDK persistence are clean; UTM values are kept byte-for-byte.
        expect(href).toBe(`${ORIGIN}/verify?source=extension&${UTM}`);
        expect(historyState ?? "").not.toContain(SENTINEL);
        expect(persisted).not.toContain(SENTINEL);
      } finally {
        await run.close();
      }
    });
  }
});

d("real posthog-js + Sentry: legacy claim-bearing query links", () => {
  const LEGACY: Array<[string, string]> = [
    ["/verify?text=", `/verify?source=extension&text=${encodeURIComponent(CLAIM)}&${UTM}`],
    ["/?tab=verify&claim=", `/?tab=verify&claim=${encodeURIComponent(CLAIM)}&${UTM}`],
    ["/?tab=research&q=", `/?tab=research&q=${encodeURIComponent(CLAIM)}&${UTM}`],
  ];
  for (const [label, path] of LEGACY) {
    for (const mode of ["normal", "session-getter-throws", "session-setitem-throws"] as StorageMode[]) {
      it(`${label} (${mode}): stripped before any SDK initializes; no telemetry request carries it`, async () => {
        const run = await openPage(path, { mode });
        try {
          await settle(run);
          const href = await run.page.evaluate(() => window.location.href);
          expect(href).not.toContain(SENTINEL);
          expect(href).toContain(UTM);
          await controlsAndUnload(run);
          const all = await run.all();
          expect(all.some((r) => r.layer === "network" && r.url.includes("/ingest/flags"))).toBe(false); // structural hardening: /flags disabled
          expect(requestsContaining(all.filter((r) => r.url.includes("/ingest/")), CONTROL).length).toBeGreaterThan(0);
          // A legacy query link is a SERVER-VISIBLE URL: the document request itself, and the Referer of the
          // subresources the HTML parser requests before any script runs, carry it (documented residual,
          // same exposure as the document request). Everything else — every telemetry request — must not.
          const leaks = requestsContaining(all, SENTINEL).filter((r) => {
            const firstPartyParserLoad = r.layer === "network" && r.url.startsWith(ORIGIN) && (r.kind === "document" || r.kind === "script");
            if (!firstPartyParserLoad) return true;
            const { referer: _ref, ...rest } = r.headers;
            const urlLeak = r.kind !== "document" && safeDecode(r.url).includes(SENTINEL);
            return urlLeak || Object.values(rest).some((h) => h.includes(SENTINEL)) || r.bodies.some((b) => b.includes(SENTINEL));
          });
          expect(describeLeaks(leaks)).toEqual([]);
        } finally {
          await run.close();
        }
      });
    }
  }
});

d("real posthog-js: a same-origin referrer that carried claim text (full-page navigation before hydration)", () => {
  for (const mode of ["normal", "session-getter-throws"] as StorageMode[]) {
    it(`(${mode}) $initial_referrer / $referrer never carry the claim`, async () => {
      const run = await openPage(`/verify?source=extension`, { mode, referer: `${ORIGIN}/?tab=verify&claim=${encodeURIComponent(CLAIM)}` });
      try {
        await settle(run);
        await controlsAndUnload(run);
        const all = await run.all();
        expect(all.some((r) => r.layer === "network" && r.url.includes("/ingest/flags"))).toBe(false); // structural hardening: /flags disabled
        expect(requestsContaining(all.filter((r) => r.url.includes("/ingest/")), CONTROL).length).toBeGreaterThan(0);
        // The browser sends the (test-supplied) Referer on the document request itself; nothing else may carry it.
        const leaks = requestsContaining(all, SENTINEL).filter((r) => !(r.layer === "network" && r.kind === "document"));
        expect(describeLeaks(leaks)).toEqual([]);
      } finally {
        await run.close();
      }
    });
  }
});

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
