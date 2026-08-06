"use client";

/**
 * Adaptive Synthesis Report, Phase 2 (3-schema pilot) — the "Model
 * Responses" section: raw, unreviewed per-model output, collapsed by
 * default so it never competes with the reviewed synthesis above it.
 *
 * Two pieces, composed under one shared <details> wrapper so there's
 * exactly one "Model Responses" collapsible per schema, never nested ones:
 *
 * - `listView` (procedural/generic this pilot): the existing List view
 *   (ListView.tsx — per-model trust/majority-alignment/response-time
 *   triage, previously only reachable via the now-removed Compare tab)
 *   rendered verbatim, `onNavigateToSynthesis` a no-op since there's no
 *   tab to jump into anymore (its Panel Pulse cards' "jump to Synthesis
 *   Report" affordance simply does nothing when clicked here — a disclosed,
 *   minor UX regression versus the old tabbed shell, not a crash).
 * - Raw per-model output: generalizes DirectAnswerCard's existing collapsed
 *   "Model-by-model answers" pattern (which hardcodes 3 known factual_lookup
 *   field keys) into something driven by the schema's own
 *   `fields: FieldSpec[]` instead, so it works for any schema without a
 *   per-schema rewrite. Always rendered, for all 3 pilot schemas — this is
 *   the "raw model responses, full model wording" piece.
 *
 * Per-field-type rendering is intentionally uneven right now: "string" and
 * "string[]" are common enough to handle properly, "comparisonCell[]" is
 * built out for this pilot's one schema, and every other array-of-object
 * `FieldType` falls back to a generic key:value list — functional but not
 * polished. Disclosed gap, not a silent one: later rollout schemas will
 * need their own case added here as they're wired in.
 */

import { FieldSpec, ComparisonCell, ResultSchema } from "@/lib/adaptiveSchema/types";
import { AdaptiveGateResult, AdaptiveModelResult, AdaptiveSynthesisReport, AdaptiveTrustSummary, AlignedClaim } from "@/lib/adaptiveSchema/types";
import { Card, SectionLabel, BulletList, FailedResultsNote, splitResults, getModelLabel } from "./shared";
import ModelChip from "@/components/ModelChip";
import ListView from "./ListView";

function ComparisonCellList({ cells }: { cells: ComparisonCell[] }) {
  if (!cells || cells.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {cells.map((cell, idx) => (
        <li key={idx} className="text-sm text-slate-800">
          <span className="font-medium text-slate-900">{cell.subject}</span>
          <span className="text-slate-400"> · </span>
          <span className="text-slate-600">{cell.attribute}:</span> {cell.value}
          {cell.verdict && <span className="ml-1 text-xs text-slate-500">({cell.verdict})</span>}
        </li>
      ))}
    </ul>
  );
}

/** Generic fallback for any array-of-object field type not yet special-cased above — a plain key:value list per item, functional but not polished. */
function GenericObjectArrayList({ items }: { items: Record<string, unknown>[] }) {
  if (!items || items.length === 0) return null;
  return (
    <ul className="space-y-2">
      {items.map((item, idx) => (
        <li key={idx} className="rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
          {Object.entries(item).map(([k, v]) => (
            <p key={k}>
              <span className="font-medium text-slate-600">{k}:</span> {Array.isArray(v) ? v.join(", ") : String(v)}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

function FieldValue({ field, value }: { field: FieldSpec; value: unknown }) {
  if (value == null) return null;
  if (field.type === "string") {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    return <p className="text-sm leading-relaxed text-slate-800 whitespace-pre-line">{value}</p>;
  }
  if (field.type === "string[]") {
    return Array.isArray(value) ? <BulletList items={value as string[]} /> : null;
  }
  if (field.type === "comparisonCell[]") {
    return Array.isArray(value) ? <ComparisonCellList cells={value as ComparisonCell[]} /> : null;
  }
  // Every other array-of-object FieldType — generic fallback, see module doc.
  return Array.isArray(value) ? <GenericObjectArrayList items={value as Record<string, unknown>[]} /> : null;
}

function RawModelOutputList({ schema, results }: { schema: ResultSchema; results: AdaptiveModelResult[] }) {
  const { ok, failed } = splitResults(results);
  if (ok.length === 0 && failed.length === 0) return null;

  return (
    <div>
      <SectionLabel>Raw model output ({ok.length})</SectionLabel>
      <div className="space-y-3">
        <FailedResultsNote failed={failed} />
        {ok.map((r) => (
          <Card key={r.modelId} className="bg-slate-50/60">
            <div className="mb-2">
              <ModelChip modelId={r.modelId} size="xs" />
              <span className="sr-only">{getModelLabel(r.modelId)}</span>
            </div>
            <div className="space-y-3">
              {schema.fields.map((field) => (
                <div key={field.key}>
                  <SectionLabel>{field.key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}</SectionLabel>
                  <FieldValue field={field} value={r.data?.[field.key]} />
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export interface ModelResponsesSectionProps {
  schema: ResultSchema;
  results: AdaptiveModelResult[];
  /** Present only for the gate/synthesisReport-driven family (procedural/generic this pilot) — renders the existing List view alongside the raw dump. Absent for comparison_matrix, which never computes this data. */
  listView?: {
    alignedClaims?: AlignedClaim[];
    gate: AdaptiveGateResult;
    synthesisReport: AdaptiveSynthesisReport;
    trustSummary?: AdaptiveTrustSummary;
  };
}

export default function ModelResponsesSection({ schema, results, listView }: ModelResponsesSectionProps) {
  const { ok, failed } = splitResults(results);
  if (ok.length === 0 && failed.length === 0 && !listView) return null;

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">Model Responses</summary>
      <div className="mt-3 space-y-4">
        {listView && (
          <ListView
            schema={schema}
            results={results}
            alignedClaims={listView.alignedClaims}
            gate={listView.gate}
            synthesisReport={listView.synthesisReport}
            trustSummary={listView.trustSummary}
            onNavigateToSynthesis={() => {}}
          />
        )}
        <RawModelOutputList schema={schema} results={results} />
      </div>
    </details>
  );
}
