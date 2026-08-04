/**
 * Query-Routing Redesign, Phase 2A, Step 4 — runtime validation and
 * immutability rules for `GovernanceRecordV1` (governanceRecord.ts's
 * contract), read back from Firestore-originated data. Mirrors
 * persistedOutput.ts's own `parsePersistedAdaptiveOutput` deliberately: same
 * four-state failure vocabulary, same "structural check sufficient to
 * prevent a caller from trusting corrupted data" scope (not a second
 * independent proof of every nested field), same never-throws guarantee.
 *
 * `AdaptiveDecisionReceipt` is validated as the ACTUAL uniform eight-field
 * shape defined in governanceRecord.ts — conclusion/basis/assumptions/
 * uncertainties/limitations/sources/sourceBacked/humanReviewNeeded — NOT as
 * a per-schema discriminated union. Schema-specific content (ranked items,
 * comparison subjects/criteria, causal factors, a decision recommendation,
 * evidence dimensions, etc.) was already flattened into that uniform shape
 * by decisionReceiptBuilder.ts in Step 3; no persisted schema-specific
 * receipt union exists in this codebase, so none is validated here. The
 * receipt itself carries no `schemaId` field of its own — its schema
 * association is only ever the PARENT `GovernanceRecordV1.schemaId`,
 * checked once against `answerShape` via the registry's real
 * `SCHEMA_ANSWER_SHAPE` mapping, never re-derived on the receipt.
 *
 * This module implements pure validation and immutability logic only — no
 * Firestore reads/writes, no API route wiring, no automated-governance
 * trigger, no `teamRuns`/dashboard/history/export integration. That wiring
 * is explicitly deferred to a later step.
 */

import { PersistedAdaptiveSchemaId, SCHEMA_ANSWER_SHAPE } from "./persistedOutput";
import { AdaptiveDecisionReceipt, GovernanceRecordV1 } from "./governanceRecord";

const SUPPORTED_SCHEMA_IDS = new Set<string>(Object.keys(SCHEMA_ANSWER_SHAPE));

/**
 * Exported (Phase 2A, Step 7, Part E1) so the team-run list classifier
 * (`lib/governance/teamRunListContract.ts`) can validate a raw projection's
 * `automatedGovernanceStatus` against the SAME vocabulary this module
 * already enforces, rather than an independently-drifting copy.
 */
export const AUTOMATED_GOVERNANCE_STATUSES = new Set(["passed", "flagged", "blocked", "not_evaluated", "error"]);

export type HumanReviewStatus = GovernanceRecordV1["humanReview"]["status"];

/** Exported alongside `AUTOMATED_GOVERNANCE_STATUSES` for the same reuse reason (Phase 2A, Step 7, Part E1). */
export const HUMAN_REVIEW_STATUSES = new Set<HumanReviewStatus>([
  "unreviewed",
  "pending",
  "approved",
  "approved_with_conditions",
  "changes_requested",
  "rejected",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Exported (Phase 2A, Step 7, Part D) so `lib/governance/adaptiveHumanReviewRequest.ts`
 * can validate `expectedUpdatedAt`'s format using the SAME check this
 * module already applies to every other timestamp field, rather than a
 * second, independently-drifting implementation of "is this a valid ISO
 * timestamp string."
 */
export function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isValidOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isValidTimestamp(value);
}

function isValidOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isValidAutomatedGovernance(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  if (typeof value.status !== "string" || !AUTOMATED_GOVERNANCE_STATUSES.has(value.status)) return false;
  if (!isStringArray(value.reasons)) return false;
  if (!isValidOptionalTimestamp(value.evaluatedAt)) return false;
  if (value.policyVersion !== undefined && typeof value.policyVersion !== "number") return false;
  if (!isValidOptionalString(value.notEvaluatedReason)) return false;
  return true;
}

function isValidHumanReview(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.status !== "string" || !HUMAN_REVIEW_STATUSES.has(value.status as HumanReviewStatus)) return false;
  if (!isValidOptionalString(value.reviewerId)) return false;
  if (!isValidOptionalString(value.reviewerName)) return false;
  if (!isValidOptionalTimestamp(value.reviewedAt)) return false;
  if (!isValidOptionalString(value.comment)) return false;
  if (value.conditions !== undefined && !isStringArray(value.conditions)) return false;
  return true;
}

/** Validates the real, uniform eight-field `AdaptiveDecisionReceipt` shape only — see module doc. */
function isValidDecisionReceipt(value: unknown): value is AdaptiveDecisionReceipt {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.conclusion === "string" &&
    isStringArray(value.basis) &&
    isStringArray(value.assumptions) &&
    isStringArray(value.uncertainties) &&
    isStringArray(value.limitations) &&
    isStringArray(value.sources) &&
    typeof value.sourceBacked === "boolean" &&
    typeof value.humanReviewNeeded === "boolean"
  );
}

