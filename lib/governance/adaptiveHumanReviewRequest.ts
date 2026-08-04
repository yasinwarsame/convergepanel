/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D — request-body
 * validation for `POST /api/teams/adaptive-runs/{runId}/decision`
 * (docs/governance-decision-receipts-design.md §21.5).
 *
 * Pure, synchronous, zero I/O. Deliberately does NOT accept or validate
 * `reviewerId`/`reviewerName`/`teamId`/`userId`/`schemaId`/`answerShape`/
 * `automatedGovernance`/`decisionReceipt`/`reviewedAt`/`updatedAt` — none of
 * those are read from the request body at all, so there is nothing here
 * that could accidentally trust a client-supplied value for any of them.
 * `"unreviewed"`/`"pending"` are rejected as request STATUSES by
 * construction (`ADAPTIVE_REVIEW_DECISION_STATUSES` only contains the 4
 * terminal values) — this route only ever submits a terminal decision.
 */

import { isValidTimestamp } from "../adaptiveSchema/governanceRecordParser";

export type AdaptiveReviewDecisionStatus = "approved" | "approved_with_conditions" | "changes_requested" | "rejected";

/**
 * Exported (Multi-Reviewer Vote Contract, Part C) so the vote request
 * parser (`lib/governance/adaptiveHumanReviewVote.ts`) can validate a
 * vote's `status` field against the SAME vocabulary this module already
 * enforces, rather than an independently-drifting copy.
 */
export const ADAPTIVE_REVIEW_DECISION_STATUSES: ReadonlySet<string> = new Set([
  "approved",
  "approved_with_conditions",
  "changes_requested",
  "rejected",
]);

/** Matches the existing legacy `teamRuns` decision route's own 4000-char precedent for a free-text review note (`app/api/teams/runs/[runId]/decision/route.ts`) — reused rather than inventing a new limit for a conceptually identical field. */
export const MAX_REVIEW_COMMENT_LENGTH = 4000;
/** Chosen to comfortably cover a real conditions list (a handful of approval caveats) without allowing an unbounded array. */
export const MAX_REVIEW_CONDITIONS_COUNT = 20;
/** Per-condition length — generous for a single caveat sentence, not a paragraph. */
export const MAX_REVIEW_CONDITION_LENGTH = 500;

/**
 * A separate "maximum total conditions length" is deliberately NOT
 * enforced: `MAX_REVIEW_CONDITIONS_COUNT * MAX_REVIEW_CONDITION_LENGTH`
 * (20 * 500 = 10,000 chars) already bounds the total, so a third, redundant
 * limit would add no real protection — the instruction's own "if useful"
 * qualifier is read as permission to skip it here.
 */

export interface ParsedAdaptiveReviewDecision {
  status: AdaptiveReviewDecisionStatus;
  comment?: string;
  conditions?: string[];
  expectedUpdatedAt: string;
}

export type AdaptiveReviewDecisionValidationFailureReason =
  | "malformed_body"
  | "invalid_status"
  | "missing_expected_updated_at"
  | "invalid_expected_updated_at"
  | "comment_too_long"
  | "comment_required"
  | "conditions_not_allowed"
  | "conditions_required"
  | "too_many_conditions"
  | "condition_too_long"
  | "invalid_conditions";

export type AdaptiveReviewDecisionValidationResult =
  | { ok: true; value: ParsedAdaptiveReviewDecision }
  | { ok: false; reason: AdaptiveReviewDecisionValidationFailureReason };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalizes a raw `conditions` value: trims each entry, drops entries that
 * become empty after trimming (a defensive normalization choice — an
 * empty-after-trim string carries no information as a "condition"), then
 * deduplicates EXACT duplicates while preserving first-occurrence order.
 * Returns `undefined` on any structurally invalid input (not an array, or
 * containing a non-string element) so the caller can reject with
 * `invalid_conditions` rather than silently coercing bad data.
 */
function normalizeConditions(raw: unknown): string[] | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return "invalid";
  const trimmed: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return "invalid";
    const t = item.trim();
    if (t.length > 0) trimmed.push(t);
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of trimmed) {
    if (!seen.has(item)) {
      seen.add(item);
      deduped.push(item);
    }
  }
  return deduped;
}

/** The subset of `AdaptiveReviewDecisionValidationFailureReason` that `validateAdaptiveReviewCommentAndConditions` below can itself produce — everything except the two `expectedUpdatedAt`-specific reasons and `invalid_status` (status is validated by the CALLER before this function is invoked, since a vote request and a decision request each embed `status` differently). */
export type AdaptiveReviewCommentConditionsFailureReason =
  | "malformed_body"
  | "comment_too_long"
  | "comment_required"
  | "conditions_not_allowed"
  | "conditions_required"
  | "too_many_conditions"
  | "condition_too_long"
  | "invalid_conditions";

export type AdaptiveReviewCommentConditionsResult =
  | { ok: true; value: { comment?: string; conditions?: string[] } }
  | { ok: false; reason: AdaptiveReviewCommentConditionsFailureReason };

/** The subset of failure reasons `validateConditionsForStatus` below can itself produce. */
export type ConditionsForStatusFailureReason = "invalid_conditions" | "too_many_conditions" | "condition_too_long" | "conditions_not_allowed" | "conditions_required";

export type ValidateConditionsForStatusResult =
  | { ok: true; conditions: string[] | undefined }
  | { ok: false; reason: ConditionsForStatusFailureReason };

