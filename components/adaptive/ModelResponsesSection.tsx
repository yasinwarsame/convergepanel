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
import { Card, SectionLabel, BulletList, FailedResultsNote, splitResults, getModelLabel, SlotName } from "./shared";
import ModelChip from "@/components/ModelChip";
import { runModelIdentityDetail } from "@/lib/panel/runModelIdentity";
import { useRunModelProvenance } from "./RunModelProvenanceContext";
import { useRunSlotStatus } from "./RunSlotStatusContext";
import ListView, { type ListScoreNames } from "./ListView";
import type { ReadableGateDisplay } from "./AdaptiveSynthesisReportView";
import { SCHEMA_ANSWER_SHAPE } from "@/lib/adaptiveSchema/persistedOutput";
import { SAVED_COPY_SHORTENED, SAVED_TEXT_SHORTENED_LABEL, SAVED_TEXT_UNSTRUCTURED_LABEL } from "@/lib/adaptiveSchema/savedCopyNotice";
import {
  COMPARISON_FIELD_LABEL,
  buildComparisonTable,
  comparisonEntryText,
  modelResponsesCountLines,
  partitionModelResponses,
  summarizeModelResponses,
} from "@/lib/research/modelResponsesPresentation";

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

/**
 * Phase 2A — raw per-model output is never persisted for the Milestone-2
 * schema family (PersistedAdaptiveOutputV1 stores only the single
 * aggregated `result`, deliberately — see persistedOutput.ts's module doc),
 * so a History-reopened run for any of these schemas always passes
 * `results: []` here. Rather than silently render nothing (the pilot's
 * original behavior, which just made the whole "Model Responses" section
 * vanish on reload with no explanation), say so plainly — "do not fabricate
 * them, clearly represent their absence instead" applies to a missing
 * SECTION just as much as to missing content inside one.
 */
function RawResponsesUnavailableNotice() {
  return (
    <p className="text-sm text-slate-500 italic">
      Raw per-model responses aren&apos;t saved for this schema, so they&apos;re not available on a reopened run — only the finished result
      above and in Panel Evidence is preserved.
    </p>
  );
}

function RawModelOutputList({ schema, results }: { schema: ResultSchema; results: AdaptiveModelResult[] }) {
  const { ok, failed } = splitResults(results);
  const provenance = useRunModelProvenance();
  if (ok.length === 0 && failed.length === 0) return <RawResponsesUnavailableNotice />;

  return (
    <div>
      <SectionLabel>Raw model output ({ok.length})</SectionLabel>
      <div className="space-y-3">
        <FailedResultsNote failed={failed} />
        {ok.map((r) => {
          // The run's recorded identity for this slot, only when this surface holds that row.
          const facts = provenance?.find((f) => f.modelId === r.modelId);
          return (
          <Card key={r.modelId} className="bg-slate-50/60">
            <div className="mb-2">
              <ModelChip modelId={r.modelId} size="xs" />
              <span className="sr-only">{getModelLabel(r.modelId)}</span>
              {facts && (
                <span className="ml-2 text-xs text-slate-500" data-testid="run-model-identity-detail">
                  {runModelIdentityDetail(facts)}
                </span>
              )}
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
          );
        })}
      </div>
    </div>
  );
}

/**
 * Saved-response and comparison presentation (2026-11-11) — the Milestone-2 schemas only (the nine with a persisted
 * envelope, whose reopened reports rebuild these results from the saved copies). Every other schema keeps
 * RawModelOutputList above unchanged, byte for byte (sealed historical-parity oracles).
 */
const MILESTONE2_SCHEMA_IDS: ReadonlySet<string> = new Set(Object.keys(SCHEMA_ANSWER_SHAPE));

