/**
 * Doc 14 PR-1, R4: closed-world claim sentence inventory — the RENDERED result view (banner, consensus card, agreement
 * digest and fallback copy, per-model evidence, disclaimer) and the audit trail, mixes of 1–4 slots with every
 * historical label. The 5-slot mixes run in claimStatementInventoryView5{a,b}.spec.tsx. See the harness header.
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: Record<string, unknown>) => require("react").createElement("a", { href }, children as never),
}));
jest.mock("server-only", () => ({}));

import { expectSurfaceClean, inventoryCases, unhitTemplates, type Case } from "./claimStatementInventory.harness";

let CASES: Case[] = [];
beforeAll(() => {
  CASES = inventoryCases([1, 2, 3, 4]);
});

describe("closed-world claim sentence inventory (R4): rendered view, 1–4 slots", () => {
  it("every view unit is inventoried and its semantic claim holds for the independent oracle", () => {
    expectSurfaceClean("view", CASES);
    expect(unhitTemplates("view")).toEqual([]);
  }, 900_000);
});
