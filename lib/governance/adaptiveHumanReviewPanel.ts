/**
 * Multi-Reviewer Panel Foundation, Part B
 * (docs/governance-decision-receipts-design.md §29, §30) — pure model,
 * limits, quorum derivation, and parser for the multi-reviewer panel
 * configuration document. No I/O. Mirrors
 * `lib/governance/adaptiveHumanReviewAssignment.ts`'s own separation of
 * concerns exactly: this module only ever describes what a valid panel
 * document looks like and how to build the next one — Firestore reads and
 * writes live in `lib/firestore/runs.ts`.
 *
 * Part E (docs/governance-decision-receipts-design.md §33) additively
 * extends `status` with `"finalized"` and adds five OPTIONAL finalized-only
 * fields — every existing Part B/C open/cancelled panel document remains
 * fully valid and unaffected, since none of the new fields are ever
 * required unless `status === "finalized"`. `"ready_to_finalize"` still
 * does not exist as a PERSISTED status (Part D confirmed it is always a
 * derived, read-time computation, never stored) — only `"finalized"` is a
 * genuine terminal, persisted state, reached exclusively through the
 * finalization transaction (`lib/firestore/runs.ts`), never through
 * `buildNextAdaptiveHumanReviewPanel`/`buildCancelledAdaptiveHumanReviewPanel`
 * (both remain unchanged and continue to only ever produce `"open"`/
 * `"cancelled"` panels — reopening a finalized panel is not just
 * unimplemented, there is no code path that could produce it).
 *
 * Reviewer eligibility reuses `ELIGIBLE_REVIEWER_ROLES` from
 * `adaptiveHumanReviewAssignment.ts` directly (imported, not duplicated) —
 * panel eligibility is identical to single-reviewer assignment eligibility
 * in this codebase (`owner`|`admin` only, confirmed by the same audit).
 */

import { isValidTimestamp } from "../adaptiveSchema/governanceRecordParser";
import { ELIGIBLE_REVIEWER_ROLES } from "./adaptiveHumanReviewAssignment";

export { ELIGIBLE_REVIEWER_ROLES as ELIGIBLE_PANEL_REVIEWER_ROLES };

/**
 * Deliberate, disclosed deviation from docs/governance-decision-receipts-design.md
 * §29.6/§29.9, which specified a minimum panel size of 1 (so that "any one
 * reviewer" could degenerate from the same engine at size 1) and a quorum
 * definition of "every assigned reviewer must vote"
 * (`quorum === requiredReviewerCount`). This implementation step instead
 * requires a minimum of 2 (a size-1 panel is not meaningfully
 * "multi-reviewer") and defines `quorum` as the simple-majority THRESHOLD
 * itself (`floor(n/2)+1`), not a participation-count floor. Both values
 * are currently INERT — Part B stores `quorum` on the panel document but
 * never reads or acts on it, since no voting/aggregation exists yet.
 * Reconciling this with §29's original quorum semantics is explicitly left
 * for Part D (the aggregation engine), not resolved here.
 */
export const MIN_ADAPTIVE_PANEL_REVIEWERS = 2;
export const MAX_ADAPTIVE_PANEL_REVIEWERS = 9;

export function deriveAdaptivePanelQuorum(requiredReviewerCount: number): number {
  return Math.floor(requiredReviewerCount / 2) + 1;
}

/**
 * Deduplicates and sorts lexicographically. Reviewer order carries no
 * product meaning in Part B (no voting, no display-ordering requirement) —
 * normalizing deterministically means two logically-identical requests
 * (same set of reviewers, different input order) always produce a
 * byte-identical stored array, which keeps the panel document trivially
 * comparable/idempotent-friendly rather than treating input order as an
 * accidental, unintended convention.
 */
export function normalizeAdaptivePanelReviewerUserIds(reviewerUserIds: readonly string[]): string[] {
  return Array.from(new Set(reviewerUserIds)).sort();
}

export type AdaptiveMultiReviewerPanelMode = "majority_quorum";
export type AdaptiveHumanReviewPanelStatus = "open" | "cancelled" | "finalized";
export type AdaptiveReviewFinalStatus = "approved" | "approved_with_conditions" | "changes_requested" | "rejected";

