/**
 * Review & Governance report-completion — the presentation-safe DTO
 * consumed by `GET /api/user/runs/[runId]/governance` and rendered by
 * `ReviewGovernanceSection.tsx`. Mirrors `reportStatus.ts`'s own
 * discipline: a pure, client-safe (no "server-only") derivation over
 * already-fetched/parsed data, never a second interpretation of raw
 * Firestore documents.
 *
 * Deliberately does NOT duplicate `deriveReportStatus()`'s job — the
 * report's overall status label/conditions/owner-override flag continue
 * to come from the existing compact `humanReview`/`reviewRouting`/
 * `persistenceStatus` props every report call site already threads down
 * (see `reportStatus.ts`). This module only ever ADDS what was missing:
 * resolved reviewer identity, assignment, and peer-review panel/quorum/
 * vote detail — never a second, possibly-disagreeing status computation.
 *
 * Family-aware by construction: `governanceRecord` (Milestone-2, richer
 * vocabulary) and `legacy` (System A's smaller `governanceStatus`
 * vocabulary) are two genuinely different contracts (see
 * governanceRecord.ts / evaluateGovernance.ts) — this type never lets a
 * caller read a Milestone-2-only field off a legacy result or vice versa.
 *
 * Never includes `comment`, `overrideJustification`, or any vote's
 * `comment`/`conditions` text — enforced by construction, since the
 * builder below never reads those fields off any input into the output.
 * Identity IS included (a deliberate, disclosed relaxation of the
 * component's prior "never reviewer identity" stance — see
 * ReviewGovernanceSection.tsx's own doc comment).
 */

import type { GovernanceRecordV1 } from "./governanceRecord";
import type { AdaptiveHumanReviewAssignmentV1 } from "../governance/adaptiveHumanReviewAssignment";
import type { AdaptiveHumanReviewPanelV1, AdaptiveReviewFinalStatus } from "../governance/adaptiveHumanReviewPanel";
import type { AdaptiveHumanReviewVoteV1 } from "../governance/adaptiveHumanReviewVote";
import type { AdaptiveReviewDecisionStatus } from "../governance/adaptiveHumanReviewRequest";
import { aggregateAdaptiveReviewVotes } from "../governance/adaptiveReviewAggregation";

export interface ReviewGovernanceReviewerView {
  userId: string;
  displayName: string;
  hasVoted: boolean;
  voteStatus?: AdaptiveReviewDecisionStatus;
  submittedAt?: string;
}

export interface ReviewGovernancePanelView {
  status: AdaptiveHumanReviewPanelV1["status"];
  requiredReviewerCount: number;
  quorum: number;
  reviewers: ReviewGovernanceReviewerView[];
  submittedCount: number;
  approvalCount: number;
  blockingCount: number;
  /** Present only while `status === "open"` — a derived, never-stored read of the pure aggregation engine. */
  aggregationState?: "waiting" | "deadlocked" | "ready";
  /** Present only once `status === "finalized"`. */
  finalStatus?: AdaptiveReviewFinalStatus;
  finalizedAt?: string;
  finalizedVia?: "aggregation" | "owner_override";
  /** Present only when `finalizedVia === "owner_override"`. */
  overrideBy?: { userId: string; displayName: string };
}

export type ReviewGovernanceViewModel =
  | { family: "not_configured" }
  | {
      family: "legacy";
      status: "approved" | "needs_review" | "blocked";
      reasons: string[];
      reviewer: { displayName: string } | null;
      reviewedAt: string | null;
    }
  | {
      family: "milestone2";
      /**
       * Present only for the single-reviewer decision path (`decidedVia`
       * absent or `"single_reviewer"`) once a decision has actually been
       * recorded (`humanReview.reviewerId` present) — never populated for
       * a multi-reviewer panel decision, whose identity surfaces instead
       * through `panel.reviewers`/`panel.overrideBy` below, so a run never
       * shows the same decision under two different identity shapes.
       */
      singleReviewer: { userId: string; displayName: string; reviewedAt: string | null } | null;
      /** Present only when `runs/{runId}/humanReviewAssignment/current` exists with a live assignee. */
      assignment: {
        reviewerUserId: string;
        reviewerDisplayName: string;
        assignedAt: string | null;
        assignedByUserId: string | null;
        assignedByDisplayName: string | null;
      } | null;
      /** Present only when `runs/{runId}/humanReviewPanel/current` exists — peer review is/was configured. */
      panel: ReviewGovernancePanelView | null;
    };

/** Replaces the old `decidedVia.replace(/_/g, " ")` mechanical fallback with real display copy, while still degrading gracefully (never throws/blanks) for any future unlisted value. */
const DECIDED_VIA_LABELS: Record<string, string> = {
  single_reviewer: "Single reviewer",
  multi_reviewer_panel: "Reviewer panel (majority)",
  multi_reviewer_owner_override: "Owner override",
};

export function decidedViaLabel(decidedVia: string | undefined | null): string | null {
  if (!decidedVia) return null;
  return DECIDED_VIA_LABELS[decidedVia] ?? decidedVia.replace(/_/g, " ");
}

