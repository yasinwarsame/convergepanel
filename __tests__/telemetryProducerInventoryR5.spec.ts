/**
 * PR #329 R5 (R4 review MAJOR-1, owner ruling) — real posthog-js and the real
 * Sentry browser SDK (initialized by the real `instrumentation-client.ts` and
 * the real `PostHogProvider`) in real Chromium, against EVERY content-bearing
 * URL shape in the production producer inventory (origin/main cabbdbb and the
 * branch; see the PR body) plus seeded random nesting / encoding of content in
 * `redirect=` / `next=`.
 *
 * For each URL:
 *   - at `posthog.init`: neither `location.href` nor `document.referrer` carries the sentinel;
 *   - Sentry Replay sampling is forced, so the rrweb meta event (its `href` is read at Sentry.init) IS sent —
 *     a positive control asserts Replay traffic was observed — and must not carry it;
 *   - no request of any kind (URL, every header incl. Referer and Cookie, decoded body; network layer and in-page
 *     fetch / XHR / sendBeacon / image wrappers) carries it, except the test's own document request and the
 *     Referer of the parser-loaded bundle (both precede any script: documented server-visible residual of a URL
 *     the browser was asked to load);
 *   - CONTROL sentinels sent through both SDKs ARE found (decoding is live);
 *   - the post-auth redirect target still resolves (safeRedirect over `redirect || next`).
 * Default-deny network: every request is answered by the harness (`context.route`); non-origin, non-Sentry hosts abort.
 * Requires the Playwright Chromium build; skipped (and says so) when it is not installed.
 */
jest.mock("@/lib/firebase/admin", () => ({ adminDb: null }));
import { randomUUID } from "crypto";
import { safeRedirect } from "@/lib/utils/safeRedirect";
import { buildDeepResearchClaimId } from "@/lib/verification/claimVerificationOrigin";
import { personalResearchVerifyClaimHref } from "@/lib/user/personalResearchHref";
import { teamClaimOriginHandoffHref } from "@/lib/workspaces/teamClaimOriginHandoff";
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

jest.setTimeout(180_000);

const SENTINEL = "ZQX7R5BROWSERSENTINEL";
const CLAIM = `the moon is hollow ${SENTINEL} & tides obey wind farms?`;
const CONTROL = "ZQX7R5CONTROLPROBE";
const enc = encodeURIComponent;

const available = chromiumAvailable();
if (!available) {
  // eslint-disable-next-line no-console
  console.warn("[telemetryProducerInventoryR5] Playwright Chromium is not installed: real-SDK inventory suite SKIPPED.");
}
const d = available ? describe : describe.skip;

afterAll(async () => {
  await shutdown();
});

function deepDecode(s: string): string {
  let cur = s;
  for (let i = 0; i < 8; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur.replace(/\+/g, " "));
    } catch {
      break;
    }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** [inventory id, url, expected landing for redirect/next (or null), storage modes] */
