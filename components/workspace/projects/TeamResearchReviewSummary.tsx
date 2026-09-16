"use client";

/**
 * TEAM-RESEARCH-PARITY-R3-R1 — the Team-owned, READ-ONLY review summary shown
 * in the review & governance position of a Team durable research report.
 *
 * Supplied by `TeamResearchDetailShell` as the P0 `reviewGovernanceSurface`
 * of a `delegated_read_only` adaptive ancillary presentation, in place of the
 * Personal `ReviewGovernanceSection` (which fetches Personal governance and
 * Personal or legacy-Teams review history).
 *
 * PRESENTATION ONLY. It renders fields the caller already received from the
 * authorized R1 Team detail DTO (`team.review`): the human-review status, any
 * conditions, and the decision receipt's conclusion and flags. It performs no
 * fetch, reads no auth state, touches no Firestore, mutates nothing, and never
 * shows a reviewer identity or comment (the DTO carries none). `decidedVia` is
 * an internal enum and is deliberately not rendered.
 *
 * WORKSPACE REVIEW LINK — intentionally deferred. The canonical Workspace
 * review detail (`/workspace/reviews/{runId}`) additionally requires
 * `reviews.read` and Approval Workflow admission (or an active drain panel).
 * Neither is represented in the R1 Team detail DTO, so a link here could 404
 * for a legitimate research reader; no link is rendered.
 */

import { getReviewStatusBadgeClass, getReviewStatusLabel } from "@/lib/workspaces/reviewQueuePresentation";
import type { TeamRunDetailReview } from "@/lib/research/teamRunDetailPresentation";

export default function TeamResearchReviewSummary({ review }: { review: TeamRunDetailReview | null }) {
  if (!review) return null;
  const receipt = review.decisionReceipt;
  return (
    <section data-testid="team-research-review-summary" aria-label="Review" className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-cp-text">Review</h2>
        <span className={`inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-xs font-medium ${getReviewStatusBadgeClass(review.humanReviewStatus)}`}>
          {getReviewStatusLabel(review.humanReviewStatus)}
        </span>
      </div>
      {review.conditions.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-cp-faint">Conditions</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-cp-text">
            {review.conditions.map((condition, index) => (
              <li key={`${index}-${condition}`}>{condition}</li>
            ))}
          </ul>
        </div>
      )}
      {receipt && (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-cp-faint">Decision receipt</p>
          <p className="mt-1 text-sm text-cp-text">{receipt.conclusion}</p>
          <p className="mt-1 text-xs text-cp-muted">
            {receipt.sourceBacked ? "Source-backed" : "Not source-backed"} · {receipt.humanReviewNeeded ? "Human review needed" : "Human review not required"}
          </p>
        </div>
      )}
    </section>
  );
}