export type AdaptiveHumanReviewPanelV1 = {
  schemaVersion: 1;
  kind: "adaptive_review_panel";

  teamId: string;
  runId: string;

  mode: AdaptiveMultiReviewerPanelMode;

  reviewerUserIds: string[];

  requiredReviewerCount: number;
  quorum: number;

  status: AdaptiveHumanReviewPanelStatus;

  revision: number;

  createdAt: string;
  createdByUserId: string;

  updatedAt: string;
  updatedByUserId: string;

  /**
   * Part E — present if and only if `status === "finalized"`, enforced by
   * the parser's own cross-field validation below. Never set by
   * `buildNextAdaptiveHumanReviewPanel`/`buildCancelledAdaptiveHumanReviewPanel`
   * — only the finalization transaction ever produces a panel with these
   * populated.
   */
  finalizedAt?: string;
  finalizedByUserId?: string;
  finalStatus?: AdaptiveReviewFinalStatus;
  finalDecisionId?: string;
  aggregationPolicyVersion?: number;

  /**
   * Part F — `finalizedVia` is OPTIONAL even on a finalized panel, NOT
   * required, for backward compatibility: every Part-E-finalized panel
   * (created before this field existed) has no `finalizedVia` at all, and
   * must remain valid — its ABSENCE is the permanent, correct signal for
   * "finalized via aggregation, before this field was introduced" (the
   * only path that existed then). Going forward,
   * `buildFinalizedAdaptiveHumanReviewPanel` explicitly sets
   * `"aggregation"` for clarity; a NEW override finalization always sets
   * `"owner_override"`. `overrideJustificationPresent`/`overrideByUserId`
   * are required if and only if `finalizedVia === "owner_override"`,
   * forbidden otherwise (including forbidden when `finalizedVia === "aggregation"`).
   */
  finalizedVia?: "aggregation" | "owner_override";
  overrideJustificationPresent?: boolean;
  overrideByUserId?: string;
};

/**
 * Pure. Builds the next panel document for BOTH creation (no current
 * panel — `current` is `null`) and reconfiguration (`current` is the
 * existing open panel) — the caller (the Firestore transaction) is
 * responsible for having already validated revision, opt-in,
 * reviewability, and reviewer eligibility. `reviewerUserIds` is normalized
 * here (deduplicated + sorted) so callers never need to pre-normalize.
 */
export function buildNextAdaptiveHumanReviewPanel(args: {
  teamId: string;
  runId: string;
  reviewerUserIds: readonly string[];
  actorUserId: string;
  now: string;
  current: AdaptiveHumanReviewPanelV1 | null;
}): AdaptiveHumanReviewPanelV1 {
  const reviewerUserIds = normalizeAdaptivePanelReviewerUserIds(args.reviewerUserIds);
  const requiredReviewerCount = reviewerUserIds.length;
  return {
    schemaVersion: 1,
    kind: "adaptive_review_panel",
    teamId: args.teamId,
    runId: args.runId,
    mode: "majority_quorum",
    reviewerUserIds,
    requiredReviewerCount,
    quorum: deriveAdaptivePanelQuorum(requiredReviewerCount),
    status: "open",
    revision: (args.current?.revision ?? 0) + 1,
    createdAt: args.current?.createdAt ?? args.now,
    createdByUserId: args.current?.createdByUserId ?? args.actorUserId,
    updatedAt: args.now,
    updatedByUserId: args.actorUserId,
  };
}

/**
 * Pure. Cancellation is a terminal CONFIGURATION state, never a physical
 * delete — the reviewer list is preserved exactly as it was for
 * auditability (§29/§30), never cleared or reset.
 */
export function buildCancelledAdaptiveHumanReviewPanel(args: {
  current: AdaptiveHumanReviewPanelV1;
  actorUserId: string;
  now: string;
}): AdaptiveHumanReviewPanelV1 {
  return {
    ...args.current,
    status: "cancelled",
    revision: args.current.revision + 1,
    updatedAt: args.now,
    updatedByUserId: args.actorUserId,
  };
}

/**
 * Pure. Part E — builds the finalized terminal panel document. Preserves
 * `reviewerUserIds`, `mode`, `quorum`, `requiredReviewerCount`, and
 * `createdAt`/`createdByUserId` exactly, mirroring
 * `buildCancelledAdaptiveHumanReviewPanel`'s own spread-based preservation
 * pattern. Revision increments by exactly 1 — finalization is itself a
 * state transition, exactly like every other panel mutation.
 */
export function buildFinalizedAdaptiveHumanReviewPanel(args: {
  current: AdaptiveHumanReviewPanelV1;
  actorUserId: string;
  now: string;
  finalStatus: AdaptiveReviewFinalStatus;
  finalDecisionId: string;
  aggregationPolicyVersion: number;
}): AdaptiveHumanReviewPanelV1 {
  return {
    ...args.current,
    status: "finalized",
    revision: args.current.revision + 1,
    updatedAt: args.now,
    updatedByUserId: args.actorUserId,
    finalizedAt: args.now,
    finalizedByUserId: args.actorUserId,
    finalStatus: args.finalStatus,
    finalDecisionId: args.finalDecisionId,
    aggregationPolicyVersion: args.aggregationPolicyVersion,
    finalizedVia: "aggregation",
  };
}

