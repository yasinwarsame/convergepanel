/**
 * Immutable Multi-Reviewer Vote Contract and Submission, Part C
 * (docs/governance-decision-receipts-design.md §29, §30, §31). Pure model,
 * deterministic identity, request parser, and stored-document parser for a
 * single panel reviewer's vote. No I/O.
 *
 * PART C SCOPE ONLY: no aggregation, no quorum completion, no
 * finalization, no canonical `governanceRecord.humanReview` write, no
 * vote editing/withdrawal/supersession. A vote, once created, is
 * immutable forever — there is no code path anywhere in this module or
 * its Firestore-layer caller (`lib/firestore/runs.ts`) that overwrites an
 * existing vote document.
 */

import { isValidTimestamp } from "../adaptiveSchema/governanceRecordParser";
import {
  AdaptiveReviewDecisionStatus,
  ADAPTIVE_REVIEW_DECISION_STATUSES,
  MAX_REVIEW_COMMENT_LENGTH,
  MAX_REVIEW_CONDITIONS_COUNT,
  MAX_REVIEW_CONDITION_LENGTH,
  validateAdaptiveReviewCommentAndConditions,
  AdaptiveReviewCommentConditionsFailureReason,
} from "./adaptiveHumanReviewRequest";

export { MAX_REVIEW_COMMENT_LENGTH, MAX_REVIEW_CONDITIONS_COUNT, MAX_REVIEW_CONDITION_LENGTH };

// ============================================
// Deterministic vote identity (§C2)
// ============================================

/**
 * `r{panelRevision}:{encodeURIComponent(reviewerUserId)}` — deterministic,
 * a safe Firestore document ID (never contains a raw `/`, since
 * `encodeURIComponent` always escapes it to `%2F`; never `.`/`..` alone,
 * since the `r` prefix and digits guarantee a longer string), no random
 * suffix, no timestamp component. `encodeURIComponent` is injective for
 * distinct input strings (distinct raw UIDs can never collide after
 * encoding), so the same reviewer + same revision always yields the same
 * ID, a different reviewer always yields a different ID, and a different
 * revision always yields a different ID (the `r{revision}:` prefix
 * differs). The vote ID is an internal storage detail — never returned in
 * any public API response (§C14).
 */
export function buildAdaptiveHumanReviewVoteId(panelRevision: number, reviewerUserId: string): string {
  return `r${panelRevision}:${encodeURIComponent(reviewerUserId)}`;
}

// ============================================
// Canonical stored vote document (§C3)
// ============================================

export type AdaptiveHumanReviewVoteV1 = {
  schemaVersion: 1;
  kind: "adaptive_human_review_vote";

  teamId: string;
  runId: string;

  panelRevision: number;
  reviewerUserId: string;

  status: AdaptiveReviewDecisionStatus;

  comment?: string;
  conditions?: string[];

  commentPresent: boolean;
  conditionsCount: number;

  submittedAt: string;
};

/**
 * Pure. Builds the full stored vote document from already-validated
 * request fields plus server-derived context. The caller (the Firestore
 * transaction) is responsible for having already validated panel
 * membership, reviewer eligibility, panel-open status, and panel-revision
 * match — this function only ever normalizes shape, never authorizes
 * anything.
 */
export function buildAdaptiveHumanReviewVote(args: {
  teamId: string;
  runId: string;
  panelRevision: number;
  reviewerUserId: string;
  status: AdaptiveReviewDecisionStatus;
  comment?: string;
  conditions?: string[];
  now: string;
}): AdaptiveHumanReviewVoteV1 {
  return {
    schemaVersion: 1,
    kind: "adaptive_human_review_vote",
    teamId: args.teamId,
    runId: args.runId,
    panelRevision: args.panelRevision,
    reviewerUserId: args.reviewerUserId,
    status: args.status,
    comment: args.comment,
    conditions: args.conditions,
    commentPresent: Boolean(args.comment),
    conditionsCount: args.conditions?.length ?? 0,
    submittedAt: args.now,
  };
}

