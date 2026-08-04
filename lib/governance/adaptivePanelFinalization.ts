/**
 * Transactional Multi-Reviewer Finalization, Part E
 * (docs/governance-decision-receipts-design.md §33). Pure model: the
 * deterministic final-decision identity and the canonical condition-union
 * / system-comment / humanReview-provenance builders. No I/O — Firestore
 * reads/writes live in `lib/firestore/runs.ts`.
 *
 * Deliberately does NOT touch `applyHumanReviewUpdate()` or
 * `HumanReviewUpdate` (`lib/adaptiveSchema/governanceRecordParser.ts`) —
 * those remain exclusively the single-reviewer decision route's own,
 * already-shipped, exact-shape-tested code path. The multi-reviewer
 * finalization transaction builds its canonical `humanReview` value
 * directly via `buildFinalizedMultiReviewerHumanReview` below, since its
 * input is already 100% server-derived and trusted (never raw client
 * body), unlike the single-reviewer route's defensive, client-input-facing
 * validator.
 */

import { createHash } from "crypto";
import { AdaptiveReviewFinalStatus } from "./adaptiveHumanReviewPanel";
import { AdaptiveHumanReviewVoteV1 } from "./adaptiveHumanReviewVote";
import { MAX_REVIEW_CONDITIONS_COUNT } from "./adaptiveHumanReviewRequest";
import { GovernanceRecordV1 } from "../adaptiveSchema/governanceRecord";

/**
 * DECISION ID STRATEGY — deliberately NOT the same shape as
 * `buildAdaptiveReviewDecisionId` (the single-reviewer path's own hash,
 * which includes `reviewedAt`, a wall-clock value). A multi-reviewer final
 * decision is fully determined by WHICH panel revision was finalized and
 * WHAT the aggregation outcome was — never by when someone happened to
 * click Finalize — so `reviewedAt`/`finalizedAt` is deliberately excluded
 * from the hash material. This makes `finalDecisionId` double as the
 * idempotency correlation key (§E10): a retried finalization attempt
 * against the same panel revision, producing the same aggregation outcome,
 * always yields the IDENTICAL ID — retries are naturally idempotent by
 * construction, not by a separate lookup.
 *
 * One ID, reused everywhere per §E3: `panel.finalDecisionId`, the
 * `humanReviewHistory` document ID, the admin audit correlation field, and
 * the governance-event correlation field all use this exact same value —
 * never a second, unrelated identity for the same final decision.
 * `panel_dec_` prefix keeps it visually and namespace-distinct from the
 * single-reviewer path's `dec_`-prefixed IDs in the SAME `humanReviewHistory`
 * collection (no collision risk, and both remain uniformly readable
 * through the one existing history read endpoint/UI).
 */
export function buildAdaptivePanelFinalDecisionId(
  teamId: string,
  runId: string,
  panelRevision: number,
  finalStatus: string,
  aggregationPolicyVersion: number
): string {
  if (!teamId || !teamId.trim()) throw new Error("buildAdaptivePanelFinalDecisionId: teamId must not be empty");
  if (!runId || !runId.trim()) throw new Error("buildAdaptivePanelFinalDecisionId: runId must not be empty");
  if (!Number.isInteger(panelRevision) || panelRevision < 1) {
    throw new Error("buildAdaptivePanelFinalDecisionId: panelRevision must be a positive integer");
  }
  if (!finalStatus || !finalStatus.trim()) throw new Error("buildAdaptivePanelFinalDecisionId: finalStatus must not be empty");

  const material = `${teamId}:${runId}:${panelRevision}:${finalStatus}:${aggregationPolicyVersion}`;
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  return `panel_dec_${digest}`;
}

// ============================================
// Canonical condition union (§E8/§E22, Option A)
// ============================================

/**
 * Same bound already enforced on every individual vote at submission time
 * (`MAX_REVIEW_CONDITIONS_COUNT`, `adaptiveHumanReviewRequest.ts`) — reused,
 * not a new limit invented for the union.
 */
const MAX_CANONICAL_CONDITIONS = MAX_REVIEW_CONDITIONS_COUNT;

/**
 * Pure. Deterministic exact-string union of conditions from the WINNING
 * group's `approved_with_conditions` votes only (`supportingReviewerUserIds`
 * — already sorted ascending by the pure aggregation engine, §32) — never
 * semantic merging, never rewording, never a losing-group vote's
 * conditions. Order: winning votes in `supportingReviewerUserIds`'s own
 * (reviewerUserId-ascending) order, each vote's own conditions in their
 * already-normalized (trimmed, deduped, first-occurrence) order — "by
 * reviewerUserId, then original condition order," exactly per §E22.
 * Capped at `MAX_CANONICAL_CONDITIONS`: overflow keeps the first N in this
 * exact deterministic order — an explicit, safe, non-arbitrary truncation,
 * never an unpredictable one.
 */
export function buildFinalConditionsUnion(
  votes: readonly AdaptiveHumanReviewVoteV1[],
  supportingReviewerUserIds: readonly string[]
): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const reviewerUserId of supportingReviewerUserIds) {
    const vote = votes.find((v) => v.reviewerUserId === reviewerUserId);
    if (!vote || vote.status !== "approved_with_conditions") continue;
    for (const condition of vote.conditions ?? []) {
      if (!seen.has(condition)) {
        seen.add(condition);
        union.push(condition);
      }
    }
  }
  return union.slice(0, MAX_CANONICAL_CONDITIONS);
}

