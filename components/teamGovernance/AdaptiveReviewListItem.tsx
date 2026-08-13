"use client";

/**
 * Review Page Reviewer Display — one adaptive row in the team-review
 * queue. Read-only: renders only fields the enriched list contract
 * exposes (schema, receipt conclusion, statuses, indicators, updated
 * time, plus canonical reviewer/assignment/panel detail) — never a
 * decision control. Kept compact per the task's own "avoid turning each
 * row into a full governance report" guidance — full detail remains in
 * the report's own Review & Governance section (components/adaptive/
 * ReviewGovernanceSection.tsx).
 */

import Link from "next/link";
import type { EnrichedAdaptiveTeamRunListItemV1 } from "@/lib/governance/teamReviewQueueEnrichment";
import { schemaLabel, humanReviewStatusLabel } from "@/lib/governance/teamReviewLabels";
import GovernanceStatusBadge from "./GovernanceStatusBadge";
import HumanReviewStatusBadge from "./HumanReviewStatusBadge";

function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const MAX_INLINE_REVIEWERS = 3;

/** Compact reviewer-progress block — assigned/single-reviewer/peer-review, whichever the canonical data actually establishes. Never fabricates an "in review" state the model doesn't have. */
function ReviewerBlock({ item }: { item: EnrichedAdaptiveTeamRunListItemV1 }) {
  const { singleReviewer, assignment, panel } = item;

  if (item.enrichmentUnavailable) {
    return (
      <div className="mt-3 rounded-lg border border-cp-border bg-cp-raised px-3 py-2 text-xs text-cp-muted" role="status">
        Review details unavailable.
      </div>
    );
  }

  if (panel) {
    if (panel.status === "cancelled") {
      return (
        <div className="mt-3 rounded-lg border border-cp-border bg-cp-raised px-3 py-2 text-xs text-cp-muted" role="status">
          Peer review cancelled.
        </div>
      );
    }

    const visibleReviewers = panel.reviewers.slice(0, MAX_INLINE_REVIEWERS);
    const overflowCount = panel.reviewers.length - visibleReviewers.length;

    return (
      <div className="mt-3 rounded-lg border border-cp-border bg-cp-raised px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold uppercase tracking-wide text-cp-muted">Peer review</span>
          <span className="text-cp-text">
            {panel.submittedCount} of {panel.requiredReviewerCount} completed
          </span>
        </div>
        <ul className="mt-1.5 space-y-0.5">
          {visibleReviewers.map((r) => (
            <li key={r.reviewerKey} className="flex items-center justify-between gap-2 text-cp-text">
              <span className="truncate">{r.displayName}</span>
              <span className="shrink-0 text-cp-muted">{r.hasVoted ? humanReviewStatusLabel(r.voteStatus) : "Pending"}</span>
            </li>
          ))}
        </ul>
        {overflowCount > 0 && <p className="mt-1 text-cp-muted">+{overflowCount} more reviewer{overflowCount === 1 ? "" : "s"}</p>}

        {panel.status === "finalized" && panel.finalizedVia === "owner_override" && (
          <p className="mt-1.5 font-semibold text-amber-700">
            Owner override &middot; {panel.finalStatus ? humanReviewStatusLabel(panel.finalStatus) : "Finalized"}
            {panel.overrideBy ? ` by ${panel.overrideBy.displayName}` : ""}
          </p>
        )}
        {panel.status === "finalized" && panel.finalizedVia !== "owner_override" && (
          <p className="mt-1.5 font-semibold text-cp-text">
            Final result &middot; {panel.finalStatus ? humanReviewStatusLabel(panel.finalStatus) : "Finalized"}
          </p>
        )}
      </div>
    );
  }

  if (singleReviewer) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-cp-border bg-cp-raised px-3 py-2 text-xs">
        <span className="font-medium text-cp-text">{singleReviewer.displayName}</span>
        <span aria-hidden className="text-cp-muted">
          &middot;
        </span>
        <span className="text-cp-muted">{humanReviewStatusLabel(item.humanReviewStatus)}</span>
        {singleReviewer.reviewedAt && <span className="w-full text-cp-muted">Completed {formatUpdatedAt(singleReviewer.reviewedAt)}</span>}
      </div>
    );
  }

  if (assignment) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-cp-border bg-cp-raised px-3 py-2 text-xs">
        <span className="text-cp-muted">Assigned to</span>
        <span className="font-medium text-cp-text">{assignment.reviewerDisplayName}</span>
        {assignment.assignedAt && <span className="w-full text-cp-muted">Assigned {formatUpdatedAt(assignment.assignedAt)}</span>}
      </div>
    );
  }

  return null;
}

export default function AdaptiveReviewListItem({ item }: { item: EnrichedAdaptiveTeamRunListItemV1 }) {
  return (
    <li className="rounded-xl border border-cp-border bg-cp-surface p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded bg-cp-primary-soft px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-cp-primary">
          Adaptive
        </span>
        <span className="text-sm font-semibold text-cp-text">{schemaLabel(item.schemaId)}</span>
        <GovernanceStatusBadge status={item.automatedGovernanceStatus} />
        <HumanReviewStatusBadge status={item.humanReviewStatus} />
        <time className="ml-auto shrink-0 text-xs text-cp-muted" dateTime={item.updatedAt}>
          {formatUpdatedAt(item.updatedAt)}
        </time>
      </div>

      <p className="mt-3 text-sm leading-snug text-cp-text">{item.receiptConclusion}</p>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-cp-muted">
        <span>{item.sourceBacked ? "Source-backed" : "Not source-backed"}</span>
        <span aria-hidden>&middot;</span>
        <span>{item.humanReviewNeeded ? "Human review needed" : "Human review not flagged as needed"}</span>
      </div>

      <ReviewerBlock item={item} />

      <div className="mt-4 flex items-center justify-end border-t border-cp-border pt-3">
        <Link
          href={`/team/reviews/${encodeURIComponent(item.runId)}`}
          className="rounded-md px-3 py-1.5 text-sm font-semibold text-cp-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
        >
          Open review &rarr;
        </Link>
      </div>
    </li>
  );
}