/** One model's own comparison, as a table: rows are subjects, columns attributes, each cell `value (Verdict)`. */
function ComparisonTable({ cells, modelId }: { cells: ComparisonCell[]; modelId: string }) {
  const table = buildComparisonTable(cells);
  if (table.cellCount === 0) return null;
  return (
    <div className="space-y-2" data-testid="comparison-table">
      {table.subjects.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-cp-border bg-cp-surface" role="region" aria-label={`${getModelLabel(modelId)}'s comparison table`} tabIndex={0}>
          <table className="min-w-full border-collapse text-left text-sm text-cp-text">
            <caption className="caption-top px-3 py-2 text-left text-xs text-cp-muted">
              <SlotName modelId={modelId} />&apos;s own comparison: this model&apos;s judgment, not verified findings or the panel&apos;s combined result.
            </caption>
            <thead className="bg-cp-raised">
              <tr>
                <th scope="col" className="border-b border-cp-border px-3 py-2 text-xs font-semibold text-cp-muted">
                  Compared
                </th>
                {table.attributes.map((attribute, a) => (
                  <th key={a} scope="col" className="min-w-[10rem] border-b border-cp-border px-3 py-2 text-xs font-semibold text-cp-muted break-words">
                    {attribute}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.subjects.map((subject, sIdx) => (
                <tr key={sIdx}>
                  <th scope="row" className="border-b border-cp-border-soft px-3 py-2 font-medium text-cp-text break-words">
                    {subject}
                  </th>
                  {table.attributes.map((_, a) => {
                    const entries = table.entries[sIdx][a];
                    return (
                      <td key={a} className="border-b border-cp-border-soft px-3 py-2 break-words">
                        {entries.length === 0 ? (
                          <span className="text-cp-faint">Not assessed</span>
                        ) : entries.length === 1 ? (
                          comparisonEntryText(entries[0])
                        ) : (
                          <ul className="space-y-1" aria-label={`${entries.length} entries for this cell`}>
                            {entries.map((entry, e) => (
                              <li key={e}>{comparisonEntryText(entry)}</li>
                            ))}
                            <li className="text-xs text-cp-muted">Listed {entries.length} times by this model</li>
                          </ul>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {table.unpaired.length > 0 && (
        <div className="text-sm text-cp-text">
          <p className="text-xs text-cp-muted">Entries without a subject or attribute:</p>
          <ul className="list-disc pl-5">
            {table.unpaired.map((cell, idx) => (
              <li key={idx} className="break-words">
                {[cell.subject, cell.attribute].filter((x) => x.trim().length > 0).join(" · ") || "(unnamed)"}: {comparisonEntryText({ value: cell.value, verdict: cell.verdict })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function hasFieldContent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) ? value.length > 0 : false;
}

function fieldLabel(schema: ResultSchema, key: string): string {
  if (schema.id === "comparison_matrix" && COMPARISON_FIELD_LABEL[key]) return COMPARISON_FIELD_LABEL[key];
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function ModelCardHeader({ modelId }: { modelId: string }) {
  const provenance = useRunModelProvenance();
  // The run's recorded identity for this slot, only when this surface holds that row.
  const facts = provenance?.find((f) => f.modelId === modelId);
  return (
    <div className="mb-2">
      <ModelChip modelId={modelId as never} size="xs" />
      <span className="sr-only">{getModelLabel(modelId)}</span>
      {facts && (
        <span className="ml-2 text-xs text-slate-500" data-testid="run-model-identity-detail">
          {runModelIdentityDetail(facts)}
        </span>
      )}
    </div>
  );
}

/** The saved copy exactly as stored, one keyboard-operable click away (native details/summary). React escapes it. */
function OriginalResponseDisclosure({ text }: { text: string }) {
  return (
    <details className="text-xs text-cp-muted" data-testid="original-response">
      <summary className="cursor-pointer">Show original response</summary>
      <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-cp-raised p-3 text-xs text-cp-text">{text}</pre>
    </details>
  );
}

function Milestone2ModelOutputList({ schema, results }: { schema: ResultSchema; results: AdaptiveModelResult[] }) {
  const statuses = useRunSlotStatus();
  if (results.length === 0) return <RawResponsesUnavailableNotice />;
  const [panelLine, shownLine] = modelResponsesCountLines(summarizeModelResponses(results, statuses));
  const { cards, notes } = partitionModelResponses(results, statuses);
  return (
    <div>
      <SectionLabel>Raw model output</SectionLabel>
      <div className="mb-3 space-y-0.5 text-xs text-cp-muted" data-testid="model-response-counts">
        <p>{panelLine}</p>
        <p>{shownLine}</p>
      </div>
      <div className="space-y-3">
        <FailedResultsNote failed={notes} hideHeading />
        {cards.map((r, idx) => (
          <Card key={`${r.modelId}-${idx}`} className="bg-slate-50/60">
            <ModelCardHeader modelId={r.modelId} />
            {r.ok && r.data ? (
              <div className="space-y-3" data-testid="structured-model-response" data-model-id={r.modelId}>
                {schema.fields
                  .filter((field) => hasFieldContent(r.data?.[field.key]))
                  .map((field) => (
                    <div key={field.key}>
                      <SectionLabel>{fieldLabel(schema, field.key)}</SectionLabel>
                      {field.type === "comparisonCell[]" ? (
                        <ComparisonTable cells={r.data![field.key] as ComparisonCell[]} modelId={r.modelId} />
                      ) : (
                        <FieldValue field={field} value={r.data?.[field.key]} />
                      )}
                    </div>
                  ))}
                {typeof r.savedResponseText === "string" && <OriginalResponseDisclosure text={r.savedResponseText} />}
              </div>
            ) : (
              <div className="space-y-2" data-testid="saved-text-model-response" data-model-id={r.modelId}>
                <p className="text-xs text-cp-muted">{r.parseError === SAVED_COPY_SHORTENED ? SAVED_TEXT_SHORTENED_LABEL : SAVED_TEXT_UNSTRUCTURED_LABEL}</p>
                {/* Review D2: plain text only, never parsed into structure. React escapes it. */}
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-cp-raised p-3 text-sm text-cp-text" data-testid="saved-text-plain">
                  {r.savedResponseText ?? ""}
                </pre>
              </div>
            )}
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
    /** #290 Inc 1: readable mode only (ListScoreNames); absent on every classic call site. */
    scoreNames?: ListScoreNames;
    /** #290 Inc 1: readable mode only — the page's one gate presentation for the run-header badge; absent on every classic call site. */
    readableGate?: ReadableGateDisplay;
  };
}

export default function ModelResponsesSection({ schema, results, listView }: ModelResponsesSectionProps) {
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
            scoreNames={listView.scoreNames}
            readableGate={listView.readableGate}
            onNavigateToSynthesis={() => {}}
          />
        )}
        {MILESTONE2_SCHEMA_IDS.has(schema.id) ? (
          <Milestone2ModelOutputList schema={schema} results={results} />
        ) : (
          <RawModelOutputList schema={schema} results={results} />
        )}
      </div>
    </details>
  );
}
