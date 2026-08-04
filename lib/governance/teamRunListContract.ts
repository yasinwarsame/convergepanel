/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — the versioned,
 * explicitly-discriminated `teamRuns` list contract
 * (docs/governance-decision-receipts-design.md §25).
 *
 * Repairs an ALREADY-LIVE gap (§24.1/§24.10): since Part C started writing
 * `AdaptiveTeamRunProjection` documents into the same `teamRuns` collection
 * under the same `teamId`, the legacy list route's existing query already
 * returns them, untagged and commingled with legacy rows. This module is
 * entirely pure and I/O-free — classification, mapping, filtering, and
 * sorting only. Firestore reads, authorization, and logging all live in
 * the route layer that calls this module.
 */

import { AnswerShape } from "../adaptiveSchema/types";
import { PersistedAdaptiveSchemaId, SCHEMA_ANSWER_SHAPE } from "../adaptiveSchema/persistedOutput";
import {
  isValidTimestamp,
  isHumanReviewStatusReviewable,
  AUTOMATED_GOVERNANCE_STATUSES,
  HUMAN_REVIEW_STATUSES,
  HumanReviewStatus,
} from "../adaptiveSchema/governanceRecordParser";

// ============================================
// Response contract
// ============================================

export type AutomatedGovernanceStatusValue = "passed" | "flagged" | "blocked" | "not_evaluated" | "error";

export interface LegacyTeamRunListItemV1 {
  kind: "legacy";
  teamRunId: string;
  runId?: string;
  verificationId?: string;
  createdAt: string;
  querySummary?: string;
  policyFlags: string[];
  /** Derived: `policyFlags.length > 0` — a display indicator, independent of review state. */
  blockedByPolicy: boolean;
  /**
   * Derived, matching the legacy route's own existing "flagged" query
   * semantic exactly (§25.7): `policyFlags.length > 0 && !humanDecision`.
   * This is the ONLY genuine "needs attention" concept legacy rows have —
   * kept separate from `blockedByPolicy` so a flagged-then-decided row can
   * still show it once had a policy flag without still counting as
   * outstanding.
   */
  governanceReviewRequired: boolean;
  consensusScore?: number | null;
  humanDecision?: {
    action: "approved" | "rejected" | "escalated";
    decidedAt: string;
  };
}

export interface AdaptiveTeamRunListItemV1 {
  kind: "adaptive";
  teamRunId: string;
  runId: string;
  schemaId: PersistedAdaptiveSchemaId;
  answerShape: AnswerShape;
  receiptConclusion: string;
  sourceBacked: boolean;
  humanReviewNeeded: boolean;
  automatedGovernanceStatus?: AutomatedGovernanceStatusValue;
  humanReviewStatus: HumanReviewStatus;
  /** `isHumanReviewStatusReviewable(humanReviewStatus)` — never re-derived independently. */
  reviewable: boolean;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
}

export type TeamRunListItemV1 = LegacyTeamRunListItemV1 | AdaptiveTeamRunListItemV1;

