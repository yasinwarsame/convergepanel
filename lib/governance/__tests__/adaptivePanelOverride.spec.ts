/**
 * Multi-Reviewer Owner Override, Part F — pure model tests: request
 * validation, the deterministic override-decision identity, and the
 * canonical humanReview provenance builder.
 */

import {
  parseSubmitAdaptiveReviewOverrideRequest,
  buildAdaptivePanelOverrideDecisionId,
  buildOverrideSystemComment,
  buildOverriddenMultiReviewerHumanReview,
} from "@/lib/governance/adaptivePanelOverride";

describe("parseSubmitAdaptiveReviewOverrideRequest", () => {
  const validBody = {
    expectedPanelRevision: 3,
    expectedGovernanceUpdatedAt: "2020-06-01T00:00:00.000Z",
    status: "approved",
    justification: "The panel deadlocked and the deadline has passed.",
  };

  it("accepts a fully valid approved request with no conditions", () => {
    const result = parseSubmitAdaptiveReviewOverrideRequest(validBody);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("approved");
      expect(result.value.justification).toBe(validBody.justification);
      expect(result.value.conditions).toBeUndefined();
      expect(result.value.expectedPanelRevision).toBe(3);
    }
  });

  it("accepts approved_with_conditions with 1-20 normalized conditions", () => {
    const result = parseSubmitAdaptiveReviewOverrideRequest({
      ...validBody,
      status: "approved_with_conditions",
      conditions: ["  fix X  ", "fix X", "fix Y"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.conditions).toEqual(["fix X", "fix Y"]);
    }
  });

  it("rejects a non-object body", () => {
    expect(parseSubmitAdaptiveReviewOverrideRequest(null)).toEqual({ ok: false, reason: "malformed_body" });
    expect(parseSubmitAdaptiveReviewOverrideRequest("string")).toEqual({ ok: false, reason: "malformed_body" });
    expect(parseSubmitAdaptiveReviewOverrideRequest([])).toEqual({ ok: false, reason: "malformed_body" });
  });

  it("rejects a missing expectedPanelRevision", () => {
    const { expectedPanelRevision, ...rest } = validBody;
    expect(parseSubmitAdaptiveReviewOverrideRequest(rest)).toEqual({ ok: false, reason: "missing_expected_panel_revision" });
  });

  it("rejects a non-integer or non-positive expectedPanelRevision", () => {
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, expectedPanelRevision: 0 })).toEqual({
      ok: false,
      reason: "invalid_expected_panel_revision",
    });
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, expectedPanelRevision: 1.5 })).toEqual({
      ok: false,
      reason: "invalid_expected_panel_revision",
    });
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, expectedPanelRevision: "3" })).toEqual({
      ok: false,
      reason: "invalid_expected_panel_revision",
    });
  });

  it("rejects a missing expectedGovernanceUpdatedAt", () => {
    const { expectedGovernanceUpdatedAt, ...rest } = validBody;
    expect(parseSubmitAdaptiveReviewOverrideRequest(rest)).toEqual({ ok: false, reason: "missing_expected_governance_updated_at" });
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, expectedGovernanceUpdatedAt: "" })).toEqual({
      ok: false,
      reason: "missing_expected_governance_updated_at",
    });
  });

  it("rejects an invalid expectedGovernanceUpdatedAt timestamp", () => {
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, expectedGovernanceUpdatedAt: "not-a-date" })).toEqual({
      ok: false,
      reason: "invalid_expected_governance_updated_at",
    });
  });

  it("rejects an invalid status", () => {
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, status: "pending" })).toEqual({ ok: false, reason: "invalid_status" });
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, status: "unreviewed" })).toEqual({ ok: false, reason: "invalid_status" });
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, status: 123 })).toEqual({ ok: false, reason: "invalid_status" });
  });

  it("rejects a missing or empty-after-trim justification", () => {
    const { justification, ...rest } = validBody;
    expect(parseSubmitAdaptiveReviewOverrideRequest(rest)).toEqual({ ok: false, reason: "missing_justification" });
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, justification: "   " })).toEqual({ ok: false, reason: "missing_justification" });
  });

  it("rejects a non-string justification", () => {
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, justification: 42 })).toEqual({ ok: false, reason: "invalid_justification" });
  });

  it("rejects a justification longer than 4000 chars", () => {
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, justification: "x".repeat(4001) })).toEqual({
      ok: false,
      reason: "justification_too_long",
    });
  });

  it("accepts a justification of exactly 4000 chars", () => {
    const result = parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, justification: "x".repeat(4000) });
    expect(result.ok).toBe(true);
  });

  it("rejects conditions on approved/changes_requested/rejected", () => {
    for (const status of ["approved", "changes_requested", "rejected"]) {
      expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, status, conditions: ["x"] })).toEqual({
        ok: false,
        reason: "conditions_not_allowed",
      });
    }
  });

  it("requires at least one condition for approved_with_conditions", () => {
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, status: "approved_with_conditions" })).toEqual({
      ok: false,
      reason: "conditions_required",
    });
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, status: "approved_with_conditions", conditions: [] })).toEqual({
      ok: false,
      reason: "conditions_required",
    });
  });

  it("rejects more than 20 conditions", () => {
    const conditions = Array.from({ length: 21 }, (_, i) => `c-${i}`);
    expect(parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, status: "approved_with_conditions", conditions })).toEqual({
      ok: false,
      reason: "too_many_conditions",
    });
  });

  it("rejects a condition longer than 500 chars", () => {
    expect(
      parseSubmitAdaptiveReviewOverrideRequest({ ...validBody, status: "approved_with_conditions", conditions: ["x".repeat(501)] })
    ).toEqual({ ok: false, reason: "condition_too_long" });
  });

  it("never reads teamId, actor identity, finalDecisionId, or any other out-of-contract field", () => {
    const result = parseSubmitAdaptiveReviewOverrideRequest({
      ...validBody,
      teamId: "should-be-ignored",
      reviewerId: "should-be-ignored",
      finalDecisionId: "should-be-ignored",
      finalizedAt: "should-be-ignored",
      quorum: 99,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty("teamId");
      expect(result.value).not.toHaveProperty("reviewerId");
      expect(result.value).not.toHaveProperty("finalDecisionId");
      expect(result.value).not.toHaveProperty("quorum");
    }
  });
});

