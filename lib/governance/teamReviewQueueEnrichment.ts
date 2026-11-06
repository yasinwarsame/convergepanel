/**
 * Review Page Reviewer Display — presentation-safe enrichment for the
 * team review QUEUE (`GET /api/teams/runs?version=1`), extending each
 * page's `TeamRunListItemV1` with resolved reviewer identity/assignment/
 * panel detail. Mirrors `lib/adaptiveSchema/reviewGovernanceViewModel.ts`'s
 * own discipline exactly: pure functions over already-fetched data, an
 * injected `resolveDisplayName`, never a Firestore/adminDb import here.
 *
 * Two distinct legacy systems exist in this codebase and must never be
 * conflated (see docs/team-workspaces-architecture-audit.md §1):
 *   - System A (`reviewGovernanceViewModel.ts`'s "legacy" family): personal
 *     governance, `governanceStatus`/`governanceReviewedBy` on `runs/{runId}`.
 *   - System B (this file's `enrichLegacyTeamRunListItem`): TEAM-queue
 *     governance, `TeamRunDocument.humanDecision` (`action`/`decidedBy`/
 *     `decidedAt`/`notes`) written directly onto the `teamRuns/{teamRunId}`
 *     document by `app/api/teams/runs/[runId]/decision/route.ts`. For THIS
 *     system, `teamRuns` genuinely IS the canonical decision record — there
 *     is no separate source it could ever diverge from — so reading
 *     `humanDecision.decidedBy` off the already-fetched `teamRuns` doc is
 *     not a "stale projection" risk the way `AdaptiveTeamRunProjection`'s
 *     fields are for Milestone-2. Only `notes` (the free-text justification)
 *     stays private — never surfaced here.
 *
 * For adaptive rows, canonical state is `runs/{runId}.governanceRecord`
 * plus the `humanReviewAssignment`/`humanReviewPanel`/`humanReviewVotes`
 * subcollections — genuinely separate from the `teamRuns` `adaptive`
 * projection doc, which is read only to DISCOVER the row, never for its
 * own status/reviewer content (`adaptiveTeamReview.ts`'s own documented
 * exclusion). `enrichAdaptiveTeamRunListItem` delegates the actual
 * canonical-state interpretation to `buildReviewGovernanceViewModel`
 * (reused, not reimplemented) and merges only the safe `singleReviewer`/
 * `assignment`/`panel` fields onto the list item.
 */

import type { LegacyTeamRunListItemV1, AdaptiveTeamRunListItemV1 } from "./teamRunListContract";
import {
  buildReviewGovernanceViewModel,
  ReviewGovernanceViewModel,
} from "../adaptiveSchema/reviewGovernanceViewModel";
import { isHumanReviewStatusReviewable } from "../adaptiveSchema/governanceRecordParser";
import type { GovernanceRecordV1 } from "../adaptiveSchema/governanceRecord";
import type { AdaptiveHumanReviewAssignmentV1 } from "./adaptiveHumanReviewAssignment";
import type { AdaptiveHumanReviewPanelV1 } from "./adaptiveHumanReviewPanel";
import type { AdaptiveHumanReviewVoteV1 } from "./adaptiveHumanReviewVote";
import {
  consensusScoreWithheldReason,
  type ConsensusScoreWithheldReason,
  type StoredConsensusIndependence,
} from "../panel/independentVoices";

export interface EnrichedLegacyTeamRunListItemV1 extends Omit<LegacyTeamRunListItemV1, "humanDecision"> {
  humanDecision?: {
    action: "approved" | "rejected" | "escalated";
    decidedAt: string;
    /** Resolved display identity of the decider — `null` only when `decidedBy` is absent (decision predates identity capture, extremely unlikely but handled). Never a raw uid. */
    reviewer: { displayName: string } | null;
  };
  /**
   * Present when the stored consensus score is withheld (`consensusScore` is then null): the row's canonical artifact —
   * the linked `runs/{runId}` (research) or `verifications/{verificationId}` (claim verification) — reduces to fewer
   * than two independent executing models with a usable answer ("insufficient_independent_models"), or its execution
   * identity cannot be established — artifact unreadable, no / incomplete per-model rows, or no linkage at all
   * ("independence_unverified"). See `applyLegacyConsensusIndependence`.
   */
  consensusWithheld?: ConsensusScoreWithheldReason;
}

/**
 * Pure. Withholds a legacy row's stored consensus score unless independence is proven. `independence` is computed by
 * the caller from the row's canonical artifact, or null when that artifact could not be read:
 *  - research row (`runId`): `storedRunConsensusIndependence` of `runs/{runId}`;
 *  - claim-verification row (`verificationId`, no `runId`): `storedVerificationConsensusIndependence` of
 *    `verifications/{verificationId}` — a claim score is a cross-model figure too, so one answering model (or several
 *    slots served by one executing provider) is not consensus;
 *  - a row naming neither: independence cannot be established → withheld as unverified.
 * Shown only when "independent". A row without a stored score is unchanged. Never mutates its input.
 */
export function applyLegacyConsensusIndependence(
  item: EnrichedLegacyTeamRunListItemV1,
  independence: StoredConsensusIndependence | null
): EnrichedLegacyTeamRunListItemV1 {
  if (item.consensusScore == null) return item;
  const linked = !!item.runId || !!item.verificationId;
  const reason = linked ? consensusScoreWithheldReason(independence ?? "unverified") : "independence_unverified";
  if (!reason) return item;
  return { ...item, consensusScore: null, consensusWithheld: reason };
}

