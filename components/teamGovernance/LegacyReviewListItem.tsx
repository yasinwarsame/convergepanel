"use client";

/**
 * Review Page Reviewer Display — one legacy row in the team-review
 * queue. Display-only: legacy rows have no adaptive-style detail page in
 * this step, so no "Open review" action is rendered here (matching
 * §25.17's own field list for the legacy row, which excludes it).
 */

import type { EnrichedLegacyTeamRunListItemV1 } from "@/lib/governance/teamReviewQueueEnrichment";

/**
 * A legacy team-queue row (`teamRuns`) stores a consensus score but no per-model execution identity, so it cannot be
 * established that at least two independent models contributed (lib/panel/independentVoices.ts). The stored score is
 * shown only with that qualification — never as unqualified multi-model agreement.
 */
export const LEGACY_CONSENSUS_INDEPENDENCE_QUALIFIER = "model independence not recorded";

export function legacyConsensusText(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return "No consensus score";
  return `Consensus ${Math.round(score)}/100 (${LEGACY_CONSENSUS_INDEPENDENCE_QUALIFIER})`;
}

function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function LegacyReviewListItem({ item }: { item: EnrichedLegacyTeamRunListItemV1 }) {
  const decisionLabel = item.humanDecision
    ? item.humanDecision.action.charAt(0).toUpperCase() + item.humanDecision.action.slice(1)
    : "No decision yet";

  return (
    <li className="rounded-xl border border-cp-border bg-cp-surface p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded bg-cp-raised px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-cp-muted">
          Legacy
        </span>
        {item.querySummary ? <span className="text-sm text-cp-text">{item.querySummary}</span> : null}
        <time className="ml-auto shrink-0 text-xs text-cp-muted" dateTime={item.createdAt}>
          {formatCreatedAt(item.createdAt)}
        </time>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-cp-muted">
        <span>
          {item.policyFlags.length} policy flag{item.policyFlags.length === 1 ? "" : "s"}
        </span>
        <span aria-hidden>&middot;</span>
        <span>{legacyConsensusText(item.consensusScore)}</span>
        <span aria-hidden>&middot;</span>
        <span>{decisionLabel}</span>
      </div>

      {item.humanDecision && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-cp-border bg-cp-raised px-3 py-2 text-xs">
          <span className="font-medium text-cp-text">{item.humanDecision.reviewer ? item.humanDecision.reviewer.displayName : "Unknown reviewer"}</span>
          <span aria-hidden className="text-cp-muted">
            &middot;
          </span>
          <span className="text-cp-muted">{decisionLabel}</span>
          <span className="w-full text-cp-muted">Completed {formatCreatedAt(item.humanDecision.decidedAt)}</span>
        </div>
      )}
    </li>
  );
}
