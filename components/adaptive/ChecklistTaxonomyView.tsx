"use client";

/**
 * Query-Routing Redesign, Milestone 2 — checklist_taxonomy's dedicated
 * renderer, the fifth schema activated behind the new taxonomy.
 *
 * Deliberately NOT the claims-matrix/synthesis-report shell: this schema's
 * atomic unit is an item (optionally categorized), not a claim, and order
 * never matters — no rank/position implies importance, unlike
 * RankedListView. When the panel never used meaningful categories, this
 * renders as a flat checklist (no category headings); when it did, the
 * exact same data renders as a categorized taxonomy instead.
 */

import { AggregatedChecklistItem, ChecklistTaxonomyResult } from "@/lib/adaptiveSchema/types";
import { Card, EmptyStateCard, SectionLabel, TintBadge, formatModelCoverage } from "./shared";
import ModelChip from "@/components/ModelChip";
import { ModelId } from "@/lib/types";

function ChecklistItemRow({ item }: { item: AggregatedChecklistItem }) {
  const modelIds = item.contributingModels as ModelId[];
  return (
    <li className="flex items-start gap-2.5 py-2 border-b border-slate-100 last:border-0">
      <span className="mt-0.5 shrink-0 h-4 w-4 rounded border border-slate-300" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-800">{item.label}</span>
          {item.critical && <TintBadge tone="danger">Critical</TintBadge>}
          <TintBadge tone={item.coverageRatio >= 0.6 ? "accent" : "warning"}>
            {formatModelCoverage({ covered: item.coverageCount, total: item.totalModels, mode: "covered" })}
          </TintBadge>
        </div>
        {item.rationale && <p className="mt-0.5 text-xs text-slate-600">{item.rationale}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {modelIds.map((modelId) => (
            <ModelChip key={modelId} modelId={modelId} size="xs" />
          ))}
        </div>
      </div>
    </li>
  );
}

export default function ChecklistTaxonomyView({ checklistTaxonomy }: { checklistTaxonomy: ChecklistTaxonomyResult }) {
  const { summary, categories, lowConfidenceItems, notes, totalModels } = checklistTaxonomy;

  if (totalModels === 0) {
    return <EmptyStateCard state="no_models" />;
  }

  const isFlatChecklist = categories.length <= 1 && (categories.length === 0 || categories[0].category === "General");
  const isEmpty = categories.length === 0 && lowConfidenceItems.length === 0;

  return (
    <div className="space-y-3">
      {summary && (
        <Card>
          <p className="text-sm text-slate-800 leading-relaxed">{summary}</p>
        </Card>
      )}

      {notes.length > 0 && (
        <Card className="bg-amber-50 border-amber-200">
          <ul className="list-disc list-outside pl-5 space-y-1 text-xs text-amber-900">
            {notes.map((n, idx) => (
              <li key={idx}>{n}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        {isEmpty ? (
          <p className="text-sm text-slate-500 italic">No checklist items were returned for this question.</p>
        ) : isFlatChecklist ? (
          <ul>{categories[0]?.items.map((item) => <ChecklistItemRow key={item.id} item={item} />)}</ul>
        ) : (
          <div className="space-y-4">
            {categories.map((group) => (
              <div key={group.category}>
                <SectionLabel>{group.category}</SectionLabel>
                <ul>
                  {group.items.map((item) => (
                    <ChecklistItemRow key={item.id} item={item} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      {lowConfidenceItems.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
            Lower-confidence items, raised by only 1-2 models ({lowConfidenceItems.length})
          </summary>
          <ul className="mt-2">
            {lowConfidenceItems.map((item) => (
              <ChecklistItemRow key={item.id} item={item} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
