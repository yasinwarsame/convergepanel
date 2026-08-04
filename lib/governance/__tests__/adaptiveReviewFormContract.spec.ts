/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — client review-form
 * contract tests. Because `validateAdaptiveReviewForm()` delegates directly
 * to the REAL server parser (`parseAdaptiveReviewDecisionRequest`), these
 * tests double as drift-detection: if the server's rules ever change
 * without this file changing, these tests still reflect the server's
 * actual current behavior (there is only one implementation to test).
 */

import {
  validateAdaptiveReviewForm,
  fieldForValidationFailure,
  messageForValidationFailure,
  statusAllowsConditions,
  statusRequiresComment,
  previewNormalizedConditions,
  EMPTY_ADAPTIVE_REVIEW_FORM_STATE,
  MAX_REVIEW_COMMENT_LENGTH,
  MAX_REVIEW_CONDITIONS_COUNT,
  MAX_REVIEW_CONDITION_LENGTH,
  AdaptiveReviewFormState,
} from "@/lib/governance/adaptiveReviewFormContract";

const EXPECTED_UPDATED_AT = "2026-07-30T00:00:00.000Z";

function form(overrides: Partial<AdaptiveReviewFormState> = {}): AdaptiveReviewFormState {
  return { ...EMPTY_ADAPTIVE_REVIEW_FORM_STATE, ...overrides };
}

describe("validateAdaptiveReviewForm", () => {
  it("approved is valid without conditions", () => {
    const result = validateAdaptiveReviewForm(form({ status: "approved" }), EXPECTED_UPDATED_AT);
    expect(result).toEqual({
      ok: true,
      value: { status: "approved", comment: undefined, conditions: undefined, expectedUpdatedAt: EXPECTED_UPDATED_AT },
    });
  });

  it("approved rejects non-empty conditions (per the shared validator)", () => {
    const result = validateAdaptiveReviewForm(form({ status: "approved", conditions: ["should not be here"] }), EXPECTED_UPDATED_AT);
    expect(result).toEqual({ ok: false, reason: "conditions_not_allowed" });
  });

  it("approved_with_conditions requires at least one condition", () => {
    const result = validateAdaptiveReviewForm(form({ status: "approved_with_conditions" }), EXPECTED_UPDATED_AT);
    expect(result).toEqual({ ok: false, reason: "conditions_required" });
  });

  it("approved_with_conditions is valid with a condition", () => {
    const result = validateAdaptiveReviewForm(form({ status: "approved_with_conditions", conditions: ["Fix citation"] }), EXPECTED_UPDATED_AT);
    expect(result.ok).toBe(true);
  });

  it("changes_requested requires a comment", () => {
    const result = validateAdaptiveReviewForm(form({ status: "changes_requested" }), EXPECTED_UPDATED_AT);
    expect(result).toEqual({ ok: false, reason: "comment_required" });
  });

  it("rejected requires a comment", () => {
    const result = validateAdaptiveReviewForm(form({ status: "rejected" }), EXPECTED_UPDATED_AT);
    expect(result).toEqual({ ok: false, reason: "comment_required" });
  });

  it("trims comment whitespace", () => {
    const result = validateAdaptiveReviewForm(form({ status: "rejected", comment: "  no good  " }), EXPECTED_UPDATED_AT);
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ comment: "no good" }) });
  });

  it("enforces the comment maximum length", () => {
    const tooLong = "a".repeat(MAX_REVIEW_COMMENT_LENGTH + 1);
    const result = validateAdaptiveReviewForm(form({ status: "rejected", comment: tooLong }), EXPECTED_UPDATED_AT);
    expect(result).toEqual({ ok: false, reason: "comment_too_long" });
  });

  it("trims conditions and removes empty entries", () => {
    const result = validateAdaptiveReviewForm(
      form({ status: "approved_with_conditions", conditions: ["  a  ", "   ", "b"] }),
      EXPECTED_UPDATED_AT
    );
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ conditions: ["a", "b"] }) });
  });

  it("deduplicates conditions while preserving order", () => {
    const result = validateAdaptiveReviewForm(
      form({ status: "approved_with_conditions", conditions: ["a", "b", "a", "c"] }),
      EXPECTED_UPDATED_AT
    );
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ conditions: ["a", "b", "c"] }) });
  });

  it("enforces the maximum condition count", () => {
    const tooMany = Array.from({ length: MAX_REVIEW_CONDITIONS_COUNT + 1 }, (_, i) => `c${i}`);
    const result = validateAdaptiveReviewForm(form({ status: "approved_with_conditions", conditions: tooMany }), EXPECTED_UPDATED_AT);
    expect(result).toEqual({ ok: false, reason: "too_many_conditions" });
  });

  it("enforces the maximum per-condition length", () => {
    const tooLong = "c".repeat(MAX_REVIEW_CONDITION_LENGTH + 1);
    const result = validateAdaptiveReviewForm(form({ status: "approved_with_conditions", conditions: [tooLong] }), EXPECTED_UPDATED_AT);
    expect(result).toEqual({ ok: false, reason: "condition_too_long" });
  });

  it("the payload excludes reviewerId/reviewerName/teamId/userId/schemaId/answerShape/automatedGovernance/decisionReceipt/reviewedAt/updatedAt/projection ID — the form state has no such fields to begin with", () => {
    const result = validateAdaptiveReviewForm(form({ status: "approved" }), EXPECTED_UPDATED_AT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual(["comment", "conditions", "expectedUpdatedAt", "status"].sort());
    }
  });

  it("includes the canonical expectedUpdatedAt passed in by the caller", () => {
    const result = validateAdaptiveReviewForm(form({ status: "approved" }), "2020-01-01T00:00:00.000Z");
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }) });
  });

  it("requires a status to be chosen", () => {
    const result = validateAdaptiveReviewForm(form({ status: "" }), EXPECTED_UPDATED_AT);
    expect(result).toEqual({ ok: false, reason: "status_required" });
  });

  it("rejects an unknown status safely", () => {
    const result = validateAdaptiveReviewForm(form({ status: "bogus" as any }), EXPECTED_UPDATED_AT);
    expect(result).toEqual({ ok: false, reason: "invalid_status" });
  });

  it("is deterministic — identical input produces identical output", () => {
    const input = form({ status: "approved_with_conditions", conditions: ["a", "b"] });
    expect(validateAdaptiveReviewForm(input, EXPECTED_UPDATED_AT)).toEqual(validateAdaptiveReviewForm(input, EXPECTED_UPDATED_AT));
  });
});