/** Why parsing failed — mirrors PersistedAdaptiveOutputFailureReason's own vocabulary and rationale (persistedOutput.ts). */
export type GovernanceRecordParseFailureReason = "absent" | "unsupported_version" | "malformed";

export type GovernanceRecordParseResult =
  | { ok: true; record: GovernanceRecordV1 }
  | { ok: false; reason: GovernanceRecordParseFailureReason };

/**
 * Never throws. `raw` is whatever Firestore handed back for a run
 * document's `governanceRecord` field — untrusted by construction (could be
 * absent, from a future schema version, or corrupted by a partial write).
 * Failure reasons are fixed, static strings only — never echo any part of
 * the raw receipt content back to the caller, so a corrupted document can't
 * leak its own text through an error/logging path.
 */
export function parseGovernanceRecord(raw: unknown): GovernanceRecordParseResult {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "absent" };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "malformed" };
  }
  if (raw.version !== 1) {
    return { ok: false, reason: "unsupported_version" };
  }

  const schemaId = raw.schemaId;
  if (typeof schemaId !== "string" || !SUPPORTED_SCHEMA_IDS.has(schemaId)) {
    return { ok: false, reason: "malformed" };
  }
  const typedSchemaId = schemaId as PersistedAdaptiveSchemaId;

  // Rejects a mismatched schemaId/answerShape pair, using the registry's
  // real mapping — the same one persistedOutput.ts's own parser checks
  // against, not a redefined copy.
  if (raw.answerShape !== SCHEMA_ANSWER_SHAPE[typedSchemaId]) {
    return { ok: false, reason: "malformed" };
  }

  if (raw.adaptiveOutputVersion !== 1) {
    return { ok: false, reason: "malformed" };
  }

  if (!isValidAutomatedGovernance(raw.automatedGovernance)) {
    return { ok: false, reason: "malformed" };
  }

  if (!isValidHumanReview(raw.humanReview)) {
    return { ok: false, reason: "malformed" };
  }

  if (!isValidDecisionReceipt(raw.decisionReceipt)) {
    return { ok: false, reason: "malformed" };
  }

  if (!isValidTimestamp(raw.createdAt) || !isValidTimestamp(raw.updatedAt)) {
    return { ok: false, reason: "malformed" };
  }

  return { ok: true, record: raw as unknown as GovernanceRecordV1 };
}

/**
 * Whether a `governanceRecord`'s `decisionReceipt` may be regenerated
 * (rebuilt from the current `adaptiveOutput` via
 * `buildAdaptiveDecisionReceipt`) given its current parsed state.
 *
 * `pending` is a NEW Phase 2A semantic choice, not inherited System B
 * behavior — System B's single-reviewer flow (see
 * docs/governance-decision-receipts-design.md §6) has no live "pending"
 * state at all; it goes directly from "needs_review" to a terminal
 * decision in one action. `GovernanceRecordV1.humanReview`'s `"pending"` is
 * new vocabulary introduced by this contract, so there is no legacy rule to
 * verify it against. The chosen rule: `pending` means a review has been
 * started/assigned but has not yet reached a substantive human decision, so
 * a refresh is still safe — nothing has been decided that a rebuilt receipt
 * could contradict. Once any terminal or evaluative outcome exists
 * (approved, approved_with_conditions, changes_requested, rejected), the
 * receipt becomes immutable, because a reviewer's decision was made about
 * the SPECIFIC content that existed at that time.
 */
export type ReceiptRefreshDecision =
  | { allowed: true; reason: "absent" | "unreviewed" | "pending" }
  | {
      allowed: false;
      reason: "approved" | "approved_with_conditions" | "changes_requested" | "rejected" | "malformed" | "unsupported_version";
    };

/**
 * Pure — takes the result of `parseGovernanceRecord` directly rather than
 * re-deriving parse state, so refresh eligibility can never disagree with
 * what the parser itself found.
 */
