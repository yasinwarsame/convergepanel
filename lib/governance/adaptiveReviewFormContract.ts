/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — client-safe adaptive
 * review DECISION form contract (docs/governance-decision-receipts-design.md
 * §26). Entirely pure, no I/O, no React — safe to import from both client
 * components and tests.
 *
 * Deliberately does NOT reimplement validation: `parseAdaptiveReviewDecisionRequest()`
 * and its constants (`lib/governance/adaptiveHumanReviewRequest.ts`, Part D)
 * have no `server-only` guard and no Node-only import anywhere in their own
 * dependency chain (verified directly, not assumed) — they are pure,
 * framework-agnostic functions. This module imports and calls that EXACT
 * function directly, so client validation can never subtly drift from the
 * server's — there is only one implementation, not two kept in sync by
 * hand.
 */

import {
  parseAdaptiveReviewDecisionRequest,
  AdaptiveReviewDecisionStatus,
  AdaptiveReviewDecisionValidationFailureReason,
  ParsedAdaptiveReviewDecision,
  MAX_REVIEW_COMMENT_LENGTH,
  MAX_REVIEW_CONDITIONS_COUNT,
  MAX_REVIEW_CONDITION_LENGTH,
} from "./adaptiveHumanReviewRequest";

export type { AdaptiveReviewDecisionStatus };
export { MAX_REVIEW_COMMENT_LENGTH, MAX_REVIEW_CONDITIONS_COUNT, MAX_REVIEW_CONDITION_LENGTH };

export const ADAPTIVE_REVIEW_DECISION_STATUS_OPTIONS: readonly AdaptiveReviewDecisionStatus[] = [
  "approved",
  "approved_with_conditions",
  "changes_requested",
  "rejected",
];

/** The in-progress form's own state — never the wire request shape. `status: ""` means no choice has been made yet (a client-only concern; the server never sees an empty status). */
export type AdaptiveReviewFormState = {
  status: AdaptiveReviewDecisionStatus | "";
  comment: string;
  conditions: string[];
};

export const EMPTY_ADAPTIVE_REVIEW_FORM_STATE: AdaptiveReviewFormState = {
  status: "",
  comment: "",
  conditions: [],
};

/** The exact wire request shape — never reviewerId/reviewerName/teamId/userId/schemaId/answerShape/automatedGovernance/decisionReceipt/reviewedAt/updatedAt (as an authoritative value)/projection ID. `expectedUpdatedAt` must always be the most recently fetched canonical `detail.review.updatedAt` — never sourced from a `teamRuns` projection. */
export type AdaptiveReviewDecisionRequest = {
  status: AdaptiveReviewDecisionStatus;
  comment?: string;
  conditions?: string[];
  expectedUpdatedAt: string;
};

export type AdaptiveReviewFormValidationFailureReason = "status_required" | AdaptiveReviewDecisionValidationFailureReason;

export type AdaptiveReviewFormValidationResult =
  | { ok: true; value: AdaptiveReviewDecisionRequest }
  | { ok: false; reason: AdaptiveReviewFormValidationFailureReason };

/**
 * Validates the in-progress form state against `expectedUpdatedAt`
 * (supplied by the caller — always the current canonical detail response's
 * `updatedAt`, never read from the form itself). Delegates every
 * status/comment/conditions rule to the REAL server parser — this function
 * only adds the one genuinely client-only concern (`status` not yet
 * chosen).
 */
export function validateAdaptiveReviewForm(form: AdaptiveReviewFormState, expectedUpdatedAt: string): AdaptiveReviewFormValidationResult {
  if (form.status === "") {
    return { ok: false, reason: "status_required" };
  }
  const result = parseAdaptiveReviewDecisionRequest({
    status: form.status,
    comment: form.comment,
    conditions: form.conditions,
    expectedUpdatedAt,
  });
  if (!result.ok) {
    return result;
  }
  const value: ParsedAdaptiveReviewDecision = result.value;
  return {
    ok: true,
    value: {
      status: value.status,
      comment: value.comment,
      conditions: value.conditions,
      expectedUpdatedAt: value.expectedUpdatedAt,
    },
  };
}

/** Which form field a validation-failure reason concerns — for inline field-error placement, not just a status-level summary. */
export type AdaptiveReviewFormField = "status" | "comment" | "conditions" | "expectedUpdatedAt";

export function fieldForValidationFailure(reason: AdaptiveReviewFormValidationFailureReason): AdaptiveReviewFormField {
  switch (reason) {
    case "status_required":
    case "invalid_status":
      return "status";
    case "comment_too_long":
    case "comment_required":
      return "comment";
    case "conditions_not_allowed":
    case "conditions_required":
    case "too_many_conditions":
    case "condition_too_long":
    case "invalid_conditions":
      return "conditions";
    case "missing_expected_updated_at":
    case "invalid_expected_updated_at":
      return "expectedUpdatedAt";
    case "malformed_body":
    default:
      return "status";
  }
}

const VALIDATION_FAILURE_MESSAGES: Record<AdaptiveReviewFormValidationFailureReason, string> = {
  status_required: "Choose a decision.",
  invalid_status: "Choose a valid decision.",
  malformed_body: "Something went wrong preparing this request.",
  missing_expected_updated_at: "This review's current state could not be determined. Reload and try again.",
  invalid_expected_updated_at: "This review's current state could not be determined. Reload and try again.",
  comment_too_long: `Comment must be ${MAX_REVIEW_COMMENT_LENGTH.toLocaleString()} characters or fewer.`,
  comment_required: "A comment is required for this decision.",
  conditions_not_allowed: "Conditions can only be added for “Approve with Conditions.”",
  conditions_required: "Add at least one condition.",
  too_many_conditions: `No more than ${MAX_REVIEW_CONDITIONS_COUNT} conditions are allowed.`,
  condition_too_long: `Each condition must be ${MAX_REVIEW_CONDITION_LENGTH} characters or fewer.`,
  invalid_conditions: "Conditions could not be read. Please re-enter them.",
};

export function messageForValidationFailure(reason: AdaptiveReviewFormValidationFailureReason): string {
  return VALIDATION_FAILURE_MESSAGES[reason] ?? "This decision could not be submitted.";
}

/**
 * Whether `conditions` are allowed at all for a given status — used to
 * decide whether to exclude the conditions field from the submitted
 * payload when the user switches status. Form STATE itself is never
 * cleared automatically (§26.3's chosen behavior, documented below) —
 * only the outgoing payload omits disallowed fields.
 */
export function statusAllowsConditions(status: AdaptiveReviewDecisionStatus | ""): boolean {
  return status === "approved_with_conditions";
}

/** Whether a comment is REQUIRED (not just allowed) for a given status. */
export function statusRequiresComment(status: AdaptiveReviewDecisionStatus | ""): boolean {
  return status === "changes_requested" || status === "rejected";
}

/**
 * Deterministic condition normalization for the LIVE UI preview (trim,
 * drop empty-after-trim, dedupe exact duplicates preserving first-occurrence
 * order) — mirrors the server's own `normalizeConditions()` behavior
 * exactly (same rules, re-implemented here only because that helper isn't
 * itself exported from the server module; the VALIDATION result is still
 * always produced by the real, shared `parseAdaptiveReviewDecisionRequest()`
 * above, so this is a display-preview convenience, never the source of
 * truth for what gets submitted or accepted).
 */
export function previewNormalizedConditions(raw: string[]): string[] {
  const trimmed = raw.map((c) => c.trim()).filter((c) => c.length > 0);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const c of trimmed) {
    if (!seen.has(c)) {
      seen.add(c);
      deduped.push(c);
    }
  }
  return deduped;
}