/**
 * Semantic equality for idempotent-duplicate detection (§C9) —
 * deliberately EXCLUDES `submittedAt` (a retried, network-ambiguous
 * submission of the exact same vote content must be recognized as the
 * SAME vote regardless of how long ago it was actually recorded).
 * `conditions` order is already deterministic (normalized via the shared
 * `validateAdaptiveReviewCommentAndConditions` — trimmed, deduplicated,
 * first-occurrence order preserved), so a plain ordered comparison is
 * correct and sufficient; no set-based comparison is needed.
 */
export function isSemanticallyEquivalentAdaptiveHumanReviewVote(a: AdaptiveHumanReviewVoteV1, b: AdaptiveHumanReviewVoteV1): boolean {
  const aConditions = a.conditions ?? [];
  const bConditions = b.conditions ?? [];
  return (
    a.teamId === b.teamId &&
    a.runId === b.runId &&
    a.panelRevision === b.panelRevision &&
    a.reviewerUserId === b.reviewerUserId &&
    a.status === b.status &&
    (a.comment ?? "") === (b.comment ?? "") &&
    aConditions.length === bConditions.length &&
    aConditions.every((c, i) => c === bConditions[i])
  );
}

// ============================================
// Submission request contract (§C4/§C5)
// ============================================

export type SubmitAdaptiveReviewVoteRequest = {
  panelRevision: number;
  status: AdaptiveReviewDecisionStatus;
  comment?: string;
  conditions?: string[];
};

export type SubmitAdaptiveReviewVoteRequestFailureReason =
  | "malformed_body"
  | "invalid_status"
  | "missing_panel_revision"
  | "invalid_panel_revision"
  | AdaptiveReviewCommentConditionsFailureReason;

export type SubmitAdaptiveReviewVoteRequestResult =
  | { ok: true; value: SubmitAdaptiveReviewVoteRequest }
  | { ok: false; reason: SubmitAdaptiveReviewVoteRequestFailureReason };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates the raw, untrusted vote-submission request body. Deliberately
 * does NOT accept or read `reviewerUserId`, `teamId`, `runId`,
 * `submittedAt`, a vote ID, `quorum`, reviewer count, panel mode, an
 * aggregate status, a final decision, or any actor-identity field —
 * reviewer identity is always the authenticated uid, team identity is
 * always server-derived, exactly like every other adaptive-runs mutation
 * route in this codebase; there is simply no code here that reads any
 * field but `panelRevision`/`status`/`comment`/`conditions` from the body,
 * so nothing else could be trusted even if a caller sent it.
 *
 * Shares its status-specific comment/conditions rules with
 * `parseAdaptiveReviewDecisionRequest` (`adaptiveHumanReviewRequest.ts`)
 * via `validateAdaptiveReviewCommentAndConditions` — one implementation,
 * reused, not forked.
 */
export function parseSubmitAdaptiveReviewVoteRequest(raw: unknown): SubmitAdaptiveReviewVoteRequestResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "malformed_body" };
  }

  if (typeof raw.status !== "string" || !ADAPTIVE_REVIEW_DECISION_STATUSES.has(raw.status)) {
    return { ok: false, reason: "invalid_status" };
  }
  const status = raw.status as AdaptiveReviewDecisionStatus;

  if (raw.panelRevision === undefined || raw.panelRevision === null) {
    return { ok: false, reason: "missing_panel_revision" };
  }
  if (typeof raw.panelRevision !== "number" || !Number.isInteger(raw.panelRevision) || raw.panelRevision < 1) {
    return { ok: false, reason: "invalid_panel_revision" };
  }
  const panelRevision = raw.panelRevision;

  const core = validateAdaptiveReviewCommentAndConditions(status, raw.comment, raw.conditions);
  if (!core.ok) {
    return core;
  }

  return { ok: true, value: { panelRevision, status, comment: core.value.comment, conditions: core.value.conditions } };
}

// ============================================
// Stored-document parser (§C6)
// ============================================