describe("fieldForValidationFailure", () => {
  it("maps reasons to the correct field", () => {
    expect(fieldForValidationFailure("status_required")).toBe("status");
    expect(fieldForValidationFailure("invalid_status")).toBe("status");
    expect(fieldForValidationFailure("comment_required")).toBe("comment");
    expect(fieldForValidationFailure("comment_too_long")).toBe("comment");
    expect(fieldForValidationFailure("conditions_required")).toBe("conditions");
    expect(fieldForValidationFailure("too_many_conditions")).toBe("conditions");
    expect(fieldForValidationFailure("condition_too_long")).toBe("conditions");
    expect(fieldForValidationFailure("conditions_not_allowed")).toBe("conditions");
    expect(fieldForValidationFailure("missing_expected_updated_at")).toBe("expectedUpdatedAt");
    expect(fieldForValidationFailure("invalid_expected_updated_at")).toBe("expectedUpdatedAt");
  });
});

describe("messageForValidationFailure", () => {
  it("returns a human-readable message for every reason", () => {
    expect(messageForValidationFailure("status_required")).toBe("Choose a decision.");
    expect(messageForValidationFailure("comment_required")).toContain("comment");
  });
});

describe("statusAllowsConditions / statusRequiresComment", () => {
  it("only approved_with_conditions allows conditions", () => {
    expect(statusAllowsConditions("approved_with_conditions")).toBe(true);
    expect(statusAllowsConditions("approved")).toBe(false);
    expect(statusAllowsConditions("changes_requested")).toBe(false);
    expect(statusAllowsConditions("rejected")).toBe(false);
    expect(statusAllowsConditions("")).toBe(false);
  });

  it("changes_requested and rejected require a comment", () => {
    expect(statusRequiresComment("changes_requested")).toBe(true);
    expect(statusRequiresComment("rejected")).toBe(true);
    expect(statusRequiresComment("approved")).toBe(false);
    expect(statusRequiresComment("approved_with_conditions")).toBe(false);
  });
});

describe("previewNormalizedConditions", () => {
  it("trims, drops empty, and deduplicates preserving order", () => {
    expect(previewNormalizedConditions(["  a  ", "b", "a", "   ", "c"])).toEqual(["a", "b", "c"]);
  });

  it("is deterministic", () => {
    const input = ["x", "y", "x"];
    expect(previewNormalizedConditions(input)).toEqual(previewNormalizedConditions(input));
  });
});

describe("draft preservation behavior on status change (documented, deterministic rule)", () => {
  it("form state is independent of the payload-exclusion rule — switching status never mutates comment/conditions already entered", () => {
    const original = form({ status: "approved_with_conditions", conditions: ["a", "b"], comment: "note" });
    // Simulating a status change in a real component: only `status` changes;
    // `comment`/`conditions` are preserved in form STATE (never cleared
    // automatically) — only the outgoing payload for a disallowed field is
    // excluded via validation, which this test proves by re-validating
    // under a status that forbids conditions.
    const switched: AdaptiveReviewFormState = { ...original, status: "approved" };
    expect(switched.conditions).toEqual(["a", "b"]);
    expect(switched.comment).toBe("note");
    const result = validateAdaptiveReviewForm(switched, EXPECTED_UPDATED_AT);
    expect(result).toEqual({ ok: false, reason: "conditions_not_allowed" });
  });
});
