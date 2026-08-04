"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — one adaptive row in
 * the team-review queue. Read-only: renders only the fields the versioned
 * list contract exposes (schema, receipt conclusion, statuses, indicators,
 * updated time) plus a link to the detail page — never a decision control.
 */

import Link from "next/link";
import type { AdaptiveTeamRunListItemV1 } from "@/lib/governance/teamRunListContract";
import { schemaLabel } from "@/lib/governance/teamReviewLabels";
import GovernanceStatusBadge from "./GovernanceStatusBadge";
import HumanReviewStatusBadge from "./HumanReviewStatusBadge";

function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function AdaptiveReviewListItem({ item }: { item: AdaptiveTeamRunListItemV1 }) {
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