describe("buildAdaptivePanelOverrideDecisionId", () => {
  const base = { teamId: "team-1", runId: "run-1", panelRevision: 3, status: "approved", justification: "same justification" };

  it("is deterministic — the exact same request always produces the same ID (exact-retry idempotency)", () => {
    const a = buildAdaptivePanelOverrideDecisionId(base);
    const b = buildAdaptivePanelOverrideDecisionId(base);
    expect(a).toBe(b);
  });

  it("a different justification produces a different ID (changed-retry conflict)", () => {
    const a = buildAdaptivePanelOverrideDecisionId(base);
    const b = buildAdaptivePanelOverrideDecisionId({ ...base, justification: "a different justification" });
    expect(a).not.toBe(b);
  });

  it("a different status produces a different ID", () => {
    const a = buildAdaptivePanelOverrideDecisionId(base);
    const b = buildAdaptivePanelOverrideDecisionId({ ...base, status: "rejected" });
    expect(a).not.toBe(b);
  });

  it("a different panelRevision produces a different ID", () => {
    const a = buildAdaptivePanelOverrideDecisionId(base);
    const b = buildAdaptivePanelOverrideDecisionId({ ...base, panelRevision: 4 });
    expect(a).not.toBe(b);
  });

  it("different conditions produce a different ID", () => {
    const a = buildAdaptivePanelOverrideDecisionId({ ...base, status: "approved_with_conditions", conditions: ["x"] });
    const b = buildAdaptivePanelOverrideDecisionId({ ...base, status: "approved_with_conditions", conditions: ["y"] });
    expect(a).not.toBe(b);
  });

  it("is distinct in shape from both the single-reviewer and aggregation decision ID prefixes", () => {
    const id = buildAdaptivePanelOverrideDecisionId(base);
    expect(id).toMatch(/^panel_override_dec_[0-9a-f]{32}$/);
    expect(id.startsWith("dec_")).toBe(false);
    expect(id.startsWith("panel_dec_")).toBe(false);
  });

  it("throws on empty required components", () => {
    expect(() => buildAdaptivePanelOverrideDecisionId({ ...base, teamId: "" })).toThrow();
    expect(() => buildAdaptivePanelOverrideDecisionId({ ...base, runId: "" })).toThrow();
    expect(() => buildAdaptivePanelOverrideDecisionId({ ...base, panelRevision: 0 })).toThrow();
    expect(() => buildAdaptivePanelOverrideDecisionId({ ...base, status: "" })).toThrow();
    expect(() => buildAdaptivePanelOverrideDecisionId({ ...base, justification: "" })).toThrow();
  });
});