/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D
 * (docs/governance-decision-receipts-design.md §21.4) — whether a
 * `humanReview.status` may still be moved to a terminal decision. Reuses
 * the IDENTICAL terminal/non-terminal classification `canRefreshDecisionReceipt`
 * already applies (both answer "has a substantive human decision been made
 * about this run yet?"), but is deliberately a SEPARATE, separately-named
 * function rather than a shared call — the two answer conceptually
 * different questions (receipt-refresh eligibility vs. review-submission
 * eligibility) that happen to share a classification today; conflating
 * their names would let a future change to one silently affect the other's
 * meaning. This predicate takes the STATUS directly (not a parse result),
 * since the transactional caller (`submitAdaptiveHumanReview`, Part D)
 * already has a parsed, `ok: true` record in hand by the time it needs
 * this check — there is no "absent"/"malformed" case to route through
 * here, unlike `canRefreshDecisionReceipt`.
 */
export function isHumanReviewStatusReviewable(status: HumanReviewStatus): boolean {
  return status === "unreviewed" || status === "pending";
}

export function canRefreshDecisionReceipt(parseResult: GovernanceRecordParseResult): ReceiptRefreshDecision {
  if (!parseResult.ok) {
    if (parseResult.reason === "absent") {
      return { allowed: true, reason: "absent" };
    }
    return { allowed: false, reason: parseResult.reason };
  }

  const status = parseResult.record.humanReview.status;
  if (status === "unreviewed" || status === "pending") {
    return { allowed: true, reason: status };
  }
  return { allowed: false, reason: status };
}

/** Caller-supplied review decision — the fields `applyHumanReviewUpdate` is allowed to change. */
export interface HumanReviewUpdate {
  status: HumanReviewStatus;
  reviewerId?: string;
  reviewerName?: string;
  reviewedAt?: string;
  comment?: string;
  conditions?: string[];
}

export type HumanReviewUpdateFailureReason = "invalid_status" | "invalid_fields" | "invalid_timestamp" | "conditions_required";

export type HumanReviewUpdateResult = { ok: true; record: GovernanceRecordV1 } | { ok: false; reason: HumanReviewUpdateFailureReason };

/**
 * Pure. Returns a NEW `GovernanceRecordV1` — never mutates `record` or
 * `update`. Touches only `humanReview` and `updatedAt`; `decisionReceipt`,
 * `schemaId`, `answerShape`, `adaptiveOutputVersion`, and `createdAt` are
 * carried over unchanged, and `automatedGovernance` is preserved exactly as
 * it was (this helper never evaluates or alters automated governance).
 *
 * `now` is an injected timestamp (defaults to the real current time) so
 * callers/tests can produce deterministic output without mocking the
 * system clock.
 */
export function applyHumanReviewUpdate(
  record: GovernanceRecordV1,
  update: HumanReviewUpdate,
  now: string = new Date().toISOString()
): HumanReviewUpdateResult {
  if (typeof update.status !== "string" || !HUMAN_REVIEW_STATUSES.has(update.status)) {
    return { ok: false, reason: "invalid_status" };
  }
  if (!isValidOptionalString(update.reviewerId) || !isValidOptionalString(update.reviewerName) || !isValidOptionalString(update.comment)) {
    return { ok: false, reason: "invalid_fields" };
  }
  if (!isValidOptionalTimestamp(update.reviewedAt)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  if (update.conditions !== undefined && !isStringArray(update.conditions)) {
    return { ok: false, reason: "invalid_fields" };
  }

  const requiresConditions = update.status === "approved_with_conditions";
  if (requiresConditions && (!update.conditions || update.conditions.length === 0)) {
    return { ok: false, reason: "conditions_required" };
  }

  const updatedRecord: GovernanceRecordV1 = {
    ...record,
    humanReview: {
      status: update.status,
      reviewerId: update.reviewerId,
      reviewerName: update.reviewerName,
      reviewedAt: update.reviewedAt,
      comment: update.comment,
      // Stale conditions are cleared for every status except
      // approved_with_conditions — a status change away from it must not
      // silently leave a prior review's conditions attached.
      conditions: requiresConditions ? update.conditions : undefined,
    },
    updatedAt: now,
  };

  return { ok: true, record: updatedRecord };
}

/**
 * Query-Routing Redesign, Phase 2A, Step 6B, Part B — pure update helper
 * for the adaptive automated-governance result (docs/governance-decision-receipts-design.md
 * §18.7). Mirrors `applyHumanReviewUpdate`'s own shape exactly: a result
 * union instead of a throw, spread-based construction so every field but
 * `automatedGovernance`/`updatedAt` is carried over unchanged BY
 * CONSTRUCTION (a spread field that's never reassigned can't drift) —
 * `decisionReceipt` and `humanReview` in particular are preserved
 * byte-for-byte, never touched, never regenerated.
 *
 * Automated re-evaluation is allowed after human review, deliberately:
 * `automatedGovernance` and `humanReview` are independent dimensions,
 * exactly like `decisionReceipt` and `humanReview` were kept independent
 * in Step 2 — this helper has no branch that reads or is gated by
 * `humanReview.status` at all, so a human decision can never be
 * retroactively affected by re-running the automated pass.
 */
export type ApplyAutomatedGovernanceUpdateFailureReason = "invalid_timestamp" | "invalid_automated_governance";

export type ApplyAutomatedGovernanceUpdateResult =
  | { ok: true; record: GovernanceRecordV1 }
  | { ok: false; reason: ApplyAutomatedGovernanceUpdateFailureReason };

export function applyAutomatedGovernanceUpdate(
  record: GovernanceRecordV1,
  automatedGovernance: NonNullable<GovernanceRecordV1["automatedGovernance"]>,
  now: string
): ApplyAutomatedGovernanceUpdateResult {
  if (typeof now !== "string" || !isValidTimestamp(now)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  if (!isValidAutomatedGovernance(automatedGovernance)) {
    return { ok: false, reason: "invalid_automated_governance" };
  }

  return {
    ok: true,
    record: { ...record, automatedGovernance, updatedAt: now },
  };
}