/**
 * Pure. Multi-Reviewer Owner Override, Part F — builds the finalized
 * terminal panel document for the OWNER OVERRIDE path. Mirrors
 * `buildFinalizedAdaptiveHumanReviewPanel` exactly for every shared
 * terminal field (`finalizedAt`/`finalizedByUserId`/`finalStatus`/
 * `finalDecisionId`/`aggregationPolicyVersion`/`revision`) — the outcome
 * shape is deliberately identical regardless of path, per F6's guidance to
 * keep shared fields shared. Only `finalizedVia` and the two
 * override-specific fields distinguish this from an aggregation
 * finalization. Never reads or touches `reviewerUserIds`/votes — the
 * caller (the override transaction) is responsible for having already
 * verified the panel is open and NOT reading votes as an override
 * precondition (F5).
 */
export function buildOwnerOverriddenAdaptiveHumanReviewPanel(args: {
  current: AdaptiveHumanReviewPanelV1;
  actorUserId: string;
  now: string;
  finalStatus: AdaptiveReviewFinalStatus;
  finalDecisionId: string;
  aggregationPolicyVersion: number;
}): AdaptiveHumanReviewPanelV1 {
  return {
    ...args.current,
    status: "finalized",
    revision: args.current.revision + 1,
    updatedAt: args.now,
    updatedByUserId: args.actorUserId,
    finalizedAt: args.now,
    finalizedByUserId: args.actorUserId,
    finalStatus: args.finalStatus,
    finalDecisionId: args.finalDecisionId,
    aggregationPolicyVersion: args.aggregationPolicyVersion,
    finalizedVia: "owner_override",
    overrideJustificationPresent: true,
    overrideByUserId: args.actorUserId,
  };
}

// ============================================
// Parser
// ============================================

export type ParseAdaptiveHumanReviewPanelResult =
  | { status: "valid"; panel: AdaptiveHumanReviewPanelV1 }
  | { status: "absent" }
  | { status: "unsupported_version" }
  | { status: "malformed" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isReviewerUserIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => isNonEmptyString(v));
}

const VALID_FINAL_STATUSES: ReadonlySet<string> = new Set(["approved", "approved_with_conditions", "changes_requested", "rejected"]);

/**
 * Never coerces malformed data into a valid shape and never falls back to
 * single-reviewer behavior on its own — a malformed or unsupported-version
 * panel is reported as such and it is the CALLER's responsibility to fail
 * closed (§29/§30's non-negotiable: "malformed panels never fall back to
 * single mode").
 *
 * `context` enables the same defensive re-check pattern already used for
 * `AdaptiveTeamRunProjection` — a stored panel's own `teamId`/`runId`
 * fields are checked against the caller's already-authenticated context
 * where supplied, never trusted solely because the document happened to
 * be reachable at the expected path.
 */
