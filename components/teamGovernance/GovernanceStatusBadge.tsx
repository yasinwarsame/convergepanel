"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — small status badge
 * for an adaptive run's automated-governance status. Always renders a text
 * label alongside color (never color alone).
 */

import { automatedGovernanceStatusLabel } from "@/lib/governance/teamReviewLabels";

function toneClasses(status: string | undefined | null): string {
  switch (status) {
    case "flagged":
      return "bg-amber-900/30 text-amber-400 ring-1 ring-amber-700/40";
    case "blocked":
      return "bg-red-900/30 text-red-400 ring-1 ring-red-700/40";
    case "passed":
      return "bg-green-100 text-green-800 ring-1 ring-green-300";
    case "error":
      return "bg-red-900/30 text-red-400 ring-1 ring-red-700/40";
    case "not_evaluated":
    default:
      return "bg-cp-raised text-cp-muted ring-1 ring-cp-border";
  }
}

export default function GovernanceStatusBadge({ status }: { status: string | undefined | null }) {
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${toneClasses(status)}`}>
      {automatedGovernanceStatusLabel(status)}
    </span>
  );
}
