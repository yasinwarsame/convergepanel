/**
 * Approval Workflow, Phase 9C.3 — panelPresentation.ts tests. The frozen
 * quorum formula (floor(N/2)+1) is explicitly required to be tested for
 * every reviewer count 2–9, no off-by-one (§24).
 */

import { computeQuorum, validatePanelReviewerSelection, getQuorumProgressText, getPanelStatusLabel, getReviewerCountLabel, MIN_PANEL_REVIEWERS, MAX_PANEL_REVIEWERS } from "@/lib/workspaces/panelPresentation";

describe("computeQuorum — frozen formula floor(N/2)+1, reviewer counts 2-9 (§24)", () => {
  const table: [number, number][] = [
    [2, 2],
    [3, 2],
    [4, 3],
    [5, 3],
    [6, 4],
    [7, 4],
    [8, 5],
    [9, 5],
  ];
  for (const [reviewerCount, expectedQuorum] of table) {
    it(`${reviewerCount} reviewers -> quorum ${expectedQuorum}`, () => {
      expect(computeQuorum(reviewerCount)).toBe(expectedQuorum);
    });
  }
});

describe("validatePanelReviewerSelection — mirror-only client validation (server remains authoritative)", () => {
  it("0 or 1 reviewer: invalid, too_few", () => {
    expect(validatePanelReviewerSelection([]).valid).toBe(false);
    expect(validatePanelReviewerSelection(["a"])).toEqual({ valid: false, reason: "too_few" });
  });
  it("2 reviewers: valid (minimum)", () => {
    expect(validatePanelReviewerSelection(["a", "b"])).toEqual({ valid: true, reason: null });
  });
  it("9 reviewers: valid (maximum)", () => {
    expect(validatePanelReviewerSelection(["a", "b", "c", "d", "e", "f", "g", "h", "i"])).toEqual({ valid: true, reason: null });
  });
  it("10 reviewers: invalid, too_many", () => {
    expect(validatePanelReviewerSelection(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"])).toEqual({ valid: false, reason: "too_many" });
  });
  it("duplicate uid: invalid, duplicate", () => {
    expect(validatePanelReviewerSelection(["a", "b", "a"])).toEqual({ valid: false, reason: "duplicate" });
  });
  it("frozen bounds constants match the spec exactly", () => {
    expect(MIN_PANEL_REVIEWERS).toBe(2);
    expect(MAX_PANEL_REVIEWERS).toBe(9);
  });
});

describe("getQuorumProgressText — text-and-number progress, never color-only (§102)", () => {
  it("produces both a submitted-count line and a quorum-required line", () => {
    const { primary, secondary } = getQuorumProgressText(2, 3, 2);
    expect(primary).toBe("2 of 3 reviewers have voted");
    expect(secondary).toBe("2 votes required for quorum");
  });
  it("singular phrasing for 1 reviewer / 1 vote required", () => {
    const { primary, secondary } = getQuorumProgressText(0, 1, 1);
    expect(primary).toContain("1 reviewer ");
    expect(secondary).toContain("1 vote ");
    expect(secondary).not.toContain("votes");
  });
});

describe("getPanelStatusLabel / getReviewerCountLabel", () => {
  it("maps every status to a distinct human label", () => {
    expect(getPanelStatusLabel("open")).toBe("In progress");
    expect(getPanelStatusLabel("finalized")).toBe("Finalized");
    expect(getPanelStatusLabel("cancelled")).toBe("Cancelled");
  });
  it("no label contains round-model language", () => {
    for (const status of ["open", "finalized", "cancelled"] as const) {
      expect(getPanelStatusLabel(status)).not.toMatch(/round/i);
    }
  });
  it("reviewer count label is pluralized correctly", () => {
    expect(getReviewerCountLabel(1)).toBe("1 reviewer");
    expect(getReviewerCountLabel(3)).toBe("3 reviewers");
  });
});
