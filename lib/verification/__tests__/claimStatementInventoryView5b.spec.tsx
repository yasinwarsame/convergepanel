/**
 * Doc 14 PR-1, R4: closed-world claim sentence inventory — the rendered result view and audit trail over the 5-slot
 * mixes, shard 2 of 2 (enumeration index mod 2 = 1). See the harness header.
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: Record<string, unknown>) => require("react").createElement("a", { href }, children as never),
}));
jest.mock("server-only", () => ({}));

import { expectSurfaceClean, inventoryCases, type Case } from "./claimStatementInventory.harness";

let CASES: Case[] = [];
beforeAll(() => {
  CASES = inventoryCases([5], [1, 2]);
});

describe("closed-world claim sentence inventory (R4): rendered view, 5 slots (shard 2/2)", () => {
  it("every view unit is inventoried and its semantic claim holds for the independent oracle", () => {
    expectSurfaceClean("view", CASES);
  }, 900_000);
});
