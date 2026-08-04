"use client";

/**
 * Query-Routing Redesign, Milestone 2 — ranked_enumeration's dedicated
 * renderer, the first schema activated behind the new taxonomy.
 *
 * Deliberately NOT the claims-matrix/synthesis-report shell: a ranked
 * list's atomic unit is a list item (rank/category/coverage), not a claim,
 * so this reads AggregatedEnumItem[] directly (lib/adaptiveSchema/
 * enumAlignment.ts) rather than AlignedClaim[]. Mirrors DirectAnswerCard's
 * "lightweight, fit-for-purpose" philosophy from Milestone 1's
 * factual_lookup change.
 */

import { AggregatedEnumItem, RankedEnumerationResult } from "@/lib/adaptiveSchema/types";
import { Card, EmptyStateCard, SectionLabel, TintBadge, formatModelCoverage } from "./shared";
import ModelChip from "@/components/ModelChip";
import { ModelId } from "@/lib/types";

/**
 * Always shown for ranked_enumeration — no live query-log/search-frequency
 * data source exists in this codebase (confirmed by infrastructure audit,
 * not assumed), so every ranking here is the panel's own informed estimate,
 * whether the question was framed as "most common" or "best/top N".
 */
const HONESTY_BANNER =
  "No model has live query-log data. This ranking reflects what the panel independently estimates to be most important, relevant, or common. Treat it as an informed estimate, not measured search or usage data.";

function RankItemRow({ item }: { item: AggregatedEnumItem }) {
  const modelIds = Object.keys(item.sourceRanks) as ModelId[];
  const hasSources = !!item.sources && item.sources.length > 0;
  return (
    <li className="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0">
      <span className="mt-0.5 shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full bg-sky-50 text-xs font-semibold text-sky-700 border border-sky-200">
        {Math.round(item.panelRank)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-900">{item.label}</span>
          {item.category && (
            <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              {item.category}
            </span>
          )}
          <TintBadge tone={item.coverageRatio >= 0.6 ? "accent" : "warning"}>
            {formatModelCoverage({ covered: item.coverageCount, total: item.totalModels, mode: "covered" })}
          </TintBadge>
        </div>
        {item.rationale && <p className="mt-1 text-xs text-slate-600">{item.rationale}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {modelIds.map((modelId) => (
            <ModelChip key={modelId} modelId={modelId} size="xs" />
          ))}
        </div>
        {/* Milestone 2 UI consistency cleanup — sources were already collected
            per item but never surfaced; collapsed by default, and never
            implies more citations make the ranking more objectively correct. */}
        {hasSources && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-slate-500">Sources ({item.sources!.length})</summary>
            <ul className="mt-1 list-disc list-outside pl-4 text-[11px] text-slate-500">
              {item.sources!.map((s, idx) => (
                <li key={idx}>{s}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </li>
  );
}

export default function RankedListView({ rankedEnumeration }: { rankedEnumeration: RankedEnumerationResult }) {
  const { items, lowConfidenceItems, requestedCount, actualCount, shortfallNote, rankCorrelation, totalModels } = rankedEnumeration;

  if (totalModels === 0) {
    return <EmptyStateCard state="no_models" />;
  }

  return (
    <div className="space-y-3">
      <Card className="bg-sky-50/60 border-sky-200">
        <p className="text-xs text-sky-900 leading-relaxed">{HONESTY_BANNER}</p>
      </Card>

      {shortfallNote && (
        <Card className="bg-amber-50 border-amber-200">
          <p className="text-xs text-amber-900 leading-relaxed">{shortfallNote}</p>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
          <SectionLabel>Ranked list{requestedCount ? ` (${actualCount} of ${requestedCount} requested)` : ""}</SectionLabel>
          {rankCorrelation !== null && (
            <span className="text-xs text-slate-500" title="Mean Spearman rank correlation across every model pair with at least 2 commonly-covered items">
              Rank agreement across models: {rankCorrelation.toFixed(2)}
            </span>
          )}
        </div>

        {items.length === 0 && lowConfidenceItems.length === 0 ? (
          <p className="text-sm text-slate-500 italic">No items were returned for this question.</p>
        ) : (
          <ul>
            {items.map((item) => (
              <RankItemRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </Card>

      {lowConfidenceItems.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
            Lower-confidence items, raised by only 1-2 models ({lowConfidenceItems.length})
          </summary>
          <ul className="mt-2">
            {lowConfidenceItems.map((item) => (
              <RankItemRow key={item.id} item={item} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
