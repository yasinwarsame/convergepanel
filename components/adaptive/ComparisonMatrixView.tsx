"use client";

/**
 * Query-Routing Redesign, Milestone 2 — comparison_matrix's dedicated
 * renderer, the second schema activated behind the new taxonomy.
 *
 * Deliberately NOT the claims-matrix/synthesis-report shell: a comparison's
 * atomic unit is a (subject, attribute) cell across two independently
 * extracted axes, not a claim — so this reads ComparisonMatrixResult
 * directly (lib/adaptiveSchema/comparisonAlignment.ts) rather than
 * AlignedClaim[]. Mirrors RankedListView's "own standalone view, not forced
 * into the generic shell" philosophy from the same milestone.
 */

import { AggregatedComparisonAttribute, AggregatedComparisonSubject, ComparisonMatrixResult } from "@/lib/adaptiveSchema/types";
import { Card, EmptyStateCard, SectionLabel, TintBadge, formatModelCoverage } from "./shared";

/**
 * Always shown for comparison_matrix — no live verified pricing/spec/data
 * source exists in this codebase (confirmed by infrastructure audit, not
 * assumed), so every cell here is the panel's own generated assessment.
 */
const HONESTY_BANNER =
  "These comparisons reflect the panel models' own knowledge, not live verified pricing, specs, or data. For decisions that matter, confirm critical details against a current source.";

function cellKey(subjectId: string, attributeId: string): string {
  return `${subjectId}::${attributeId}`;
}

function CellContent({ comparisonMatrix, subject, attribute }: {
  comparisonMatrix: ComparisonMatrixResult;
  subject: AggregatedComparisonSubject;
  attribute: AggregatedComparisonAttribute;
}) {
  const cell = comparisonMatrix.cells.find(
    (c) => c.subjectId === subject.id && c.attributeId === attribute.id
  );

  if (!cell) {
    return <span className="text-slate-300">—</span>;
  }

  const tone = cell.agreement === "split" ? "danger" : cell.agreement === "single_source" ? "warning" : "accent";
  const verdictEntries = cell.verdictTally ? Object.entries(cell.verdictTally) : [];
  const hasSources = !!cell.sources && cell.sources.length > 0;
  // "single_source"/"split" aren't genuine cross-model agreement — only
  // consensus/majority mean the contributing models actually agreed on this
  // value, so only those two modes use the "agreed" wording.
  const coverageLabel =
    cell.agreement === "split"
      ? "Models disagree"
      : cell.agreement === "single_source"
        ? formatModelCoverage({ covered: cell.coverageCount, total: cell.totalModels, mode: "assessed" })
        : formatModelCoverage({ covered: cell.coverageCount, total: cell.totalModels, mode: "agreed" });

  return (
    <div className="space-y-1">
      {cell.agreement === "split" ? (
        <div className="space-y-0.5">
          {Object.entries(cell.valuesByModel).map(([modelId, value]) => (
            <p key={modelId} className="text-xs text-slate-700">
              <span className="text-slate-400">{modelId}:</span> {value}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-900">{cell.consensusValue ?? Object.values(cell.valuesByModel)[0]}</p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <TintBadge tone={tone} title={cell.agreement === "split" ? "Models disagree on this value" : coverageLabel}>
          {coverageLabel}
        </TintBadge>
        {verdictEntries.map(([verdict, count]) => (
          <span key={verdict} className="text-[11px] text-slate-500">
            {verdict} ({count})
          </span>
        ))}
        {/* Milestone 2 UI consistency cleanup — sources were already
            collected per cell but never surfaced; a small expandable detail
            rather than a permanent icon, to avoid clutter, and never shown
            on purely judgmental cells with no actual sources. */}
        {hasSources && (
          <details className="w-full">
            <summary className="cursor-pointer text-[11px] text-slate-500">Sources ({cell.sources!.length})</summary>
            <ul className="mt-0.5 list-disc list-outside pl-4 text-[11px] text-slate-500">
              {cell.sources!.map((s, idx) => (
                <li key={idx}>{s}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {cell.rationale && <p className="text-[11px] text-slate-500">{cell.rationale}</p>}
    </div>
  );
}

function LowConfidenceAxisList({ label, items }: { label: string; items: { label: string; coverageCount: number; totalModels: number }[] }) {
  if (items.length === 0) return null;
  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
        Lower-confidence {label}, raised by only 1-2 models ({items.length})
      </summary>
      <ul className="mt-2 flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.label}>
            <TintBadge tone="warning" title={formatModelCoverage({ covered: item.coverageCount, total: item.totalModels, mode: "covered" })}>
              {item.label} ({item.coverageCount}/{item.totalModels})
            </TintBadge>
          </li>
        ))}
      </ul>
    </details>
  );
}

export default function ComparisonMatrixView({ comparisonMatrix }: { comparisonMatrix: ComparisonMatrixResult }) {
  const { subjects, lowConfidenceSubjects, attributes, lowConfidenceAttributes, totalModels } = comparisonMatrix;

  if (totalModels === 0) {
    return <EmptyStateCard state="no_models" />;
  }

  return (
    <div className="space-y-3">
      <Card className="bg-sky-50/60 border-sky-200">
        <p className="text-xs text-sky-900 leading-relaxed">{HONESTY_BANNER}</p>
      </Card>

      <Card>
        <SectionLabel>Comparison</SectionLabel>
        {subjects.length === 0 || attributes.length === 0 ? (
          <p className="text-sm text-slate-500 italic">
            {subjects.length === 0 && lowConfidenceSubjects.length === 0
              ? "No comparable subjects were returned for this question."
              : "The panel didn't converge on enough shared subjects and attributes for a comparison grid."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr>
                  <th className="border-b border-slate-200 p-2 text-xs font-semibold uppercase tracking-wide text-slate-500" />
                  {subjects.map((subject) => (
                    <th
                      key={subject.id}
                      className="border-b border-slate-200 p-2 text-sm font-semibold text-slate-900 whitespace-nowrap"
                    >
                      {subject.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {attributes.map((attribute) => (
                  <tr key={attribute.id}>
                    <th className="border-b border-slate-100 p-2 align-top text-sm font-medium text-slate-700 whitespace-nowrap">
                      {attribute.label}
                    </th>
                    {subjects.map((subject) => (
                      <td key={cellKey(subject.id, attribute.id)} className="border-b border-slate-100 p-2 align-top">
                        <CellContent comparisonMatrix={comparisonMatrix} subject={subject} attribute={attribute} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <LowConfidenceAxisList label="subjects" items={lowConfidenceSubjects} />
      <LowConfidenceAxisList label="attributes" items={lowConfidenceAttributes} />
    </div>
  );
}
