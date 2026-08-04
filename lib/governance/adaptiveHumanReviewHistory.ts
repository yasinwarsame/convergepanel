/**
 * Immutable Adaptive Review History and Admin Audit Integration — the
 * versioned immutable history record type and the deterministic decision
 * identity strategy (docs/governance-decision-receipts-design.md §27).
 * Entirely pure, no I/O.
 *
 * DECISION ID STRATEGY (§27.3 — chosen, not the "preferred stronger"
 * option): a deterministic SHA-256 hash of
 * `teamId + runId + reviewedAt + newStatus`, NOT a new `decisionId` field
 * persisted inside `GovernanceRecordV1.humanReview`. The "persist it in
 * canonical humanReview" option was deliberately not taken — doing so
 * would require changing `applyHumanReviewUpdate()`'s field-by-field
 * reconstruction, `isValidHumanReview()`'s validator, and the
 * `GovernanceRecordV1` type itself (all Part D, already shipped and
 * covered by a wide web of exact-shape `toEqual` tests across
 * `governanceRecordParser.spec.ts`, `governanceRecordImmutability.spec.ts`,
 * `adaptiveHumanReviewPersistence.spec.ts`, and the detail response
 * builder) for a benefit the hash-based alternative already delivers in
 * full: every guarantee this step requires (same committed decision → same
 * ID; distinct decisions → distinct ID; no client control; safe Firestore
 * document ID; no raw team/run values recoverable from a public response)
 * holds for a pure hash computed entirely at the ROUTE layer, AFTER the
 * existing transaction commits — zero changes to Part D's transaction,
 * persistence, or parser code. A hash is actually STRONGER on the "no raw
 * values leaked" guarantee than a stored field would be, since the ID
 * itself is not a concatenation of the inputs.
 */

import { createHash } from "crypto";
import { AnswerShape } from "../adaptiveSchema/types";
import { PersistedAdaptiveSchemaId } from "../adaptiveSchema/persistedOutput";
import { HumanReviewStatus } from "../adaptiveSchema/governanceRecordParser";

/**
 * Deterministic, collision-resistant, and safe as both a Firestore document
 * ID and a public correlation key. Rejects any empty component — an empty
 * `teamId`/`runId`/`reviewedAt`/`newStatus` would either be a caller bug or
 * (for `reviewedAt`) a genuinely un-committed decision, neither of which
 * should ever produce an ID.
 */
export function buildAdaptiveReviewDecisionId(teamId: string, runId: string, reviewedAt: string, newStatus: string): string {
  if (!teamId || !teamId.trim()) throw new Error("buildAdaptiveReviewDecisionId: teamId must not be empty");
  if (!runId || !runId.trim()) throw new Error("buildAdaptiveReviewDecisionId: runId must not be empty");
  if (!reviewedAt || !reviewedAt.trim()) throw new Error("buildAdaptiveReviewDecisionId: reviewedAt must not be empty");
  if (!newStatus || !newStatus.trim()) throw new Error("buildAdaptiveReviewDecisionId: newStatus must not be empty");

  const material = `${teamId}:${runId}:${reviewedAt}:${newStatus}`;
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  return `dec_${digest}`;
}

// ============================================
// Immutable history record contract
// ============================================

export type AdaptiveReviewTerminalStatus = "approved" | "approved_with_conditions" | "changes_requested" | "rejected";
export type AdaptiveReviewNonTerminalStatus = "unreviewed" | "pending";

/**
 * Metadata only, by design — never the raw question, receipt conclusion,
 * full decision receipt, sources, automated-governance reasons, model
 * output, full comment, full conditions, team settings, or policy
 * internals. `commentPresent`/`conditionsCount` capture the SHAPE of the
 * decision without its content.
 */
export type AdaptiveHumanReviewHistoryV1 = {
  version: 1;
  kind: "adaptive_human_review";
  historyId: string;
  decisionId: string;
  runId: string;
  teamId: string;
  schemaId: PersistedAdaptiveSchemaId;
  answerShape: AnswerShape;
  priorStatus: AdaptiveReviewNonTerminalStatus;
  newStatus: AdaptiveReviewTerminalStatus;
  reviewerId: string;
  reviewedAt: string;
  governanceRecordUpdatedAt: string;
  commentPresent: boolean;
  conditionsCount: number;
  createdAt: string;
};

/**
 * Builds the immutable history record from already-validated, canonical
 * inputs — the caller (the decision route, or the repair service) is
 * responsible for having a real, committed `GovernanceRecordV1.humanReview`
 * in hand. `historyId` and `decisionId` are always identical in this
 * design (§27.4 — the document ID under `runs/{runId}/humanReviewHistory/`
 * IS the decision ID), duplicated as a field for read convenience, matching
 * this codebase's own existing id-duplication precedent
 * (`AdaptiveTeamRunProjection`, Part C).
 */
