/**
 * Doc 14 PR-1, R4: closed-world claim sentence inventory — the MEMO (the claim's exported explanatory content), full
 * space. See ./claimStatementInventory.harness.tsx.
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: Record<string, unknown>) => require("react").createElement("a", { href }, children as never),
}));
jest.mock("server-only", () => ({}));

import { expectSurfaceClean, inventoryCases, unhitTemplates, type Case } from "./claimStatementInventory.harness";

let CASES: Case[] = [];
beforeAll(() => {
  CASES = inventoryCases([1, 2, 3, 4, 5]);
});

describe("closed-world claim sentence inventory (R4): memo", () => {
  it("every memo unit is inventoried and its semantic claim holds for the independent oracle", () => {
    expectSurfaceClean("memo", CASES);
    expect(unhitTemplates("memo")).toEqual([]);
  }, 900_000);
});