export type ParseAdaptiveHumanReviewVoteResult =
  | { status: "valid"; vote: AdaptiveHumanReviewVoteV1 }
  | { status: "unsupported_version" }
  | { status: "malformed" };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Never coerces malformed stored data into a valid vote and never falls
 * back to any other behavior — a malformed or unsupported-version vote is
 * reported as such, and the caller (the Firestore layer) is responsible
 * for failing closed (never overwriting it, never counting it toward
 * anything — moot in Part C since nothing counts votes yet, but the same
 * discipline as every other parser in this codebase).
 */
export function parseAdaptiveHumanReviewVote(
  raw: unknown,
  context?: { expectedTeamId?: string; expectedRunId?: string; expectedPanelRevision?: number; expectedReviewerUserId?: string }
): ParseAdaptiveHumanReviewVoteResult {
  if (!isPlainObject(raw)) return { status: "malformed" };

  if (raw.schemaVersion !== 1) {
    return raw.schemaVersion === undefined ? { status: "malformed" } : { status: "unsupported_version" };
  }
  if (raw.kind !== "adaptive_human_review_vote") return { status: "malformed" };
  if (!isNonEmptyString(raw.teamId)) return { status: "malformed" };
  if (!isNonEmptyString(raw.runId)) return { status: "malformed" };
  if (context?.expectedTeamId && raw.teamId !== context.expectedTeamId) return { status: "malformed" };
  if (context?.expectedRunId && raw.runId !== context.expectedRunId) return { status: "malformed" };

  if (typeof raw.panelRevision !== "number" || !Number.isInteger(raw.panelRevision) || raw.panelRevision < 1) {
    return { status: "malformed" };
  }
  if (context?.expectedPanelRevision !== undefined && raw.panelRevision !== context.expectedPanelRevision) {
    return { status: "malformed" };
  }

  if (!isNonEmptyString(raw.reviewerUserId)) return { status: "malformed" };
  if (context?.expectedReviewerUserId && raw.reviewerUserId !== context.expectedReviewerUserId) return { status: "malformed" };

  if (typeof raw.status !== "string" || !ADAPTIVE_REVIEW_DECISION_STATUSES.has(raw.status)) return { status: "malformed" };
  const voteStatus = raw.status as AdaptiveReviewDecisionStatus;

  if (raw.comment !== undefined && typeof raw.comment !== "string") return { status: "malformed" };
  if (raw.conditions !== undefined && !isStringArray(raw.conditions)) return { status: "malformed" };
  if (raw.conditions && raw.conditions.some((c) => c.trim().length === 0)) return { status: "malformed" }; // no empty entries
  if (raw.conditions && new Set(raw.conditions).size !== raw.conditions.length) return { status: "malformed" }; // no duplicates

  // Reuses the SAME status-specific comment/conditions rules and limits
  // the request parser enforces — a normalized, already-valid stored
  // comment/conditions value passes through this check unchanged
  // (trimming an already-trimmed string, deduplicating an already-deduped
  // array, are both no-ops), so re-running it here is safe and avoids a
  // third, independently-drifting copy of the same rule table.
  const core = validateAdaptiveReviewCommentAndConditions(voteStatus, raw.comment, raw.conditions);
  if (!core.ok) return { status: "malformed" };

  if (typeof raw.commentPresent !== "boolean") return { status: "malformed" };
  if (raw.commentPresent !== Boolean(core.value.comment)) return { status: "malformed" };

  if (typeof raw.conditionsCount !== "number" || !Number.isInteger(raw.conditionsCount) || raw.conditionsCount < 0) {
    return { status: "malformed" };
  }
  if (raw.conditionsCount !== (core.value.conditions?.length ?? 0)) return { status: "malformed" };

  if (!isValidTimestamp(raw.submittedAt)) return { status: "malformed" };

  return {
    status: "valid",
    vote: {
      schemaVersion: 1,
      kind: "adaptive_human_review_vote",
      teamId: raw.teamId,
      runId: raw.runId,
      panelRevision: raw.panelRevision,
      reviewerUserId: raw.reviewerUserId,
      status: voteStatus,
      comment: core.value.comment,
      conditions: core.value.conditions,
      commentPresent: raw.commentPresent,
      conditionsCount: raw.conditionsCount,
      submittedAt: raw.submittedAt,
    },
  };
}
