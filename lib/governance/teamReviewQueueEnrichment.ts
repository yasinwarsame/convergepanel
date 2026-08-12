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
import type { GovernanceRecordV1 } from "../adaptiveSchema/governanceRecord";
import type { AdaptiveHumanReviewAssignmentV1 } from "./adaptiveHumanReviewAssignment";
import type { AdaptiveHumanReviewPanelV1 } from "./adaptiveHumanReviewPanel";
import type { AdaptiveHumanReviewVoteV1 } from "./adaptiveHumanReviewVote";

export interface EnrichedLegacyTeamRunListItemV1 extends Omit<LegacyTeamRunListItemV1, "humanDecision"> {
  humanDecision?: {
    action: "approved" | "rejected" | "escalated";
    decidedAt: string;
    /** Resolved display identity of the decider — `null` only when `decidedBy` is absent (decision predates identity capture, extremely unlikely but handled). Never a raw uid. */
    reviewer: { displayName: string } | null;
  };
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

  return {
    ...item,
    singleReviewer: milestone2.singleReviewer,
    assignment: milestone2.assignment,
    panel: milestone2.panel,
  };
}
