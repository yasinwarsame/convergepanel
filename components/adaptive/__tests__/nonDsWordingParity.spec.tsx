/**
 * Order 6 / S-E.1 — AC-6 / AC-8: the Decision Support wording change leaves every other schema byte-identical.
 *
 * The baseline (seSurfaces/__fixtures__/nonDsBaseline.json) was captured by running this same spec, with
 * SE_NON_DS_BASELINE_OUT set, on a detached worktree of unmodified main (f207e1a). Here it re-renders every surface on
 * the branch and requires equality: full markup for result pages, reader text for receipt surfaces, and the exact
 * request sequence (method + URL) of the two review pages.
 */

const mockFetch = jest.fn();
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockFetch(...a) }));
// One stable auth value, as the real provider keeps `user` in state (the review pages reload on every `user` change).
const mockAuth = { user: { uid: "reviewer-1", getIdToken: async () => "t" }, loading: false, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockAuth }));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next/link", () => {
  const { createElement } = jest.requireActual("react");
  return { __esModule: true, default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children) };
});

import { undoCriticalContrastClasses } from "./criticalContrastSlice";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DATETIME_TOKEN, LOCAL_DATETIME, NON_DS_SCHEMAS, captureNonDs, tokeniseDates, type Capture } from "./seSurfaces/nonDsSurfaces";
import { listItemSurface, teamReviewDetailSurface } from "./seSurfaces/seSurfaceRenderers";
import { surfaceText, type DsFixture } from "./seSurfaces/seSurfaceHarness";

const BASELINE = join(__dirname, "seSurfaces", "__fixtures__", "nonDsBaseline.json");
const OUT = process.env.SE_NON_DS_BASELINE_OUT;

let current: Record<string, Capture>;
// 300 captures (88 static pages plus 16 effect-driven review renders) take about 2-3 s alone; R4 saw this hook exceed
// Jest's default 5 s once under a heavily loaded broad run (cause unconfirmed). An explicit bound keeps the expectation
// unchanged while allowing for load.
const CAPTURE_TIMEOUT_MS = 60_000;
beforeAll(async () => {
  current = await captureNonDs(mockFetch);
}, CAPTURE_TIMEOUT_MS);

/**
 * Separate timestamp coverage (the parity captures tokenise local date-times). The receipt surfaces must render the
 * stored instant in the process's local time: checked against the instant's own local calendar fields, not against
 * the component's formatter, so it holds in any timezone and fails if the timestamp is dropped, shifted or mis-sourced.
 */
describe("receipt-surface timestamps render the stored instant in local time", () => {
  const fixture = { name: "ts", perModel: [], result: { sourceBacked: true, humanReviewNeeded: false } } as unknown as DsFixture;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const expected = (iso: string) => {
    const d = new Date(iso);
    const hour = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
    return { date: `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`, time: `${hour}:${String(d.getMinutes()).padStart(2, "0")}`, meridiem: d.getHours() < 12 ? "AM" : "PM" };
  };
  const check = (text: string, iso: string) => {
    const shown = text.match(LOCAL_DATETIME);
    expect(shown).not.toBeNull();
    expect(shown).toHaveLength(1);
    const e = expected(iso);
    expect(shown![0]).toContain(e.date);
    expect(shown![0]).toMatch(new RegExp(`\\b${e.time}\\s?${e.meridiem}\\b`));
  };

  for (const schemaId of ["deep_research", "decision_support"]) {
    it(`${schemaId}: review queue item shows the item's updatedAt`, () => {
      check(surfaceText(listItemSurface("ts", fixture, schemaId)), "2026-10-28T00:00:00.000Z");
    });
    it(`${schemaId}: Team review detail shows "Updated" with the review's updatedAt`, async () => {
      mockFetch.mockReset();
      const text = surfaceText(await teamReviewDetailSurface("ts", fixture, schemaId, mockFetch));
      // "Updated" and the date-time are separate text nodes (newline-joined in surfaceText).
      expect(text).toMatch(/Updated\s+[A-Z][a-z]{2} \d/);
      check(text, "2026-10-28T00:00:00.000Z");
    });
  }
});

if (OUT) {
  it("captures the baseline", () => {
    writeFileSync(OUT, JSON.stringify(current, null, 1));
    expect(Object.keys(current).length).toBeGreaterThan(0);
  });
} else {
  const baseline: Record<string, Capture> = JSON.parse(readFileSync(BASELINE, "utf8"));

  describe("non-Decision Support surfaces are unchanged from main (f207e1a)", () => {
    it("the baseline covers every non-DS schema and was not captured from failed renders", () => {
      for (const q of NON_DS_SCHEMAS) expect([q, Object.keys(baseline).some((k) => k.includes(`:${q}:`))]).toEqual([q, true]);
      // Populated results too (o5p historical records), not only the empty state.
      expect(Object.keys(baseline).filter((k) => k.startsWith("populated:")).length).toBe(44);
      expect(Object.values(baseline).filter((c) => c.text.startsWith("RENDER ERROR"))).toEqual([]);
      expect(Object.values(baseline).filter((c) => c.text.length < 20)).toEqual([]);
    });

    it("local date-times are tokenised (timezone-independent), and only where a real date-time was rendered", () => {
      const tokenised = Object.entries(baseline).filter(([, c]) => c.text.includes(DATETIME_TOKEN));
      expect(tokenised.map(([id]) => id.split(":")[0]).sort()).toEqual(expect.arrayContaining(["listItem", "teamReview"]));
      for (const [, c] of Object.entries(baseline)) expect(c.text).not.toMatch(LOCAL_DATETIME);
      expect(tokeniseDates("Updated Oct 28, 2026, 3:00 AM")).toBe(`Updated ${DATETIME_TOKEN}`);
      expect(tokeniseDates("Oct 28, 2026, 12:00 AM")).toBe(DATETIME_TOKEN);
      // The normaliser touches the date-time only: wording around it, and wording that merely looks date-like, is kept.
      expect(tokeniseDates("Oct 28, 2026, 3:00 AM Source-backed · Human review not required")).toBe(`${DATETIME_TOKEN} Source-backed · Human review not required`);
      for (const text of ["Updated Oct 28 2026 3:00 AM", "Oct 28, 2026", "3:00 AM", "Source-backed", "October 28, 2026, 3:00 AM", "Strong consensus"]) expect([text, tokeniseDates(text)]).toEqual([text, text]);
      // Every token in the baseline replaced exactly one date-time: stripping tokens leaves identical text on both sides.
      for (const [id, c] of Object.entries(baseline)) expect([id, current[id].text.split(DATETIME_TOKEN).length]).toEqual([id, c.text.split(DATETIME_TOKEN).length]);
    });

    it("renders exactly the same set of surfaces", () => {
      expect(Object.keys(current).sort()).toEqual(Object.keys(baseline).sort());
    });

    it.each(Object.keys(baseline).sort())("%s is identical", (id) => {
      // Order 6 critical-contrast slice: the baseline predates it; compare with its class changes reversed.
      expect({ ...current[id], html: current[id].html === undefined ? undefined : undoCriticalContrastClasses(current[id].html).markup }).toEqual(baseline[id]);
    });

    it("the review pages make the same requests as before (AC-8), and some were made", () => {
      const withFetches = Object.entries(baseline).filter(([, c]) => c.fetches);
      expect(withFetches.length).toBeGreaterThan(0);
      for (const [id, c] of withFetches) {
        expect([id, c.fetches!.length > 0]).toEqual([id, true]);
        expect([id, current[id].fetches]).toEqual([id, c.fetches]);
      }
    });
  });
}