export function buildAdaptiveHumanReviewHistoryEntry(args: {
  decisionId: string;
  runId: string;
  teamId: string;
  schemaId: PersistedAdaptiveSchemaId;
  answerShape: AnswerShape;
  priorStatus: AdaptiveReviewNonTerminalStatus;
  newStatus: AdaptiveReviewTerminalStatus;
  reviewerId: string;
  reviewedAt: string;
  governanceRecordUpdatedAt: string;
  comment?: string;
  conditions?: string[];
  now: string;
}): AdaptiveHumanReviewHistoryV1 {
  return {
    version: 1,
    kind: "adaptive_human_review",
    historyId: args.decisionId,
    decisionId: args.decisionId,
    runId: args.runId,
    teamId: args.teamId,
    schemaId: args.schemaId,
    answerShape: args.answerShape,
    priorStatus: args.priorStatus,
    newStatus: args.newStatus,
    reviewerId: args.reviewerId,
    reviewedAt: args.reviewedAt,
    governanceRecordUpdatedAt: args.governanceRecordUpdatedAt,
    commentPresent: typeof args.comment === "string" && args.comment.trim().length > 0,
    conditionsCount: Array.isArray(args.conditions) ? args.conditions.length : 0,
    createdAt: args.now,
  };
}

// ============================================
// Non-terminal / terminal status guards (reuse the real vocabulary)
// ============================================

const TERMINAL_STATUSES = new Set<HumanReviewStatus>(["approved", "approved_with_conditions", "changes_requested", "rejected"]);
const NON_TERMINAL_STATUSES = new Set<HumanReviewStatus>(["unreviewed", "pending"]);

export function isAdaptiveReviewTerminalStatus(status: HumanReviewStatus): status is AdaptiveReviewTerminalStatus {
  return TERMINAL_STATUSES.has(status);
}

export function isAdaptiveReviewNonTerminalStatus(status: HumanReviewStatus): status is AdaptiveReviewNonTerminalStatus {
  return NON_TERMINAL_STATUSES.has(status);
}

// ============================================
// Read-side: history list response contract, row classification, ordering
// ============================================

/**
 * Compact, metadata-only per-item shape — never `reviewerId`, `reviewerName`,
 * `comment`, `conditions`, `teamId`, `userId`, receipt content, sources, or
 * raw governance data.
 */
export type AdaptiveReviewHistoryListItemV1 = {
  priorStatus: AdaptiveReviewNonTerminalStatus;
  newStatus: AdaptiveReviewTerminalStatus;
  reviewedAt: string;
  commentPresent: boolean;
  conditionsCount: number;
};

export type AdaptiveReviewHistoryResponseV1 = {
  ok: true;
  version: 1;
  runId: string;
  items: AdaptiveReviewHistoryListItemV1[];
};

export type ParsedAdaptiveReviewHistoryRow =
  | { status: "valid"; item: AdaptiveReviewHistoryListItemV1; historyId: string }
  | { status: "malformed"; historyId: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Strict classification of a raw `humanReewHistory` Firestore document —
 * unsupported version or any malformed required field is skipped (never
 * exposed), and logged by the CALLER (this function is pure, no logging).
 * Only the 5 fields the response contract allows are ever extracted —
 * every other field on the raw document (schemaId, answerShape, teamId,
 * reviewerId, decisionId, etc.) is read only to VALIDATE shape, never
 * copied into the returned item.
 */
export function classifyAdaptiveHumanReviewHistoryRow(historyId: string, raw: unknown): ParsedAdaptiveReviewHistoryRow {
  const malformed = { status: "malformed" as const, historyId };
  if (!isPlainObject(raw)) return malformed;
  if (raw.version !== 1) return malformed;
  if (raw.kind !== "adaptive_human_review") return malformed;
  if (typeof raw.priorStatus !== "string" || !NON_TERMINAL_STATUSES.has(raw.priorStatus as HumanReviewStatus)) return malformed;
  if (typeof raw.newStatus !== "string" || !TERMINAL_STATUSES.has(raw.newStatus as HumanReviewStatus)) return malformed;
  if (!isValidIsoTimestamp(raw.reviewedAt)) return malformed;
  if (typeof raw.commentPresent !== "boolean") return malformed;
  if (typeof raw.conditionsCount !== "number" || !Number.isFinite(raw.conditionsCount) || raw.conditionsCount < 0) return malformed;

  return {
    status: "valid",
    historyId,
    item: {
      priorStatus: raw.priorStatus as AdaptiveReviewNonTerminalStatus,
      newStatus: raw.newStatus as AdaptiveReviewTerminalStatus,
      reviewedAt: raw.reviewedAt,
      commentPresent: raw.commentPresent,
      conditionsCount: raw.conditionsCount,
    },
  };
}

/**
 * `reviewedAt` ascending, tie-broken by the internal `historyId` (never
 * exposed in the response — only used to keep sort order fully
 * deterministic when two entries would otherwise tie, which in practice
 * cannot happen since each run has at most one committed decision).
 */
export function sortAdaptiveReviewHistoryRows(
  rows: Array<{ item: AdaptiveReviewHistoryListItemV1; historyId: string }>
): AdaptiveReviewHistoryListItemV1[] {
  return [...rows]
    .sort((a, b) => {
      const ta = Date.parse(a.item.reviewedAt);
      const tb = Date.parse(b.item.reviewedAt);
      if (ta !== tb) return ta - tb;
      return a.historyId < b.historyId ? -1 : a.historyId > b.historyId ? 1 : 0;
    })
    .map((r) => r.item);
}