// ============================================
// Canonical system-generated comment (§E8/§E22)
// ============================================

const SYSTEM_GENERATED_FINALIZATION_COMMENT = "Finalized by multi-reviewer panel.";

/**
 * Never concatenates or otherwise copies individual reviewers' private
 * vote comments into the public canonical record — a fixed,
 * system-generated string for the two statuses that require a comment at
 * all under the existing single-reviewer status-rule vocabulary
 * (`changes_requested`/`rejected` — reused from `adaptiveHumanReviewRequest.ts`'s
 * own rule table, §31.4). `approved`/`approved_with_conditions` get no
 * canonical comment (`undefined`) — optional under the existing schema,
 * consistent with the single-reviewer path's own precedent of leaving
 * `comment` absent for a plain approval.
 */
export function buildFinalSystemComment(finalStatus: AdaptiveReviewFinalStatus): string | undefined {
  if (finalStatus === "changes_requested" || finalStatus === "rejected") {
    return SYSTEM_GENERATED_FINALIZATION_COMMENT;
  }
  return undefined;
}

// ============================================
// Canonical humanReview provenance (§E8)
// ============================================

/**
 * Pure. Builds the exact `GovernanceRecordV1["humanReview"]` value the
 * finalization transaction writes — the ENTIRE object, so the transaction
 * itself never hand-assembles field-by-field. `reviewerId` is the
 * FINALIZING ACTOR's uid (the caller who invoked the finalize route) —
 * not any individual voter's uid, since no single voter "made" a
 * collective decision; full multi-reviewer provenance (the actual
 * supporting reviewer set) belongs in the separate, richer panel
 * finalization history record (§E12), not squeezed into this already
 * established, single-reviewer-shaped field. Never includes the full
 * reviewer list or any raw vote comment/conditions text — only the
 * already-computed canonical union/system-comment and compact counts.
 */
export function buildFinalizedMultiReviewerHumanReview(args: {
  finalStatus: AdaptiveReviewFinalStatus;
  finalizingActorUid: string;
  reviewedAt: string;
  conditions?: string[];
  panelRevision: number;
  aggregationPolicyVersion: number;
  supportingReviewerCount: number;
}): GovernanceRecordV1["humanReview"] {
  return {
    status: args.finalStatus,
    reviewerId: args.finalizingActorUid,
    reviewedAt: args.reviewedAt,
    comment: buildFinalSystemComment(args.finalStatus),
    conditions: args.finalStatus === "approved_with_conditions" ? args.conditions : undefined,
    decidedVia: "multi_reviewer_panel",
    panelRevision: args.panelRevision,
    aggregationPolicyVersion: args.aggregationPolicyVersion,
    supportingReviewerCount: args.supportingReviewerCount,
  };
}

// ============================================
// Immutable panel finalization history (§E12)
// ============================================

/**
 * Metadata only — never a vote comment, condition text, reviewer name, or
 * email. `eventId` follows the exact `${revision}:${eventType}` convention
 * already documented (but deferred) for panel-config lifecycle events in
 * §29.18/§30 — `finalizedPanelRevision` is used (the revision the
 * FINALIZED document itself carries), consistent with that same
 * convention, so a future implementation of the still-deferred
 * created/reconfigured/cancelled panel-history events would use IDs from
 * the same, non-colliding numbering scheme.
 */
export type AdaptivePanelFinalizationHistoryV1 = {
  schemaVersion: 1;
  eventId: string;
  eventType: "panel_finalized";
  teamId: string;
  runId: string;
  preFinalizationPanelRevision: number;
  finalizedPanelRevision: number;
  finalStatus: AdaptiveReviewFinalStatus;
  finalDecisionId: string;
  aggregationPolicyVersion: number;
  reviewerCount: number;
  submittedCount: number;
  supportingReviewerCount: number;
  actorUserId: string;
  finalizedAt: string;
};

export function buildAdaptivePanelFinalizationHistoryEntry(args: {
  teamId: string;
  runId: string;
  preFinalizationPanelRevision: number;
  finalizedPanelRevision: number;
  finalStatus: AdaptiveReviewFinalStatus;
  finalDecisionId: string;
  aggregationPolicyVersion: number;
  reviewerCount: number;
  submittedCount: number;
  supportingReviewerCount: number;
  actorUserId: string;
  finalizedAt: string;
}): AdaptivePanelFinalizationHistoryV1 {
  return {
    schemaVersion: 1,
    eventId: `${args.finalizedPanelRevision}:panel_finalized`,
    eventType: "panel_finalized",
    teamId: args.teamId,
    runId: args.runId,
    preFinalizationPanelRevision: args.preFinalizationPanelRevision,
    finalizedPanelRevision: args.finalizedPanelRevision,
    finalStatus: args.finalStatus,
    finalDecisionId: args.finalDecisionId,
    aggregationPolicyVersion: args.aggregationPolicyVersion,
    reviewerCount: args.reviewerCount,
    submittedCount: args.submittedCount,
    supportingReviewerCount: args.supportingReviewerCount,
    actorUserId: args.actorUserId,
    finalizedAt: args.finalizedAt,
  };
}