export interface EnrichedAdaptiveTeamRunListItemV1 extends AdaptiveTeamRunListItemV1 {
  /** Present only when governanceRecord resolves to family "milestone2" with a single-reviewer decision — see reviewGovernanceViewModel.ts. */
  singleReviewer: Extract<ReviewGovernanceViewModel, { family: "milestone2" }>["singleReviewer"];
  assignment: Extract<ReviewGovernanceViewModel, { family: "milestone2" }>["assignment"];
  panel: Extract<ReviewGovernanceViewModel, { family: "milestone2" }>["panel"];
  /**
   * Review Page Reviewer Display, Step 17 — `true` only when a genuine
   * Firestore read failure prevented resolving this row's
   * reviewer/assignment/panel detail (a real outage), never set merely
   * because nothing is configured yet. Lets the UI show "Review details
   * unavailable" instead of silently rendering an identical-looking
   * "nothing assigned" state for a materially different situation. Set
   * by the route (`app/api/teams/runs/route.ts`), not by this pure
   * builder, which has no knowledge of read success/failure.
   */
  enrichmentUnavailable?: boolean;
}

export type EnrichedTeamRunListItemV1 = EnrichedLegacyTeamRunListItemV1 | EnrichedAdaptiveTeamRunListItemV1;

/** Mirrors `TeamRunListResponseV1`'s exact shape (teamRunListContract.ts), with enriched items — defined here rather than there to avoid that module needing to import from this one (it stays pure/I/O-free per its own header discipline). */
export type EnrichedTeamRunListResponseV1 = {
  ok: true;
  version: 1;
  items: EnrichedTeamRunListItemV1[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
};

/**
 * Pure. `decidedBy` is read from the caller (the route), which sources it
 * from the SAME `teamRuns` doc already fetched for the list — no extra
 * Firestore read. Never reads `notes` (the private decision justification).
 */
export async function enrichLegacyTeamRunListItem(
  item: LegacyTeamRunListItemV1,
  decidedBy: string | undefined,
  resolveDisplayName: (uid: string) => Promise<string>
): Promise<EnrichedLegacyTeamRunListItemV1> {
  const { humanDecision, ...rest } = item;
  if (!humanDecision) {
    return { ...rest };
  }
  const reviewer = decidedBy ? { displayName: await resolveDisplayName(decidedBy) } : null;
  return {
    ...rest,
    humanDecision: { action: humanDecision.action, decidedAt: humanDecision.decidedAt, reviewer },
  };
}

/**
 * Pure given already-fetched data. Delegates the actual canonical-state
 * interpretation to `buildReviewGovernanceViewModel` (never reimplemented)
 * — a malformed/absent `governanceRecord` degrades to `singleReviewer:
 * null, assignment: null, panel: null` exactly as that function already
 * guarantees for its "not_configured"/family-mismatch branches, never a
 * thrown error and never a fabricated result.
 *
 * Also corrects `humanReviewStatus`/`reviewable` (inherited from the base
 * `item`, which is sourced from the `teamRuns` adaptive projection — see
 * this file's header) to the canonical `governanceRecord.humanReview.status`
 * whenever a governance record was actually read. This mirrors the
 * established precedent in `app/api/teams/adaptive-runs/[runId]/route.ts`
 * ("the canonical parent record is authoritative... the response is
 * always built from `record` alone") — that route only *logs* a
 * projection/parent disagreement and never displays the stale value; this
 * builder applies the same rule so the queue's status badge can never
 * show a status that contradicts the reviewer/panel detail rendered right
 * next to it, which is already unconditionally canonical. When no
 * governance record exists, the projection's own value is the only
 * information available and is left as-is.
 */
export async function enrichAdaptiveTeamRunListItem(
  item: AdaptiveTeamRunListItemV1,
  data: {
    governanceRecord: GovernanceRecordV1 | null;
    assignment: AdaptiveHumanReviewAssignmentV1 | null;
    panel: AdaptiveHumanReviewPanelV1 | null;
    votes: AdaptiveHumanReviewVoteV1[];
  },
  resolveDisplayName: (uid: string) => Promise<string>
): Promise<EnrichedAdaptiveTeamRunListItemV1> {
  const viewModel = await buildReviewGovernanceViewModel({
    governanceRecord: data.governanceRecord,
    legacy: null, // this row is already known adaptive-kind; never derive from legacy fields
    assignment: data.assignment,
    panel: data.panel,
    votes: data.votes,
    resolveDisplayName,
  });

  const milestone2 = viewModel.family === "milestone2" ? viewModel : { singleReviewer: null, assignment: null, panel: null };

  const canonicalStatus = data.governanceRecord?.humanReview.status;
  const humanReviewStatus = canonicalStatus ?? item.humanReviewStatus;

  return {
    ...item,
    humanReviewStatus,
    reviewable: canonicalStatus ? isHumanReviewStatusReviewable(canonicalStatus) : item.reviewable,
    singleReviewer: milestone2.singleReviewer,
    assignment: milestone2.assignment,
    panel: milestone2.panel,
  };
}