export function parseAdaptiveHumanReviewPanel(
  raw: unknown,
  context?: { expectedTeamId?: string; expectedRunId?: string }
): ParseAdaptiveHumanReviewPanelResult {
  if (raw === undefined || raw === null) return { status: "absent" };
  if (!isPlainObject(raw)) return { status: "malformed" };

  if (raw.schemaVersion !== 1) {
    return raw.schemaVersion === undefined ? { status: "malformed" } : { status: "unsupported_version" };
  }
  if (raw.kind !== "adaptive_review_panel") return { status: "malformed" };
  if (!isNonEmptyString(raw.teamId)) return { status: "malformed" };
  if (!isNonEmptyString(raw.runId)) return { status: "malformed" };
  if (context?.expectedTeamId && raw.teamId !== context.expectedTeamId) return { status: "malformed" };
  if (context?.expectedRunId && raw.runId !== context.expectedRunId) return { status: "malformed" };

  if (raw.mode !== "majority_quorum") return { status: "malformed" };

  if (!isReviewerUserIdArray(raw.reviewerUserIds)) return { status: "malformed" };
  const reviewerUserIds = raw.reviewerUserIds;
  const dedupedCount = new Set(reviewerUserIds).size;
  if (dedupedCount !== reviewerUserIds.length) return { status: "malformed" }; // duplicates
  if (reviewerUserIds.length < MIN_ADAPTIVE_PANEL_REVIEWERS || reviewerUserIds.length > MAX_ADAPTIVE_PANEL_REVIEWERS) {
    return { status: "malformed" };
  }

  if (typeof raw.requiredReviewerCount !== "number" || !Number.isInteger(raw.requiredReviewerCount)) {
    return { status: "malformed" };
  }
  if (raw.requiredReviewerCount !== reviewerUserIds.length) return { status: "malformed" };

  if (typeof raw.quorum !== "number" || !Number.isInteger(raw.quorum)) return { status: "malformed" };
  if (raw.quorum !== deriveAdaptivePanelQuorum(raw.requiredReviewerCount)) return { status: "malformed" };

  if (raw.status !== "open" && raw.status !== "cancelled" && raw.status !== "finalized") return { status: "malformed" };

  if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) return { status: "malformed" };

  if (!isValidTimestamp(raw.createdAt)) return { status: "malformed" };
  if (!isValidTimestamp(raw.updatedAt)) return { status: "malformed" };
  if (Date.parse(raw.createdAt as string) > Date.parse(raw.updatedAt as string)) return { status: "malformed" };

  if (!isNonEmptyString(raw.createdByUserId)) return { status: "malformed" };
  if (!isNonEmptyString(raw.updatedByUserId)) return { status: "malformed" };

  // Part E — finalized-field cross-field validation: required if and only
  // if status === "finalized". A panel that is "open"/"cancelled" but
  // carries any of these fields is just as malformed as a "finalized"
  // panel missing one — never coerced, never silently dropped.
  const hasAnyFinalizedField =
    raw.finalizedAt !== undefined ||
    raw.finalizedByUserId !== undefined ||
    raw.finalStatus !== undefined ||
    raw.finalDecisionId !== undefined ||
    raw.aggregationPolicyVersion !== undefined;

  if (raw.status !== "finalized") {
    if (hasAnyFinalizedField) return { status: "malformed" };
  } else {
    if (!isValidTimestamp(raw.finalizedAt)) return { status: "malformed" };
    if (Date.parse(raw.finalizedAt as string) > Date.parse(raw.updatedAt as string)) return { status: "malformed" };
    if (!isNonEmptyString(raw.finalizedByUserId)) return { status: "malformed" };
    if (typeof raw.finalStatus !== "string" || !VALID_FINAL_STATUSES.has(raw.finalStatus)) return { status: "malformed" };
    if (!isNonEmptyString(raw.finalDecisionId)) return { status: "malformed" };
    if (typeof raw.aggregationPolicyVersion !== "number" || !Number.isInteger(raw.aggregationPolicyVersion) || raw.aggregationPolicyVersion < 1) {
      return { status: "malformed" };
    }
  }

  // Part F — `finalizedVia` cross-field validation. Deliberately permissive
  // when ABSENT on a finalized panel (every Part-E panel has no
  // `finalizedVia` at all) — absence is never itself an error, on either an
  // open/cancelled OR a finalized panel; only its VALUE and paired fields
  // are validated when present.
  if (raw.finalizedVia !== undefined) {
    if (raw.status !== "finalized") return { status: "malformed" };
    if (raw.finalizedVia !== "aggregation" && raw.finalizedVia !== "owner_override") return { status: "malformed" };
  }
  const hasAnyOverrideField = raw.overrideJustificationPresent !== undefined || raw.overrideByUserId !== undefined;
  if (raw.finalizedVia === "owner_override") {
    if (raw.overrideJustificationPresent !== true) return { status: "malformed" };
    if (!isNonEmptyString(raw.overrideByUserId)) return { status: "malformed" };
  } else if (hasAnyOverrideField) {
    // Forbidden whenever finalizedVia is absent or "aggregation" — including
    // on an open/cancelled panel, since finalizedVia itself would already
    // have been rejected there but these fields are checked independently.
    return { status: "malformed" };
  }

  return {
    status: "valid",
    panel: {
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: raw.teamId,
      runId: raw.runId,
      mode: "majority_quorum",
      reviewerUserIds,
      requiredReviewerCount: raw.requiredReviewerCount,
      quorum: raw.quorum,
      status: raw.status,
      revision: raw.revision,
      createdAt: raw.createdAt,
      createdByUserId: raw.createdByUserId,
      updatedAt: raw.updatedAt,
      updatedByUserId: raw.updatedByUserId,
      ...(raw.status === "finalized"
        ? {
            finalizedAt: raw.finalizedAt as string,
            finalizedByUserId: raw.finalizedByUserId as string,
            finalStatus: raw.finalStatus as AdaptiveReviewFinalStatus,
            finalDecisionId: raw.finalDecisionId as string,
            aggregationPolicyVersion: raw.aggregationPolicyVersion as number,
          }
        : {}),
      ...(raw.finalizedVia !== undefined ? { finalizedVia: raw.finalizedVia as "aggregation" | "owner_override" } : {}),
      ...(raw.finalizedVia === "owner_override"
        ? {
            overrideJustificationPresent: raw.overrideJustificationPresent as boolean,
            overrideByUserId: raw.overrideByUserId as string,
          }
        : {}),
    },
  };
}