export type TeamRunListResponseV1 = {
  ok: true;
  version: 1;
  items: TeamRunListItemV1[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
};

// ============================================
// Query-summary truncation (legacy only)
// ============================================

/** A queue-display field, not a canonical copy — the real query text remains on the legacy document, untouched. */
export const TEAM_RUN_QUERY_SUMMARY_MAX_LENGTH = 160;

/** Trims, normalizes line breaks to single spaces, and truncates deterministically — never a semantic rewrite. Returns `undefined` for a non-string or empty-after-normalization input. */
export function buildTeamRunQuerySummary(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.replace(/\r\n|\r|\n/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= TEAM_RUN_QUERY_SUMMARY_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, TEAM_RUN_QUERY_SUMMARY_MAX_LENGTH - 1)}…`;
}

// ============================================
// Strict row classification
// ============================================

export type ParsedTeamRunListItem =
  | { status: "valid"; item: TeamRunListItemV1 }
  | { status: "malformed"; teamRunId: string; detectedKind?: "legacy" | "adaptive" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const SUPPORTED_ADAPTIVE_SCHEMA_IDS = new Set<string>(Object.keys(SCHEMA_ANSWER_SHAPE));

/**
 * Adaptive discriminator present (`adaptive === true`) but ANY required
 * field is invalid → malformed adaptive. NEVER falls back to the legacy
 * mapper — this is the critical rule from §25.6.
 */
function classifyAdaptiveRow(teamRunId: string, data: Record<string, unknown>): ParsedTeamRunListItem {
  const malformed = { status: "malformed" as const, teamRunId, detectedKind: "adaptive" as const };

  if (data.projectionVersion !== 1) return malformed;
  if (!isNonEmptyString(data.teamId)) return malformed;
  if (!isNonEmptyString(data.userId)) return malformed;
  if (!isNonEmptyString(data.runId)) return malformed;

  if (typeof data.schemaId !== "string" || !SUPPORTED_ADAPTIVE_SCHEMA_IDS.has(data.schemaId)) return malformed;
  const schemaId = data.schemaId as PersistedAdaptiveSchemaId;
  if (data.answerShape !== SCHEMA_ANSWER_SHAPE[schemaId]) return malformed;

  if (typeof data.receiptConclusion !== "string") return malformed;
  if (typeof data.sourceBacked !== "boolean") return malformed;
  if (typeof data.humanReviewNeeded !== "boolean") return malformed;

  if (
    data.automatedGovernanceStatus !== undefined &&
    (typeof data.automatedGovernanceStatus !== "string" || !AUTOMATED_GOVERNANCE_STATUSES.has(data.automatedGovernanceStatus))
  ) {
    return malformed;
  }

  if (typeof data.humanReviewStatus !== "string" || !HUMAN_REVIEW_STATUSES.has(data.humanReviewStatus as HumanReviewStatus)) {
    return malformed;
  }
  const humanReviewStatus = data.humanReviewStatus as HumanReviewStatus;

  if (!isValidTimestamp(data.createdAt) || !isValidTimestamp(data.updatedAt)) return malformed;
  if (data.reviewedAt !== undefined && !isValidTimestamp(data.reviewedAt)) return malformed;

  const item: AdaptiveTeamRunListItemV1 = {
    kind: "adaptive",
    teamRunId,
    runId: data.runId as string,
    schemaId,
    answerShape: data.answerShape as AnswerShape,
    receiptConclusion: data.receiptConclusion,
    sourceBacked: data.sourceBacked,
    humanReviewNeeded: data.humanReviewNeeded,
    automatedGovernanceStatus: data.automatedGovernanceStatus as AutomatedGovernanceStatusValue | undefined,
    humanReviewStatus,
    reviewable: isHumanReviewStatusReviewable(humanReviewStatus),
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
    reviewedAt: data.reviewedAt as string | undefined,
  };
  return { status: "valid", item };
}

/**
 * Adaptive discriminator absent — attempt the legacy mapper. The only hard
 * requirement is a valid `timestamp` (a real Firestore `Timestamp`,
 * matching the legacy schema's actual field) — everything else defaults
 * safely rather than failing the whole row, since those fields are already
 * optional on the real `TeamRunDocument` contract. A present-but-wrong-type
 * `policyFlags` DOES fail the row (a real structural violation, not an
 * absent optional field). A malformed nested `humanDecision` is dropped
 * (omitted from the item), not treated as a whole-row failure — it is
 * itself an optional sub-shape on the real contract.
 */
function classifyLegacyRow(teamRunId: string, data: Record<string, unknown>): ParsedTeamRunListItem {
  const malformed = { status: "malformed" as const, teamRunId, detectedKind: "legacy" as const };

  const ts = data.timestamp;
  if (!ts || typeof ts !== "object" || typeof (ts as { toMillis?: unknown }).toMillis !== "function") {
    return malformed;
  }
  const millis = (ts as { toMillis: () => number }).toMillis();
  if (!Number.isFinite(millis)) return malformed;
  const createdAt = new Date(millis).toISOString();

  let policyFlags: string[] = [];
  if (data.policyFlags !== undefined) {
    if (!isStringArray(data.policyFlags)) return malformed;
    policyFlags = data.policyFlags;
  }

  const runId = isNonEmptyString(data.runId) ? data.runId : undefined;
  const verificationId = isNonEmptyString(data.verificationId) ? data.verificationId : undefined;
  const querySummary = buildTeamRunQuerySummary(data.query);
  const consensusScore = typeof data.consensusScore === "number" && Number.isFinite(data.consensusScore) ? data.consensusScore : null;

  let humanDecision: LegacyTeamRunListItemV1["humanDecision"];
  if (isPlainObject(data.humanDecision)) {
    const action = data.humanDecision.action;
    const decidedAt = data.humanDecision.decidedAt;
    if ((action === "approved" || action === "rejected" || action === "escalated") && isNonEmptyString(decidedAt)) {
      humanDecision = { action, decidedAt };
    }
  }

  const item: LegacyTeamRunListItemV1 = {
    kind: "legacy",
    teamRunId,
    runId,
    verificationId,
    createdAt,
    querySummary,
    policyFlags,
    blockedByPolicy: policyFlags.length > 0,
    governanceReviewRequired: policyFlags.length > 0 && !humanDecision,
    consensusScore,
    humanDecision,
  };
  return { status: "valid", item };
}

/**
 * The single entry point row classification must go through. Routes on the
 * `adaptive` discriminator ONLY — presence (`=== true`) selects the
 * adaptive path (with no legacy fallback on failure); absence selects the
 * legacy path.
 */
export function classifyTeamRunRow(teamRunId: string, raw: unknown): ParsedTeamRunListItem {
  if (!isPlainObject(raw)) {
    return { status: "malformed", teamRunId };
  }
  if (raw.adaptive === true) {
    return classifyAdaptiveRow(teamRunId, raw);
  }
  return classifyLegacyRow(teamRunId, raw);
}

// ============================================
// Filters
// ============================================

export const DEFAULT_TEAM_RUN_PAGE_SIZE = 25;
export const MAX_TEAM_RUN_PAGE_SIZE = 100;

export type TeamRunListFilters = {
  kind: "all" | "legacy" | "adaptive";
  reviewable?: boolean;
  flagged?: boolean;
  humanReviewStatus?: HumanReviewStatus;
  page: number;
  limit: number;
};

export type TeamRunListFilterValidationFailureReason =
  | "invalid_kind"
  | "invalid_reviewable"
  | "invalid_flagged"
  | "invalid_page"
  | "invalid_limit"
  | "invalid_human_review_status";

export type TeamRunListFilterValidationResult =
  | { ok: true; filters: TeamRunListFilters }
  | { ok: false; reason: TeamRunListFilterValidationFailureReason };

function parseOptionalBoolean(raw: string | null): boolean | undefined | "invalid" {
  if (raw === null) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return "invalid";
}

export function parseTeamRunListFilters(searchParams: URLSearchParams): TeamRunListFilterValidationResult {
  const kindRaw = searchParams.get("kind") ?? "all";
  if (kindRaw !== "all" && kindRaw !== "legacy" && kindRaw !== "adaptive") {
    return { ok: false, reason: "invalid_kind" };
  }

  const reviewable = parseOptionalBoolean(searchParams.get("reviewable"));
  if (reviewable === "invalid") return { ok: false, reason: "invalid_reviewable" };

  const flagged = parseOptionalBoolean(searchParams.get("flagged"));
  if (flagged === "invalid") return { ok: false, reason: "invalid_flagged" };

  const humanReviewStatusRaw = searchParams.get("humanReviewStatus");
  let humanReviewStatus: HumanReviewStatus | undefined;
  if (humanReviewStatusRaw !== null) {
    if (!HUMAN_REVIEW_STATUSES.has(humanReviewStatusRaw as HumanReviewStatus)) {
      return { ok: false, reason: "invalid_human_review_status" };
    }
    humanReviewStatus = humanReviewStatusRaw as HumanReviewStatus;
  }

  const pageRaw = searchParams.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  if (!Number.isInteger(page) || page < 1) return { ok: false, reason: "invalid_page" };

  const limitRaw = searchParams.get("limit");
  let limit = limitRaw === null ? DEFAULT_TEAM_RUN_PAGE_SIZE : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false, reason: "invalid_limit" };
  limit = Math.min(limit, MAX_TEAM_RUN_PAGE_SIZE);

  return { ok: true, filters: { kind: kindRaw, reviewable, flagged, humanReviewStatus, page, limit } };
}

export function isAdaptiveFlagged(item: AdaptiveTeamRunListItemV1): boolean {
  return item.automatedGovernanceStatus === "flagged" || item.automatedGovernanceStatus === "blocked";
}

export function isLegacyFlagged(item: LegacyTeamRunListItemV1): boolean {
  return item.governanceReviewRequired;
}

export function isItemFlagged(item: TeamRunListItemV1): boolean {
  return item.kind === "adaptive" ? isAdaptiveFlagged(item) : isLegacyFlagged(item);
}

/**
 * Applies the validated filters, in order: `kind`, then `flagged` (defined
 * for both kinds), then `reviewable` and `humanReviewStatus` (both
 * adaptive-native semantics — §25.7's own instruction not to invent a
 * legacy "reviewable" concept means these two filters, when set, only ever
 * match adaptive items; legacy items are excluded, not given a fabricated
 * interpretation).
 */
export function applyTeamRunListFilters(items: TeamRunListItemV1[], filters: TeamRunListFilters): TeamRunListItemV1[] {
  let rows = items;
  if (filters.kind !== "all") {
    rows = rows.filter((r) => r.kind === filters.kind);
  }
  if (filters.flagged !== undefined) {
    rows = rows.filter((r) => isItemFlagged(r) === filters.flagged);
  }
  if (filters.reviewable !== undefined) {
    rows = rows.filter((r): r is AdaptiveTeamRunListItemV1 => r.kind === "adaptive" && r.reviewable === filters.reviewable);
  }
  if (filters.humanReviewStatus !== undefined) {
    rows = rows.filter((r): r is AdaptiveTeamRunListItemV1 => r.kind === "adaptive" && r.humanReviewStatus === filters.humanReviewStatus);
  }
  return rows;
}

// ============================================
// Ordering and pagination
// ============================================

/** Adaptive: `updatedAt`. Legacy: `createdAt` (this contract has no separate legacy `updatedAt`). Never falls back to "infinitely old" — malformed/missing timestamps are excluded during classification, before this function ever runs. */
export function effectiveTeamRunTimestamp(item: TeamRunListItemV1): string {
  return item.kind === "adaptive" ? item.updatedAt : item.createdAt;
}

/** Deterministic: effective timestamp descending, tie-broken by `teamRunId` descending. Returns a new array — never mutates the input. */
export function sortTeamRunListItems(items: TeamRunListItemV1[]): TeamRunListItemV1[] {
  return [...items].sort((a, b) => {
    const ta = Date.parse(effectiveTeamRunTimestamp(a));
    const tb = Date.parse(effectiveTeamRunTimestamp(b));
    if (ta !== tb) return tb - ta;
    if (a.teamRunId === b.teamRunId) return 0;
    return a.teamRunId < b.teamRunId ? 1 : -1;
  });
}

/**
 * Pagination metadata is calculated AFTER filtering (and, by construction,
 * after malformed-row exclusion already happened during classification) —
 * `total` reflects the filtered set, never the raw collection size.
 */
export function paginateTeamRunListItems(
  items: TeamRunListItemV1[],
  page: number,
  limit: number
): { pageItems: TeamRunListItemV1[]; pagination: TeamRunListResponseV1["pagination"] } {
  const total = items.length;
  const start = (page - 1) * limit;
  const pageItems = items.slice(start, start + limit);
  return {
    pageItems,
    pagination: {
      page,
      limit,
      total,
      hasNextPage: start + limit < total,
      hasPreviousPage: page > 1,
    },
  };
}
