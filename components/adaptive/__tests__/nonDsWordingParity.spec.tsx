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

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { NON_DS_SCHEMAS, captureNonDs, type Capture } from "./seSurfaces/nonDsSurfaces";

const BASELINE = join(__dirname, "seSurfaces", "__fixtures__", "nonDsBaseline.json");
const OUT = process.env.SE_NON_DS_BASELINE_OUT;

let current: Record<string, Capture>;
beforeAll(async () => {
  current = await captureNonDs(mockFetch);
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
      expect(Object.values(baseline).filter((c) => c.text.startsWith("RENDER ERROR"))).toEqual([]);
      expect(Object.values(baseline).filter((c) => c.text.length < 20)).toEqual([]);
    });

    it("renders exactly the same set of surfaces", () => {
      expect(Object.keys(current).sort()).toEqual(Object.keys(baseline).sort());
    });

    it.each(Object.keys(baseline).sort())("%s is identical", (id) => {
      expect(current[id]).toEqual(baseline[id]);
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
