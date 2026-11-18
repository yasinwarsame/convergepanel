/**
 * Doc 14 PR-1, R4 (owner ruling 2026-11-18): CLOSED-WORLD claim sentence inventory — banner, copied verdict, Team list
 * row over the full space, plus the named scenarios. The inventory, the independent oracle and the producers are in
 * ./claimStatementInventory.harness.tsx (read its header); the memo and the rendered view run in their own spec files
 * (claimStatementInventoryMemo / claimStatementInventoryView*) so Jest runs the space in parallel.
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: Record<string, unknown>) => require("react").createElement("a", { href }, children as never),
}));
jest.mock("server-only", () => ({}));

import { expectSurfaceClean, inventoryCases, unhitTemplates, type Case } from "./claimStatementInventory.harness";
import { buildCase, claimVerdictBanner, memoFor, MODES, MAX_SLOTS, type Mode, type Outcome } from "./claimStatementInventory.harness";

let CASES: Case[] = [];
beforeAll(() => {
  CASES = inventoryCases([1, 2, 3, 4, 5]);
});

describe("closed-world claim sentence inventory (R4): banner, copied verdict, Team list", () => {
  it("the enumeration is the full space (1–5 slots × 6 outcomes × 13 provider modes, deduplicated, + historical labels)", () => {
    if (MAX_SLOTS === 5) expect(CASES.length).toBeGreaterThan(90_000);
  });
  for (const surface of ["banner", "clip", "team"] as const) {
    it(`every ${surface} unit is inventoried and its semantic claim holds for the independent oracle`, () => {
      expectSurfaceClean(surface, CASES);
      expect(unhitTemplates(surface)).toEqual([]);
    }, 900_000);
  }
});

describe("named scenarios (R4)", () => {
  const MODE = (name: string): Mode => MODES.find((m) => m.name === name)!;
  const c = (outs: Outcome[], mode: string) => buildCase(outs, MODE(mode));

  it("review M-1: one DeepSeek substitute supplies all four accurate answers, the only other model dissents → the memo states slot responses, not 'largely supported … meaningful alignment'", () => {
    const x = c(["A", "A", "A", "A", "I"], "ds:1-4");
    expect(x.payload.verdict).toBe("confirmed");
    expect(x.o.independence).toBe("independent");
    const memo = memoFor(x.payload);
    expect(memo).not.toContain("The models largely supported the claim");
    expect(memo).not.toContain("meaningful alignment");
    expect(memo).toContain("Panel slot responses: 4 accurate, 1 inaccurate; these are counts of slot responses, not of agreeing models.");
    expect(claimVerdictBanner(x.payload).title).toBe("This claim is supported by 4 of 5 answers");
  });

  it("a genuine majority of distinct own models keeps the models wording on banner and memo", () => {
    const x = c(["A", "A", "A", "A", "I"], "own");
    expect(claimVerdictBanner(x.payload).title).toBe("This claim is supported by 4/5 models");
    expect(memoFor(x.payload)).toContain("The models largely supported the claim, with meaningful alignment on the core statement.");
  });

  it("partial support resting on one substitute plus a minority is not 'Partial agreement across models' (banner) nor the models sentence (memo)", () => {
    const x = c(["P", "P", "P", "I", "I"], "ds:1-2");
    expect(claimVerdictBanner(x.payload).subtitle).not.toContain("Partial agreement across models");
    expect(memoFor(x.payload)).not.toMatch(/majority of the independent models/);
  });
});
