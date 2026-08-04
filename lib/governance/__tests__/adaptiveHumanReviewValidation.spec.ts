/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D —
 * parseAdaptiveReviewDecisionRequest() validation tests.
 */

import {
  parseAdaptiveReviewDecisionRequest,
  MAX_REVIEW_COMMENT_LENGTH,
  MAX_REVIEW_CONDITIONS_COUNT,
  MAX_REVIEW_CONDITION_LENGTH,
} from "@/lib/governance/adaptiveHumanReviewRequest";

const VALID_TIMESTAMP = "2026-07-30T00:00:00.000Z";

describe("parseAdaptiveReviewDecisionRequest", () => {
  it("accepts a valid 'approved' decision", () => {
    const result = parseAdaptiveReviewDecisionRequest({ status: "approved", expectedUpdatedAt: VALID_TIMESTAMP });
    expect(result).toEqual({
      ok: true,
      value: { status: "approved", comment: undefined, conditions: undefined, expectedUpdatedAt: VALID_TIMESTAMP },
    });
  });

  it("accepts a valid 'approved_with_conditions' decision", () => {
    const result = parseAdaptiveReviewDecisionRequest({
      status: "approved_with_conditions",
      conditions: ["Fix the citation", "Add a caveat"],
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("approved_with_conditions");
      expect(result.value.conditions).toEqual(["Fix the citation", "Add a caveat"]);
    }
  });

  it("accepts a valid 'changes_requested' decision", () => {
    const result = parseAdaptiveReviewDecisionRequest({
      status: "changes_requested",
      comment: "Please re-verify source 3.",
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(result).toEqual({
      ok: true,
      value: { status: "changes_requested", comment: "Please re-verify source 3.", conditions: undefined, expectedUpdatedAt: VALID_TIMESTAMP },
    });
  });

  it("accepts a valid 'rejected' decision", () => {
    const result = parseAdaptiveReviewDecisionRequest({
      status: "rejected",
      comment: "Conclusion is unsupported.",
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(result.ok).toBe(true);
  });

  it("'approved' rejects non-empty conditions", () => {
    const result = parseAdaptiveReviewDecisionRequest({
      status: "approved",
      conditions: ["should not be here"],
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(result).toEqual({ ok: false, reason: "conditions_not_allowed" });
  });

  it("'approved_with_conditions' requires at least one condition", () => {
    const missing = parseAdaptiveReviewDecisionRequest({ status: "approved_with_conditions", expectedUpdatedAt: VALID_TIMESTAMP });
    expect(missing).toEqual({ ok: false, reason: "conditions_required" });

    const empty = parseAdaptiveReviewDecisionRequest({
      status: "approved_with_conditions",
      conditions: ["   "],
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(empty).toEqual({ ok: false, reason: "conditions_required" });
  });

  it("'changes_requested' requires a non-empty comment", () => {
    const missing = parseAdaptiveReviewDecisionRequest({ status: "changes_requested", expectedUpdatedAt: VALID_TIMESTAMP });
    expect(missing).toEqual({ ok: false, reason: "comment_required" });

    const empty = parseAdaptiveReviewDecisionRequest({ status: "changes_requested", comment: "   ", expectedUpdatedAt: VALID_TIMESTAMP });
    expect(empty).toEqual({ ok: false, reason: "comment_required" });
  });

  it("'rejected' requires a non-empty comment", () => {
    const result = parseAdaptiveReviewDecisionRequest({ status: "rejected", expectedUpdatedAt: VALID_TIMESTAMP });
    expect(result).toEqual({ ok: false, reason: "comment_required" });
  });

  it("'changes_requested' and 'rejected' reject conditions", () => {
    const cr = parseAdaptiveReviewDecisionRequest({
      status: "changes_requested",
      comment: "fix it",
      conditions: ["x"],
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(cr).toEqual({ ok: false, reason: "conditions_not_allowed" });

    const rej = parseAdaptiveReviewDecisionRequest({
      status: "rejected",
      comment: "no",
      conditions: ["x"],
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(rej).toEqual({ ok: false, reason: "conditions_not_allowed" });
  });

  it("rejects 'unreviewed' as a request status", () => {
    const result = parseAdaptiveReviewDecisionRequest({ status: "unreviewed", expectedUpdatedAt: VALID_TIMESTAMP });
    expect(result).toEqual({ ok: false, reason: "invalid_status" });
  });

  it("rejects 'pending' as a request status", () => {
    const result = parseAdaptiveReviewDecisionRequest({ status: "pending", expectedUpdatedAt: VALID_TIMESTAMP });
    expect(result).toEqual({ ok: false, reason: "invalid_status" });
  });

  it("rejects an unrecognized status", () => {
    const result = parseAdaptiveReviewDecisionRequest({ status: "escalated", expectedUpdatedAt: VALID_TIMESTAMP });
    expect(result).toEqual({ ok: false, reason: "invalid_status" });
  });

  it("rejects a missing expectedUpdatedAt", () => {
    expect(parseAdaptiveReviewDecisionRequest({ status: "approved" })).toEqual({ ok: false, reason: "missing_expected_updated_at" });
    expect(parseAdaptiveReviewDecisionRequest({ status: "approved", expectedUpdatedAt: "" })).toEqual({
      ok: false,
      reason: "missing_expected_updated_at",
    });
  });

  it("rejects an invalid expectedUpdatedAt format", () => {
    const result = parseAdaptiveReviewDecisionRequest({ status: "approved", expectedUpdatedAt: "not-a-timestamp" });
    expect(result).toEqual({ ok: false, reason: "invalid_expected_updated_at" });
  });

  it("enforces the comment length limit", () => {
    const tooLong = "a".repeat(MAX_REVIEW_COMMENT_LENGTH + 1);
    const result = parseAdaptiveReviewDecisionRequest({ status: "rejected", comment: tooLong, expectedUpdatedAt: VALID_TIMESTAMP });
    expect(result).toEqual({ ok: false, reason: "comment_too_long" });

    const atLimit = "a".repeat(MAX_REVIEW_COMMENT_LENGTH);
    const ok = parseAdaptiveReviewDecisionRequest({ status: "rejected", comment: atLimit, expectedUpdatedAt: VALID_TIMESTAMP });
    expect(ok.ok).toBe(true);
  });

  it("enforces the condition item-count limit", () => {
    const tooMany = Array.from({ length: MAX_REVIEW_CONDITIONS_COUNT + 1 }, (_, i) => `condition ${i}`);
    const result = parseAdaptiveReviewDecisionRequest({
      status: "approved_with_conditions",
      conditions: tooMany,
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(result).toEqual({ ok: false, reason: "too_many_conditions" });

    const atLimit = Array.from({ length: MAX_REVIEW_CONDITIONS_COUNT }, (_, i) => `condition ${i}`);
    const ok = parseAdaptiveReviewDecisionRequest({
      status: "approved_with_conditions",
      conditions: atLimit,
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(ok.ok).toBe(true);
  });

  it("enforces the per-condition length limit", () => {
    const tooLong = "c".repeat(MAX_REVIEW_CONDITION_LENGTH + 1);
    const result = parseAdaptiveReviewDecisionRequest({
      status: "approved_with_conditions",
      conditions: [tooLong],
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(result).toEqual({ ok: false, reason: "condition_too_long" });
  });

  it("normalizes conditions: trims whitespace, drops empty-after-trim entries, deduplicates exact duplicates, preserves order", () => {
    const result = parseAdaptiveReviewDecisionRequest({
      status: "approved_with_conditions",
      conditions: ["  first  ", "second", "first", "   ", "third", "second"],
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.conditions).toEqual(["first", "second", "third"]);
    }
  });

  it("rejects a non-array conditions value", () => {
    const result = parseAdaptiveReviewDecisionRequest({
      status: "approved_with_conditions",
      conditions: "not an array",
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_conditions" });
  });

  it("rejects a conditions array containing a non-string element", () => {
    const result = parseAdaptiveReviewDecisionRequest({
      status: "approved_with_conditions",
      conditions: ["fine", 42],
      expectedUpdatedAt: VALID_TIMESTAMP,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_conditions" });
  });

  it("treats an empty-string comment as absent, not an empty comment", () => {
    const result = parseAdaptiveReviewDecisionRequest({ status: "approved", comment: "   ", expectedUpdatedAt: VALID_TIMESTAMP });
    expect(result).toEqual({
      ok: true,
      value: { status: "approved", comment: undefined, conditions: undefined, expectedUpdatedAt: VALID_TIMESTAMP },
    });
  });

  it("rejects a non-object body", () => {
    expect(parseAdaptiveReviewDecisionRequest(null)).toEqual({ ok: false, reason: "malformed_body" });
    expect(parseAdaptiveReviewDecisionRequest("approved")).toEqual({ ok: false, reason: "malformed_body" });
    expect(parseAdaptiveReviewDecisionRequest([1, 2, 3])).toEqual({ ok: false, reason: "malformed_body" });
  });

  it("never accepts reviewerId, reviewerName, teamId, userId, schemaId, answerShape, automatedGovernance, decisionReceipt, reviewedAt, or updatedAt", () => {
    const result = parseAdaptiveReviewDecisionRequest({
      status: "approved",
      expectedUpdatedAt: VALID_TIMESTAMP,
      reviewerId: "attacker-controlled",
      reviewerName: "Fake Name",
      teamId: "some-other-team",
      userId: "some-other-user",
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      automatedGovernance: { status: "passed" },
      decisionReceipt: { conclusion: "forged" },
      reviewedAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual(["comment", "conditions", "expectedUpdatedAt", "status"].sort());
    }
  });
});
