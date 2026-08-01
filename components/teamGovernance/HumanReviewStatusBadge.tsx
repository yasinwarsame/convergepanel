"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — small status badge
 * for a run's human-review status. Always renders a text label alongside
 * color (never color alone).
 */

import { humanReviewStatusLabel } from "@/lib/governance/teamReviewLabels";

function toneClasses(status: string | undefined | null): string {
  switch (status) {
    case "unreviewed":
      return "bg-cp-raised text-cp-muted ring-1 ring-cp-border";
    case "pending":
      return "bg-blue-900/30 text-blue-400 ring-1 ring-blue-700/40";
    case "approved":
    case "approved_with_conditions":
      return "bg-emerald-900/30 text-emerald-400 ring-1 ring-emerald-700/40";
    case "changes_requested":
      return "bg-amber-900/30 text-amber-400 ring-1 ring-amber-700/40";
    case "rejected":
      return "bg-red-900/30 text-red-400 ring-1 ring-red-700/40";
    default:
      return "bg-cp-raised text-cp-muted ring-1 ring-cp-border";
  }
}

export default function HumanReviewStatusBadge({ status }: { status: string | undefined | null }) {
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${toneClasses(status)}`}>
      {humanReviewStatusLabel(status)}
    </span>
  );
}