const CASES: Array<[string, string, string | null, StorageMode[]]> = [
  ["P1 main extension ?text=", `/verify?source=extension&text=${enc(CLAIM)}`, null, ["normal", "all-site-data-blocked"]],
  ["P1/P2 branch extension #text=", `/verify?source=extension#text=${enc(CLAIM)}`, null, ["normal"]],
  ["P3 signup ?redirect=/verify?text=", `/signup?redirect=${enc(`/verify?source=extension&text=${enc(CLAIM)}`)}`, "/verify?source=extension", ["normal", "all-site-data-blocked"]],
  ["P4 login ?redirect=/verify?text=", `/login?redirect=${enc(`/verify?source=extension&text=${enc(CLAIM)}`)}`, "/verify?source=extension", ["normal", "all-site-data-blocked"]],
  ["P5 /?tab=verify&claim=", `/?tab=verify&claim=${enc(CLAIM)}`, null, ["normal"]],
  ["P6/P7 /?tab=research&q=", `/?tab=research&q=${enc(CLAIM)}`, null, ["normal"]],
  ["P8 onboarding (over-decoded nested claim)", `/onboarding?redirect=${enc(`/verify?source=extension&text=${CLAIM}`)}`, "/verify?source=extension", ["normal", "all-site-data-blocked"]],
  ["P8 onboarding ?redirect=/verify?text=", `/onboarding?redirect=${enc(`/verify?text=${enc(CLAIM)}`)}`, "/verify", ["normal"]],
  ["P9 signup (copied by login)", `/signup?redirect=${enc(`/verify?text=${enc(CLAIM)}`)}`, "/verify", ["normal"]],
  ["H2 login ?next=", `/login?next=${enc(`/verify?text=${enc(CLAIM)}`)}`, "/verify", ["normal"]],
  ["H3 login -> signup -> verify", `/login?redirect=${enc(`/signup?redirect=${enc(`/verify?text=${enc(CLAIM)}`)}`)}`, "/signup?redirect=/verify" /* safeRedirect decodes once more (pre-existing) */, ["normal", "all-site-data-blocked"]],
  ["H5a nested /?tab=verify&claim=", `/login?redirect=${enc(`/?tab=verify&claim=${enc(CLAIM)}`)}`, "/?tab=verify", ["normal"]],
  ["H5b nested #text=", `/signup?redirect=${enc(`/verify?source=extension#text=${enc(CLAIM)}`)}`, "/verify?source=extension", ["normal"]],
  ["H5c double-encoded nested", `/login?redirect=${enc(enc(`/verify?text=${enc(CLAIM)}`))}`, "/verify", ["normal"]],
  ["unknown content param", `/pricing?question=${enc(CLAIM)}&foo=${enc(CLAIM)}`, null, ["normal"]],
  ["unknown fragment", `/#text=${enc(CLAIM)}`, null, ["normal"]],
];

// Seeded property cases: random content nested 1–3 levels in redirect/next, random single/double/over-decoded encoding.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
{
  const rnd = mulberry32(0xb0_5eed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const punct = [" ", " & ", "=", "?", "#", "%", "/", "+", ";", "é", "中"];
  for (let n = 0; n < 8; n++) {
    const words = Array.from({ length: 4 }, () => pick(["tides", "Moon", "a&b", "x=1", "hollow", "cure"]) + pick(punct));
    words.splice(Math.floor(rnd() * 4), 0, `${SENTINEL} `);
    const content = words.join("");
    let target = pick([`/verify?source=extension&text=${enc(content)}`, `/verify#text=${enc(content)}`, `/?tab=verify&claim=${enc(content)}`, `/?tab=research&q=${enc(content)}`]);
    const depth = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < depth; k++) {
      const how = pick(["once", "twice", "over-decoded"]);
      let v: string;
      if (how === "twice") v = enc(enc(target));
      else if (how === "over-decoded") {
        let dec = target;
        try {
          dec = decodeURIComponent(target);
        } catch {
          /* keep */
        }
        v = enc(dec);
      } else v = enc(target);
      target = `${pick(["/signup", "/login", "/onboarding"])}?${pick(["redirect", "next"])}=${v}`;
    }
    CASES.push([`property #${n}`, target, null, [n % 2 === 0 ? "normal" : "all-site-data-blocked"]]);
  }
}

function leaksOf(all: RecordedRequest[]): string[] {
  return requestsContaining(all, SENTINEL)
    .filter((r) => {
      // The document request is the URL the test asked the browser to load; the parser-loaded bundle's Referer is set
      // before any script runs. Neither is telemetry; anything else carrying the sentinel is a leak.
      if (r.layer === "network" && r.kind === "document") return false;
      if (r.layer === "network" && r.kind === "script" && r.url.startsWith(ORIGIN)) {
        const { referer: _referer, ...rest } = r.headers;
        return deepDecode(r.url).includes(SENTINEL) || Object.values(rest).some((h) => deepDecode(h).includes(SENTINEL));
      }
      return true;
    })
    .map((r) => `${r.layer}:${r.kind} ${r.url.slice(0, 140)}`);
}

d("real posthog-js + Sentry (Replay forced): every producer-inventory URL shape", () => {
  for (const [label, path, landing, modes] of CASES) {
    for (const mode of modes) {
      it(`${label} [${mode}]`, async () => {
        const run = await openPage(path, { mode, forceReplaySampling: true });
        try {
          await run.page.waitForRequest((r) => r.url().includes("/ingest/e"), { timeout: 15_000 }).catch(() => undefined);
          await run.page.waitForTimeout(6_000); // Replay's first segment flush (min delay 5 s) + PostHog batch (3 s)
          const atInit: Array<{ href: string; referrer: string }> = await run.page.evaluate(() => (window as any).__cpAtInit ?? []);
          const href = await run.page.evaluate(() => window.location.href);
          // What the SDKs persisted (posthog-js keeps `$initial_person_info` {u: initial URL, r: referrer} in its
          // `ph_…` cookie / localStorage, window/session ids in sessionStorage). The app's own hand-off records
          // (`convergePanel*` keys) hold the moved claim by design and are excluded.
          const persisted: string = await run.page.evaluate(() => {
            let out = "";
            for (const name of ["localStorage", "sessionStorage"] as const) {
              try {
                const st = window[name];
                for (let i = 0; i < st.length; i++) {
                  const k = st.key(i)!;
                  if (!k.startsWith("convergePanel")) out += `${k}=${st.getItem(k) ?? ""};`;
                }
              } catch {
                /* blocked */
              }
            }
            return out + document.cookie;
          });
          await run.page.evaluate((c) => {
            const p = (window as any).__cpProbe;
            p.posthog.capture("cp_harness_control", { probe: c });
            p.Sentry.captureMessage(`control ${c}`);
          }, CONTROL);
          await run.page.waitForTimeout(4_000);
          await run.savePageRecords();
          await run.page.goto(`${ORIGIN}/elsewhere`, { waitUntil: "load" });
          await run.page.waitForTimeout(500);
          const all = await run.all();

          // At SDK init.
          expect(atInit.length).toBe(1);
          expect(deepDecode(atInit[0].href)).not.toContain(SENTINEL);
          expect(deepDecode(atInit[0].referrer)).not.toContain(SENTINEL);
          expect(deepDecode(href)).not.toContain(SENTINEL);
          expect(deepDecode(persisted)).not.toContain(SENTINEL);
          if (landing !== null) {
            const u = new URL(href);
            expect(safeRedirect(u.searchParams.get("redirect") || u.searchParams.get("next"), "/")).toBe(landing);
          }
          // Positive controls: Replay traffic and the CONTROL sentinel in both SDKs' bodies; /flags must be absent.
          expect(all.some((r) => isSentryRequest(r) && r.bodies.some((b) => b.includes("replay_recording") || b.includes("replay_event")))).toBe(true);
          expect(all.some((r) => r.layer === "network" && r.url.includes("/ingest/flags"))).toBe(false); // structural hardening: /flags disabled
          expect(requestsContaining(all.filter((r) => r.url.includes("/ingest/")), CONTROL).length).toBeGreaterThan(0);
          expect(requestsContaining(all.filter(isSentryRequest), CONTROL).length).toBeGreaterThan(0);
          // No request of any kind carries the claim.
          expect(leaksOf(all)).toEqual([]);
          expect(run.websockets.filter((u) => deepDecode(u).includes(SENTINEL))).toEqual([]);
        } finally {
          await run.close();
        }
      });
    }
  }
});

/**
 * R5 correction (review MAJOR-1): the routing hand-offs built by the REAL builders survive the real pre-init scrub in
 * real Chromium — the address bar at `posthog.init` and after load still holds the exact URL the page reads (personal
 * "Verify claim" → app/page.tsx; team hand-off → reload of the claims/new page).
 */
d("real posthog-js + Sentry: routing hand-offs built by the real builders survive the pre-init scrub", () => {
  const run = `run-${randomUUID()}`;
  const claimId = buildDeepResearchClaimId({ runId: run, section: "findings", index: 4, finding: { id: "f-1", summary: "a finding" } })!;
  const lowClaimId = buildDeepResearchClaimId({ runId: run, section: "lowConfidenceFindings", index: 0, finding: { id: "f-2", summary: "x" } })!;
  const ROUTED: Array<[string, string]> = [
    ["personal Verify claim", personalResearchVerifyClaimHref({ runId: run, claimId })!],
    ["team claim origin", teamClaimOriginHandoffHref({ workspaceId: "Wq8k2LmN4pR7sT1vX3yZ", runId: run, claimId: lowClaimId })],
  ];
  for (const [label, path] of ROUTED) {
    it(`${label} [normal]`, async () => {
      const run2 = await openPage(path, { mode: "normal", forceReplaySampling: true });
      try {
        await run2.page.waitForRequest((r) => r.url().includes("/ingest/e"), { timeout: 15_000 }).catch(() => undefined);
        const atInit: Array<{ href: string }> = await run2.page.evaluate(() => (window as any).__cpAtInit ?? []);
        const href = await run2.page.evaluate(() => window.location.href);
        expect(atInit.length).toBe(1);
        expect(atInit[0].href).toBe(`${ORIGIN}${path}`);
        expect(href).toBe(`${ORIGIN}${path}`);
        const u = new URL(href);
        expect(u.searchParams.get("originRunId")).toBe(run);
        expect(u.searchParams.get("originClaimId")).toBe(label.startsWith("team") ? lowClaimId : claimId);
        // Reload (a shared link / back-forward restore is the same hard load).
        await run2.page.reload({ waitUntil: "load" });
        expect(await run2.page.evaluate(() => window.location.href)).toBe(`${ORIGIN}${path}`);
      } finally {
        await run2.close();
      }
    });
  }
});
