/**
 * Transactional Multi-Reviewer Finalization, Part E (§E20) — panel schema
 * extension tests: the "finalized" status, its five optional fields, and
 * the parser's cross-field validation. Backward compatibility with
 * existing Part B/C open/cancelled panel documents is also verified here.
 */

import {
  AdaptiveHumanReviewPanelV1,
  parseAdaptiveHumanReviewPanel,
  buildFinalizedAdaptiveHumanReviewPanel,
  buildNextAdaptiveHumanReviewPanel,
  buildCancelledAdaptiveHumanReviewPanel,
} from "@/lib/governance/adaptiveHumanReviewPanel";

function validOpenPanel(overrides: Partial<AdaptiveHumanReviewPanelV1> = {}): AdaptiveHumanReviewPanelV1 {
  return {
    schemaVersion: 1,
    kind: "adaptive_review_panel",
    teamId: "team-1",
    runId: "run-1",
    mode: "majority_quorum",
    reviewerUserIds: ["a", "b", "c"],
    requiredReviewerCount: 3,
    quorum: 2,
    status: "open",
    revision: 1,
    createdAt: "2020-01-01T00:00:00.000Z",
    createdByUserId: "admin-uid",
    updatedAt: "2020-01-01T00:00:00.000Z",
    updatedByUserId: "admin-uid",
    ...overrides,
  };
}

function validFinalizedPanel(overrides: Partial<AdaptiveHumanReviewPanelV1> = {}): AdaptiveHumanReviewPanelV1 {
  return {
    ...validOpenPanel(),
    status: "finalized",
    revision: 2,
    updatedAt: "2020-06-01T00:00:00.000Z",
    finalizedAt: "2020-06-01T00:00:00.000Z",
    finalizedByUserId: "owner-uid",
    finalStatus: "approved",
    finalDecisionId: "panel_dec_abcdef0123456789abcdef0123456789",
    aggregationPolicyVersion: 1,
    ...overrides,
  };
}

describe("parseAdaptiveHumanReviewPanel — backward compatibility", () => {
  it("an existing open panel (no finalized fields) still parses as valid", () => {
    const result = parseAdaptiveHumanReviewPanel(validOpenPanel());
    expect(result.status).toBe("valid");
  });

  it("an existing cancelled panel (no finalized fields) still parses as valid", () => {
    const result = parseAdaptiveHumanReviewPanel(validOpenPanel({ status: "cancelled" }));
    expect(result.status).toBe("valid");
  });
});

describe("parseAdaptiveHumanReviewPanel — finalized state", () => {
  it("a valid finalized panel parses as valid, carrying every finalized field", () => {
    const result = parseAdaptiveHumanReviewPanel(validFinalizedPanel());
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.panel.status).toBe("finalized");
      expect(result.panel.finalStatus).toBe("approved");
      expect(result.panel.finalDecisionId).toBe("panel_dec_abcdef0123456789abcdef0123456789");
      expect(result.panel.aggregationPolicyVersion).toBe(1);
    }
  });

  it("missing any one finalized field on a finalized panel is malformed", () => {
    const base = validFinalizedPanel();
    for (const field of ["finalizedAt", "finalizedByUserId", "finalStatus", "finalDecisionId", "aggregationPolicyVersion"] as const) {
      const { [field]: _omit, ...rest } = base;
      expect(parseAdaptiveHumanReviewPanel(rest)).toEqual({ status: "malformed" });
    }
  });

  it("finalized fields present on an OPEN panel are rejected", () => {
    const result = parseAdaptiveHumanReviewPanel({
      ...validOpenPanel(),
      finalizedAt: "2020-06-01T00:00:00.000Z",
      finalizedByUserId: "owner-uid",
      finalStatus: "approved",
      finalDecisionId: "panel_dec_x",
      aggregationPolicyVersion: 1,
    });
    expect(result).toEqual({ status: "malformed" });
  });

  it("finalized fields present on a CANCELLED panel are rejected", () => {
    const result = parseAdaptiveHumanReviewPanel({
      ...validOpenPanel({ status: "cancelled" }),
      finalizedAt: "2020-06-01T00:00:00.000Z",
      finalizedByUserId: "owner-uid",
      finalStatus: "approved",
      finalDecisionId: "panel_dec_x",
      aggregationPolicyVersion: 1,
    });
    expect(result).toEqual({ status: "malformed" });
  });

  it("a single finalized field present on an open panel (partial leakage) is also rejected", () => {
    const result = parseAdaptiveHumanReviewPanel({ ...validOpenPanel(), finalDecisionId: "panel_dec_x" });
    expect(result).toEqual({ status: "malformed" });
  });

  it("an unsupported aggregationPolicyVersion is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ aggregationPolicyVersion: 0 }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ aggregationPolicyVersion: 1.5 as any }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ aggregationPolicyVersion: "1" as any }))).toEqual({ status: "malformed" });
  });

  it("an invalid finalStatus is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ finalStatus: "unreviewed" as any }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ finalStatus: "" as any }))).toEqual({ status: "malformed" });
  });

  it("an empty finalDecisionId is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ finalDecisionId: "" }))).toEqual({ status: "malformed" });
  });

  it("an invalid finalizedAt is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ finalizedAt: "not-a-date" }))).toEqual({ status: "malformed" });
  });

  it("finalizedAt after updatedAt is malformed", () => {
    expect(
      parseAdaptiveHumanReviewPanel(validFinalizedPanel({ updatedAt: "2020-01-01T00:00:00.000Z", finalizedAt: "2020-06-01T00:00:00.000Z" }))
    ).toEqual({ status: "malformed" });
  });

  it("an empty finalizedByUserId is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ finalizedByUserId: "" }))).toEqual({ status: "malformed" });
  });

  it("every finalStatus value is independently valid", () => {
    for (const status of ["approved", "approved_with_conditions", "changes_requested", "rejected"] as const) {
      expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ finalStatus: status })).status).toBe("valid");
    }
  });
});