export interface BuildReviewGovernanceViewModelInput {
  /** Already parsed via `parseGovernanceRecord()` — `null` means genuinely absent. A malformed/unsupported-version record is a route-level error state (surfaced as "unavailable", never silently treated as "not configured" or "legacy") and must never reach this builder. */
  governanceRecord: GovernanceRecordV1 | null;
  /** Already-validated legacy (System A) governance fields off the run document — `null` when no legacy governance status was ever set either. */
  legacy: {
    status: "approved" | "needs_review" | "blocked";
    reasons: string[];
    reviewedByUid: string | null;
    reviewedAt: string | null;
  } | null;
  assignment: AdaptiveHumanReviewAssignmentV1 | null;
  panel: AdaptiveHumanReviewPanelV1 | null;
  /** Only ever meaningful (and only ever fetched by the caller) when `panel` is present and not cancelled. */
  votes: AdaptiveHumanReviewVoteV1[];
  /** Injected so this builder stays pure/testable — no Firestore/adminDb import in this file. */
  resolveDisplayName: (uid: string) => Promise<string>;
}

type MilestoneAssignmentView = Extract<ReviewGovernanceViewModel, { family: "milestone2" }>["assignment"];

async function buildPanelView(
  panel: AdaptiveHumanReviewPanelV1,
  votes: AdaptiveHumanReviewVoteV1[],
  resolveDisplayName: (uid: string) => Promise<string>
): Promise<ReviewGovernancePanelView> {
  const voteByReviewer = new Map(votes.map((v) => [v.reviewerUserId, v] as const));

  const reviewers: ReviewGovernanceReviewerView[] = await Promise.all(
    panel.reviewerUserIds.map(async (userId) => {
      const displayName = await resolveDisplayName(userId);
      const vote = voteByReviewer.get(userId);
      return {
        userId,
        displayName,
        hasVoted: vote !== undefined,
        ...(vote ? { voteStatus: vote.status, submittedAt: vote.submittedAt } : {}),
      };
    })
  );

  let submittedCount = votes.length;
  let approvalCount = 0;
  let blockingCount = 0;
  let aggregationState: "waiting" | "deadlocked" | "ready" | undefined;

  if (panel.status === "open") {
    const aggregate = aggregateAdaptiveReviewVotes({ panel, votes });
    if (aggregate.status === "waiting" || aggregate.status === "deadlocked" || aggregate.status === "ready") {
      aggregationState = aggregate.status;
      submittedCount = aggregate.submittedCount;
      approvalCount = aggregate.approvalGroupCount;
      blockingCount = aggregate.blockingGroupCount;
    }
    // "invalid" (should not be reachable given this endpoint's own reads
    // mirror the finalization transaction's validation) falls back to the
    // zeroed defaults above rather than surfacing an internal error — this
    // is a read-only detail endpoint, never a gate.
  } else {
    approvalCount = votes.filter((v) => v.status === "approved" || v.status === "approved_with_conditions").length;
    blockingCount = votes.filter((v) => v.status === "changes_requested" || v.status === "rejected").length;
  }

  let overrideBy: { userId: string; displayName: string } | undefined;
  if (panel.finalizedVia === "owner_override" && panel.overrideByUserId) {
    overrideBy = { userId: panel.overrideByUserId, displayName: await resolveDisplayName(panel.overrideByUserId) };
  }

  return {
    status: panel.status,
    requiredReviewerCount: panel.requiredReviewerCount,
    quorum: panel.quorum,
    reviewers,
    submittedCount,
    approvalCount,
    blockingCount,
    ...(panel.status === "open" ? { aggregationState } : {}),
    ...(panel.status === "finalized"
      ? { finalStatus: panel.finalStatus, finalizedAt: panel.finalizedAt, finalizedVia: panel.finalizedVia ?? "aggregation" }
      : {}),
    ...(overrideBy ? { overrideBy } : {}),
  };
}

/**
 * Pure given already-fetched/parsed inputs — no I/O of its own (identity
 * resolution is injected). Never reads `humanReview.comment`,
 * `vote.comment`/`vote.conditions`, or `overrideJustification` from any
 * input into the returned view model.
 */
export async function buildReviewGovernanceViewModel(input: BuildReviewGovernanceViewModelInput): Promise<ReviewGovernanceViewModel> {
  const { governanceRecord, legacy, assignment, panel, votes, resolveDisplayName } = input;

  if (governanceRecord) {
    const hr = governanceRecord.humanReview;

    let singleReviewer: { userId: string; displayName: string; reviewedAt: string | null } | null = null;
    if (hr.reviewerId && (hr.decidedVia === undefined || hr.decidedVia === "single_reviewer")) {
      singleReviewer = {
        userId: hr.reviewerId,
        displayName: await resolveDisplayName(hr.reviewerId),
        reviewedAt: hr.reviewedAt ?? null,
      };
    }

    let assignmentView: MilestoneAssignmentView = null;
    if (assignment && assignment.assignedReviewerUserId) {
      const [reviewerDisplayName, assignedByDisplayName] = await Promise.all([
        resolveDisplayName(assignment.assignedReviewerUserId),
        assignment.assignedByUserId ? resolveDisplayName(assignment.assignedByUserId) : Promise.resolve(null),
      ]);
      assignmentView = {
        reviewerUserId: assignment.assignedReviewerUserId,
        reviewerDisplayName,
        assignedAt: assignment.assignedAt,
        assignedByUserId: assignment.assignedByUserId,
        assignedByDisplayName,
      };
    }

    const panelView = panel ? await buildPanelView(panel, votes, resolveDisplayName) : null;

    return { family: "milestone2", singleReviewer, assignment: assignmentView, panel: panelView };
  }

  if (legacy) {
    const reviewer = legacy.reviewedByUid ? { displayName: await resolveDisplayName(legacy.reviewedByUid) } : null;
    return { family: "legacy", status: legacy.status, reasons: legacy.reasons, reviewer, reviewedAt: legacy.reviewedAt };
  }

  return { family: "not_configured" };
}