describe("buildOverrideSystemComment", () => {
  it("returns the fixed override system comment for changes_requested and rejected", () => {
    expect(buildOverrideSystemComment("changes_requested")).toBe("Finalized by owner override.");
    expect(buildOverrideSystemComment("rejected")).toBe("Finalized by owner override.");
  });

  it("returns undefined for approved and approved_with_conditions", () => {
    expect(buildOverrideSystemComment("approved")).toBeUndefined();
    expect(buildOverrideSystemComment("approved_with_conditions")).toBeUndefined();
  });

  it("is distinct from the aggregation path's own system comment text", () => {
    expect(buildOverrideSystemComment("rejected")).not.toBe("Finalized by multi-reviewer panel.");
  });
});

describe("buildOverriddenMultiReviewerHumanReview", () => {
  it("builds the full canonical humanReview object with owner-override provenance", () => {
    const result = buildOverriddenMultiReviewerHumanReview({
      finalStatus: "approved_with_conditions",
      overridingOwnerUid: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      justification: "Deadline pressure required an override.",
      conditions: ["must fix X"],
      panelRevision: 3,
    });
    expect(result).toEqual({
      status: "approved_with_conditions",
      reviewerId: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      comment: undefined,
      conditions: ["must fix X"],
      decidedVia: "multi_reviewer_owner_override",
      panelRevision: 3,
      overrideJustification: "Deadline pressure required an override.",
    });
  });

  it("sets the system comment and omits conditions for rejected", () => {
    const result = buildOverriddenMultiReviewerHumanReview({
      finalStatus: "rejected",
      overridingOwnerUid: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      justification: "Not acceptable.",
      panelRevision: 3,
    });
    expect(result.comment).toBe("Finalized by owner override.");
    expect(result.conditions).toBeUndefined();
  });

  it("omits conditions for plain approved even if conditions were (incorrectly) passed in", () => {
    const result = buildOverriddenMultiReviewerHumanReview({
      finalStatus: "approved",
      overridingOwnerUid: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      justification: "Fine as-is.",
      conditions: ["should be dropped"],
      panelRevision: 3,
    });
    expect(result.conditions).toBeUndefined();
  });

  it("never includes a vote list or aggregation internals — only compact provenance fields", () => {
    const result = buildOverriddenMultiReviewerHumanReview({
      finalStatus: "approved",
      overridingOwnerUid: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      justification: "Fine as-is.",
      panelRevision: 3,
    });
    expect(result).not.toHaveProperty("reviewerUserIds");
    expect(result).not.toHaveProperty("votes");
    expect(result).not.toHaveProperty("supportingReviewerUserIds");
    expect(result).not.toHaveProperty("aggregationPolicyVersion");
    expect(result).not.toHaveProperty("supportingReviewerCount");
  });

  it("does set reviewerId to the overriding owner's uid, never a voter's uid", () => {
    const result = buildOverriddenMultiReviewerHumanReview({
      finalStatus: "approved",
      overridingOwnerUid: "the-owner",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      justification: "Fine as-is.",
      panelRevision: 3,
    });
    expect(result.reviewerId).toBe("the-owner");
  });
});