describe("No reopening — buildNext/buildCancelled never produce a finalized panel", () => {
  it("buildNextAdaptiveHumanReviewPanel never sets any finalized field, regardless of the current panel's own state", () => {
    const next = buildNextAdaptiveHumanReviewPanel({
      teamId: "team-1",
      runId: "run-1",
      reviewerUserIds: ["a", "b"],
      actorUserId: "admin-uid",
      now: "2020-01-01T00:00:00.000Z",
      current: null,
    });
    expect(next.status).toBe("open");
    expect(next).not.toHaveProperty("finalizedAt");
    expect(next).not.toHaveProperty("finalStatus");
  });

  it("buildCancelledAdaptiveHumanReviewPanel never sets any finalized field", () => {
    const cancelled = buildCancelledAdaptiveHumanReviewPanel({
      current: validOpenPanel(),
      actorUserId: "admin-uid",
      now: "2020-01-01T00:00:00.000Z",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled).not.toHaveProperty("finalizedAt");
  });
});

describe("buildFinalizedAdaptiveHumanReviewPanel", () => {
  it("sets status finalized, increments revision by 1, sets all finalized fields", () => {
    const current = validOpenPanel({ revision: 3 });
    const finalized = buildFinalizedAdaptiveHumanReviewPanel({
      current,
      actorUserId: "owner-uid",
      now: "2020-06-01T00:00:00.000Z",
      finalStatus: "rejected",
      finalDecisionId: "panel_dec_xyz",
      aggregationPolicyVersion: 1,
    });
    expect(finalized.status).toBe("finalized");
    expect(finalized.revision).toBe(4);
    expect(finalized.finalizedAt).toBe("2020-06-01T00:00:00.000Z");
    expect(finalized.finalizedByUserId).toBe("owner-uid");
    expect(finalized.finalStatus).toBe("rejected");
    expect(finalized.finalDecisionId).toBe("panel_dec_xyz");
    expect(finalized.aggregationPolicyVersion).toBe(1);
  });

  it("preserves reviewerUserIds, mode, quorum, requiredReviewerCount, createdAt, createdByUserId exactly", () => {
    const current = validOpenPanel({ createdAt: "2019-01-01T00:00:00.000Z", createdByUserId: "founder-uid" });
    const finalized = buildFinalizedAdaptiveHumanReviewPanel({
      current,
      actorUserId: "owner-uid",
      now: "2020-06-01T00:00:00.000Z",
      finalStatus: "approved",
      finalDecisionId: "panel_dec_xyz",
      aggregationPolicyVersion: 1,
    });
    expect(finalized.reviewerUserIds).toEqual(current.reviewerUserIds);
    expect(finalized.mode).toBe(current.mode);
    expect(finalized.quorum).toBe(current.quorum);
    expect(finalized.requiredReviewerCount).toBe(current.requiredReviewerCount);
    expect(finalized.createdAt).toBe("2019-01-01T00:00:00.000Z");
    expect(finalized.createdByUserId).toBe("founder-uid");
  });

  it("output round-trips through the parser as valid", () => {
    const finalized = buildFinalizedAdaptiveHumanReviewPanel({
      current: validOpenPanel(),
      actorUserId: "owner-uid",
      now: "2020-06-01T00:00:00.000Z",
      finalStatus: "approved_with_conditions",
      finalDecisionId: "panel_dec_xyz",
      aggregationPolicyVersion: 1,
    });
    expect(parseAdaptiveHumanReviewPanel(finalized).status).toBe("valid");
  });
});