/**
 * Multi-Reviewer Owner Override, Part F — extracted from
 * `validateAdaptiveReviewCommentAndConditions` below so the override
 * request validator (`lib/governance/adaptivePanelOverride.ts`) can reuse
 * the EXACT SAME conditions-normalization and status-conditions rule
 * (conditions required for `approved_with_conditions`, forbidden
 * otherwise) WITHOUT also inheriting the comment-required-for-
 * changes_requested/rejected rule, which does not apply to override
 * requests (override has a separately-validated, ALWAYS-required
 * `justification` field instead of a per-status-conditional `comment`).
 * Reused, not forked — one normalization/limit implementation.
 */
export function validateConditionsForStatus(status: AdaptiveReviewDecisionStatus, rawConditions: unknown): ValidateConditionsForStatusResult {
  const normalizedConditions = normalizeConditions(rawConditions);
  if (normalizedConditions === "invalid") {
    return { ok: false, reason: "invalid_conditions" };
  }
  if (normalizedConditions && normalizedConditions.length > MAX_REVIEW_CONDITIONS_COUNT) {
    return { ok: false, reason: "too_many_conditions" };
  }
  if (normalizedConditions?.some((c) => c.length > MAX_REVIEW_CONDITION_LENGTH)) {
    return { ok: false, reason: "condition_too_long" };
  }
  const conditions = normalizedConditions && normalizedConditions.length > 0 ? normalizedConditions : undefined;

  if (status === "approved_with_conditions") {
    if (!conditions) return { ok: false, reason: "conditions_required" };
  } else {
    if (conditions) return { ok: false, reason: "conditions_not_allowed" };
  }

  return { ok: true, conditions };
}

/**
 * Multi-Reviewer Vote Contract, Part C — extracted from
 * `parseAdaptiveReviewDecisionRequest` below so the vote request parser
 * (`lib/governance/adaptiveHumanReviewVote.ts`) can reuse the EXACT same
 * status-specific comment/conditions rules and limits rather than forking
 * a second implementation that could silently drift. This module has no
 * `server-only` dependency (pure, synchronous, zero I/O) so the extraction
 * needed only be a refactor, not a new file — `parseAdaptiveReviewDecisionRequest`
 * itself is refactored to call this function internally, with its own
 * exact original behavior verified unchanged by its existing test suite
 * (`adaptiveHumanReviewValidation.spec.ts`).
 *
 * Takes an ALREADY-VALIDATED `status` (the caller — decision request or
 * vote request — validates `status` itself first, since the two request
 * shapes embed it identically but validate it via their own
 * `invalid_status`-shaped error convention).
 *
 * Status-specific rules (§21.5's own table, reused verbatim for votes):
 * - `approved`: conditions must be absent/empty; comment optional.
 * - `approved_with_conditions`: at least one non-empty condition required; comment optional.
 * - `changes_requested`: non-empty comment required; conditions must be absent/empty.
 * - `rejected`: non-empty comment required; conditions must be absent/empty.
 *
 * Order preserved exactly (verified against the pre-existing test suite,
 * unchanged): conditions-related rules are checked (via
 * `validateConditionsForStatus`) BEFORE the comment-required rule for
 * `changes_requested`/`rejected` — identical precedence to the original,
 * non-extracted implementation.
 */
export function validateAdaptiveReviewCommentAndConditions(
  status: AdaptiveReviewDecisionStatus,
  rawComment: unknown,
  rawConditions: unknown
): AdaptiveReviewCommentConditionsResult {
  let comment: string | undefined;
  if (rawComment !== undefined) {
    if (typeof rawComment !== "string") {
      return { ok: false, reason: "malformed_body" };
    }
    const trimmed = rawComment.trim();
    if (trimmed.length > MAX_REVIEW_COMMENT_LENGTH) {
      return { ok: false, reason: "comment_too_long" };
    }
    // An empty string becomes absent, not an empty comment.
    comment = trimmed.length > 0 ? trimmed : undefined;
  }

  const conditionsResult = validateConditionsForStatus(status, rawConditions);
  if (!conditionsResult.ok) {
    return conditionsResult;
  }
  const conditions = conditionsResult.conditions;

  if (status === "changes_requested" || status === "rejected") {
    if (!comment) return { ok: false, reason: "comment_required" };
  }

  return { ok: true, value: { comment, conditions } };
}

/**
 * Validates the raw, untrusted request body for the adaptive human-review
 * decision route. Delegates its shared comment/conditions rules to
 * `validateAdaptiveReviewCommentAndConditions` above — this function's own
 * job is only the fields specific to a DECISION request (`status` as a
 * decision status, `expectedUpdatedAt`).
 */
export function parseAdaptiveReviewDecisionRequest(raw: unknown): AdaptiveReviewDecisionValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "malformed_body" };
  }

  if (typeof raw.status !== "string" || !ADAPTIVE_REVIEW_DECISION_STATUSES.has(raw.status)) {
    return { ok: false, reason: "invalid_status" };
  }
  const status = raw.status as AdaptiveReviewDecisionStatus;

  if (raw.expectedUpdatedAt === undefined || raw.expectedUpdatedAt === null || raw.expectedUpdatedAt === "") {
    return { ok: false, reason: "missing_expected_updated_at" };
  }
  if (!isValidTimestamp(raw.expectedUpdatedAt)) {
    return { ok: false, reason: "invalid_expected_updated_at" };
  }
  const expectedUpdatedAt = raw.expectedUpdatedAt;

  const core = validateAdaptiveReviewCommentAndConditions(status, raw.comment, raw.conditions);
  if (!core.ok) {
    return core;
  }

  return {
    ok: true,
    value: { status, comment: core.value.comment, conditions: core.value.conditions, expectedUpdatedAt },
  };
}
