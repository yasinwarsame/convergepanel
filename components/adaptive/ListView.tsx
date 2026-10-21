"use client";

/**
 * List View (redesign) — per-model triage, not another run summary.
 *
 * Top to bottom: run header strip (schema + gate + certainty/claim counts),
 * a Panel Pulse of three clickable metric cards (consensus/split/single-model,
 * each jumping to the matching Synthesis Report anchor), then one row per
 * panel model — trust, alignment-to-majority, deviation badges, response
 * time, a one-line headline, and an expand-to-full-response toggle. Failed
 * models render as rows too (never silently dropped).
 *
 * Every number here is derived from data the pipeline already computed
 * (AdaptiveModelResult / AlignedClaim / ModelTrustSummary) — no new model
 * calls. The alignment-ratio math mirrors trustSummary.ts's
 * majorityStance()/computeConsistencyAndContradiction() exactly, duplicated
 * here (not imported) because that module is "server-only" and List View
 * needs the raw matched/participated counts (trustSummary only exposes the
 * ratio), not just the percentage.
 */

import { useMemo, useState } from "react";
import { ModelId } from "@/lib/types";
import {
  AdaptiveGateResult,
  AdaptiveModelResult,
  AdaptiveSynthesisReport,
  AdaptiveTrustSummary,
  AlignedClaim,
  FieldSpec,
  ModelTrustSummary,
  ResultSchema,
} from "@/lib/adaptiveSchema/types";
import { TRUST_SCORE_CAP_REASON } from "@/lib/adaptiveSchema/config";
import { Card, SectionLabel, BulletList, ConfidencePill, ProbabilityBar, TintBadge, SlotName } from "./shared";
import ModelChip from "@/components/ModelChip";
import { GateTone, gateChipText, gateTone, pageGateValue } from "@/lib/adaptiveSchema/gatePresentation";
import { PanelCounts, ROW_COUNTS_UNAVAILABLE, SlotRowCounts, hasReadableRowBreakdown, panelCounts, readSlots, rowTypeOf, slotLabel, slotRowCounts } from "@/lib/adaptiveSchema/positionPresentation";
import { PositionPresentationBoundary, PositionPresentationState, usePositionPresentation } from "./PositionPresentationContext";

// Wording: gatePresentation.gateChipText (D6/D7); "neutral": an unrecognized stored gate (D8).
const GATE_CHIP_STYLES: Record<GateTone, string> = {
  pass: "bg-green-50 text-green-700 border-green-200",
  caution: "bg-amber-50 text-amber-700 border-amber-200",
  fail: "bg-red-50 text-red-700 border-red-200",
  neutral: "bg-slate-50 text-slate-600 border-slate-200",
};

type ParseHealth = ModelTrustSummary["parseHealth"];

const HEALTH_DOT_COLORS: Record<ParseHealth, string> = {
  ok: "bg-emerald-500",
  degraded: "bg-amber-500",
  failed: "bg-red-500",
};

// ─── Pure helpers (data derivation) ────────────────────────────────────────

/** Mirrors trustSummary.ts's parseHealthFor — used only as a fallback when trustSummary wasn't computed for this run. */
function deriveParseHealth(result: AdaptiveModelResult): ParseHealth {
  if (!result.ok) return "failed";
  if (result.truncatedFields && result.truncatedFields.length > 0) return "degraded";
  return "ok";
}

/** Mirrors trustSummary.ts's majorityStance — mode of a row's non-null cell stances, ties broken by first-seen order. */
function majorityStance(row: AlignedClaim): string | null {
  const counts = new Map<string, number>();
  for (const cell of row.cells) {
    if (!cell) continue;
    counts.set(cell.stance, (counts.get(cell.stance) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [stance, count] of counts) {
    if (count > bestCount) {
      best = stance;
      bestCount = count;
    }
  }
  return best;
}

/** Raw counts behind trustSummary.ts's majorityAlignment ratio — "aligns 6/6" needs the integers, not just the fraction. */
function computeAlignment(modelId: ModelId, rows: AlignedClaim[]): { matched: number; participated: number } {
  let participated = 0;
  let matched = 0;
  for (const row of rows) {
    const cell = row.cells.find((c) => c?.modelId === modelId);
    if (!cell) continue;
    participated += 1;
    if (majorityStance(row) === cell.stance) matched += 1;
  }
  return { matched, participated };
}

function countDisputes(modelId: ModelId, rows: AlignedClaim[], position?: PositionPresentationState | null): number {
  // Order 5 (Contract P): on a marked report only CLAIM rows count, by the slot's own validated position — a value
  // comparison's stored stance is never a disputed claim.
  if (position) return rows.filter((row) => rowTypeOf(row.cells) === "claim" && readSlots(row.cells, position.roster).slots.some((s) => s.slot === modelId && s.kind === "position" && s.stance === "disputes")).length;
  return rows.filter((row) => row.cells.some((c) => c?.modelId === modelId && c.stance === "disputes")).length;
}

function countUniqueClaims(modelId: ModelId, rows: AlignedClaim[]): number {
  return rows.filter((row) => {
    if (row.status !== "single_source") return false;
    const sole = row.cells.find((c): c is NonNullable<typeof c> => !!c);
    return sole?.modelId === modelId;
  }).length;
}

function isRealSource(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "unknown" && normalized !== "none" && normalized !== "n/a";
}

/** Mirrors trustSummary.ts's computeCitationScore's sourcing scope, but returns the raw sourced count (badge shows "7 citations", not a percentage). */
function countCitations(schema: ResultSchema, result: AdaptiveModelResult): number {
  if (!result.ok || !result.data) return 0;
  let count = 0;
  const metricFieldKeys = schema.fields.filter((f) => f.type === "metric[]").map((f) => f.key);
  for (const key of metricFieldKeys) {
    const metrics = (result.data[key] as { source?: string }[] | undefined) || [];
    for (const m of metrics) if (isRealSource(m.source)) count += 1;
  }
  if (schema.id === "factual_lookup" && isRealSource(result.data["source"] as string | undefined)) count += 1;
  return count;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** What the row collapses to before expansion — schema.headlineField's content, formatted per its FieldType and truncated to ~140 chars. */
function headlineText(schema: ResultSchema, data: Record<string, any> | null): string {
  if (!data) return "";
  const field = schema.fields.find((f) => f.key === schema.headlineField);
  const value = data[schema.headlineField];
  if (value == null) return "";

  let text: string;
  switch (field?.type) {
    case "string":
      text = String(value);
      break;
    case "string[]":
      text = Array.isArray(value) ? value.join("; ") : String(value);
      break;
    case "claim[]":
      text = Array.isArray(value) ? value.map((c: any) => c?.claim).filter(Boolean).join("; ") : String(value);
      break;
    case "metric[]":
      text = Array.isArray(value)
        ? value.map((m: any) => `${m?.label}: ${m?.value ?? "—"} ${m?.unit ?? ""}`.trim()).join(" · ")
        : String(value);
      break;
    case "step[]":
      text = Array.isArray(value)
        ? [...value].sort((a: any, b: any) => a.order - b.order).map((s: any) => s?.action).filter(Boolean).join(" → ")
        : String(value);
      break;
    case "scenario[]":
      text = Array.isArray(value)
        ? value.map((s: any) => `${s?.label} (${Math.round((s?.probability ?? 0) * 100)}%)`).join(" · ")
        : String(value);
      break;
    default:
      text = String(value);
  }

  return truncate(text, 140);
}

function formatLatency(latencyMs?: number): string {
  if (typeof latencyMs !== "number" || Number.isNaN(latencyMs)) return "—";
  return latencyMs >= 1000 ? `${(latencyMs / 1000).toFixed(1)}s` : `${latencyMs}ms`;
}

function fieldLabel(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function countByStatus(rows: AlignedClaim[], status: AlignedClaim["status"]): number {
  return rows.filter((r) => r.status === status).length;
}

// ─── Row view-model + sorting ───────────────────────────────────────────────

interface RowVM {
  result: AdaptiveModelResult;
  failed: boolean;
  parseHealth: ParseHealth;
  trustScore: number | null;
  capped: boolean;
  alignment: { matched: number; participated: number } | null;
  disputes: number;
  uniqueClaims: number;
  /** Order 5 (Contract P, F-2): a marked report's per-slot counts — claim rows and value comparisons apart; null otherwise. */
  marked: { counts: SlotRowCounts; readable: boolean; substitutedLabel: string | null } | null;
  citations: number;
  headline: string;
  isOutlier: boolean;
}

function buildRowVM(
  schema: ResultSchema,
  result: AdaptiveModelResult,
  rows: AlignedClaim[],
  trustSummary?: AdaptiveTrustSummary,
  position?: PositionPresentationState | null
): RowVM {
  const failed = !result.ok || !result.data;
  const trustEntry = trustSummary?.perModel.find((m) => m.modelId === result.modelId);
  const parseHealth = trustEntry?.parseHealth ?? deriveParseHealth(result);
  const capped = trustEntry?.capped ?? false;
  const trustScore = trustEntry ? trustEntry.trustScore : failed ? 0 : null;

  if (failed) {
    return {
      result,
      failed: true,
      parseHealth,
      trustScore,
      capped,
      alignment: null,
      disputes: 0,
      uniqueClaims: 0,
      marked: null,
      citations: 0,
      headline: "",
      isOutlier: true,
    };
  }

  // F-2: on a marked report "aligns" / "unique claims" are not computed from stored stances at all — the slot's claim
  // rows and value comparisons are counted apart from its validated readings (display only; trust is unchanged).
  const markedCounts = position ? slotRowCounts(result.modelId, rows, position.roster) : null;
  const alignment = markedCounts ? null : computeAlignment(result.modelId, rows);
  const disputes = countDisputes(result.modelId, rows, position);
  const uniqueClaims = markedCounts ? markedCounts.singleSourceClaims : countUniqueClaims(result.modelId, rows);
  const citations = countCitations(schema, result);
  const headline = headlineText(schema, result.data);
  const isOutlier = disputes > 0 || uniqueClaims > 0 || citations > 0 || capped;
  const label = position ? slotLabel(result.modelId, position.provenance, "full") : null;
  const marked = markedCounts ? { counts: markedCounts, readable: hasReadableRowBreakdown(rows), substitutedLabel: label && label.includes("(substituted") ? label : null } : null;

  return { result, failed: false, parseHealth, trustScore, capped, alignment, disputes, uniqueClaims, marked, citations, headline, isOutlier };
}

export type SortMode = "trust" | "outliers" | "response_time";

const SORT_OPTIONS: { mode: SortMode; label: string }[] = [
  { mode: "trust", label: "trust" },
  { mode: "outliers", label: "outliers first" },
  { mode: "response_time", label: "response time" },
];

function sortRows(rows: RowVM[], mode: SortMode): RowVM[] {
  const copy = [...rows];
  if (mode === "trust") {
    copy.sort((a, b) => (b.trustScore ?? 0) - (a.trustScore ?? 0));
  } else if (mode === "outliers") {
    copy.sort((a, b) => {
      if (a.isOutlier !== b.isOutlier) return a.isOutlier ? -1 : 1;
      return (b.trustScore ?? 0) - (a.trustScore ?? 0);
    });
  } else {
    copy.sort((a, b) => {
      const at = a.result.latencyMs ?? Number.POSITIVE_INFINITY;
      const bt = b.result.latencyMs ?? Number.POSITIVE_INFINITY;
      return at - bt;
    });
  }
  return copy;
}

// ─── Presentational pieces ──────────────────────────────────────────────────

/** Order 5 (Contract P, F-2): a marked slot's claim rows and value comparisons, each counted apart; neutral when the rows give no readable breakdown. */
function MarkedSlotCounts({ marked }: { marked: NonNullable<RowVM["marked"]> }) {
  if (!marked.readable) return <span className="text-xs text-slate-500 whitespace-nowrap">{ROW_COUNTS_UNAVAILABLE}</span>;
  const { claimRows, claimRowsMatching, valueComparisons } = marked.counts;
  return (
    <>
      {claimRows > 0 && (
        <span className="text-xs text-slate-600 whitespace-nowrap">
          same as the most common position on {claimRowsMatching}/{claimRows} claim row{claimRows === 1 ? "" : "s"}
        </span>
      )}
      {valueComparisons > 0 && (
        <span className="text-xs text-slate-600 whitespace-nowrap">
          gave values in {valueComparisons} value comparison{valueComparisons === 1 ? "" : "s"}
        </span>
      )}
    </>
  );
}

function RunHeaderStrip({
  schema,
  gate,
  synthesisReport,
  alignedClaimsCount,
  splitCount,
  limitedCoverageCount,
  counts,
}: {
  schema: ResultSchema;
  gate: AdaptiveGateResult;
  synthesisReport: AdaptiveSynthesisReport;
  alignedClaimsCount: number;
  splitCount: number;
  limitedCoverageCount: number;
  /** Order 5 (Contract P): a marked report's rows counted by what they are (positionPresentation.panelCounts). */
  counts?: PanelCounts | null;
}) {
  return (
    <Card className="flex items-center justify-between flex-wrap gap-3">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-600">
          {schema.id.replace(/_/g, " ")}
        </span>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${GATE_CHIP_STYLES[gateTone(pageGateValue(synthesisReport, gate.status))]}`}>
          {gateChipText(synthesisReport, pageGateValue(synthesisReport, gate.status))}
        </span>
      </div>
      {counts ? (
        <div className="text-xs text-slate-500">
          Answer certainty <span className="font-semibold text-slate-800">{Math.round(synthesisReport.runCertainty * 100)}%</span>
          {` · ${counts.rows} scored row${counts.rows === 1 ? "" : "s"} · ${counts.opposing} with recorded opposing positions · ${counts.unresolved} unresolved · ${counts.valuesDiffer} value comparison${counts.valuesDiffer === 1 ? "" : "s"} differing`}
        </div>
      ) : (
      <div className="text-xs text-slate-500">
        Answer certainty <span className="font-semibold text-slate-800">{Math.round(synthesisReport.runCertainty * 100)}%</span>
        {" · "}
        {alignedClaimsCount} aligned claim{alignedClaimsCount === 1 ? "" : "s"}
        {" · "}
        {splitCount} split
        {limitedCoverageCount > 0 && (
          <>
            {" · "}
            {limitedCoverageCount} limited coverage
          </>
        )}
      </div>
      )}
    </Card>
  );
}

function PulseCard({
  label,
  value,
  accent,
  onClick,
}: {
  label: string;
  value: number;
  accent?: "split";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-slate-300 hover:bg-slate-50/60 transition-colors"
    >
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${accent === "split" ? "text-orange-600" : "text-slate-900"}`}>{value}</p>
    </button>
  );
}

function SortControl({ sortMode, onChange }: { sortMode: SortMode; onChange: (mode: SortMode) => void }) {
  return (
    <div className="flex items-center gap-1 text-xs text-slate-500">
      <span>Sort:</span>
      {SORT_OPTIONS.map(({ mode, label }, i) => (
        <span key={mode} className="flex items-center gap-1">
          {i > 0 && <span className="text-slate-300">|</span>}
          <button
            type="button"
            onClick={() => onChange(mode)}
            className={`px-1.5 py-0.5 rounded ${sortMode === mode ? "font-semibold text-slate-900 bg-slate-100" : "hover:text-slate-700"}`}
          >
            {label}
          </button>
        </span>
      ))}
    </div>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-4 w-4 text-slate-400 transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

const CLAIM_STANCE_STYLES: Record<string, string> = {
  asserts: "bg-green-50 text-green-700 border-green-200",
  disputes: "bg-orange-50 text-orange-700 border-orange-200",
  uncertain: "bg-blue-50 text-blue-700 border-blue-200",
};

function ClaimStancePill({ stance }: { stance: string }) {
  const style = CLAIM_STANCE_STYLES[stance] || "bg-slate-50 text-slate-700 border-slate-200";
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}>{stance}</span>;
}

/** Generalizes the per-view PerModelCardGrid renderBody bodies (MetricsGridView/StepDiffView/ScenarioTreeView/...) into one schema-driven renderer, since List View's expand needs to work across all 9 schemas, not just one renderHint. */
function renderFieldValue(field: FieldSpec, value: any): React.ReactNode {
  switch (field.type) {
    case "string":
      return <p className="text-slate-800 whitespace-pre-line">{value}</p>;
    case "string[]":
      return <BulletList items={value} />;
    case "claim[]":
      return (
        <div className="space-y-2">
          {(value as any[]).map((c, i) => (
            <div key={c?.id ?? i} className="rounded-lg border border-slate-200 p-2.5">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <ClaimStancePill stance={c.stance} />
                <ConfidencePill confidence={c.confidence} />
              </div>
              <p className="text-slate-800">{c.claim}</p>
              {Array.isArray(c.camps) && c.camps.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-xs text-slate-600">
                  {c.camps.map((camp: any, ci: number) => (
                    <li key={ci}>
                      <span className="font-medium">{camp.label}:</span> {camp.position}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      );
    case "metric[]":
      return (
        <ul className="space-y-1">
          {(value as any[]).map((m, i) => (
            <li key={i} className="text-slate-800">
              <span className="font-medium">{m.label}:</span> {m.value ?? "—"} {m.unit}
              <span className="text-xs text-slate-500">
                {" "}
                · as of {m.asOf} · {m.source}
              </span>
            </li>
          ))}
        </ul>
      );
    case "step[]":
      return (
        <ol className="space-y-1.5">
          {[...(value as any[])].sort((a, b) => a.order - b.order).map((s, i) => (
            <li key={i} className="text-slate-800">
              <span className="font-medium">{s.order}.</span> {s.action}
              {s.failureMode && <span className="block text-xs text-red-600">Failure mode: {s.failureMode}</span>}
            </li>
          ))}
        </ol>
      );
    case "scenario[]":
      return (
        <div className="space-y-3">
          {(value as any[]).map((s, i) => (
            <div key={i}>
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800">{s.label}</span>
                <span className="text-xs text-slate-500">{Math.round((s.probability ?? 0) * 100)}%</span>
              </div>
              <ProbabilityBar probability={s.probability} />
              {s.narrative && <p className="text-xs text-slate-600 mt-1">{s.narrative}</p>}
            </div>
          ))}
        </div>
      );
    default:
      return null;
  }
}

function ModelAnswerBody({ schema, data }: { schema: ResultSchema; data: Record<string, any> }) {
  return (
    <div className="space-y-3 text-sm">
      {schema.fields.map((field) => {
        const value = data[field.key];
        if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return null;
        return (
          <div key={field.key}>
            <SectionLabel>{fieldLabel(field.key)}</SectionLabel>
            {renderFieldValue(field, value)}
          </div>
        );
      })}
    </div>
  );
}

function ModelRow({
  schema,
  vm,
  expanded,
  onToggle,
}: {
  schema: ResultSchema;
  vm: RowVM;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { result } = vm;

  if (vm.failed) {
    return (
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <ModelChip modelId={result.modelId} size="xs" />
          <TintBadge tone="danger">parse error · excluded</TintBadge>
          <span className="ml-auto text-xs text-slate-400">{formatLatency(result.latencyMs)}</span>
        </div>
        <p className="mt-1.5 text-sm text-red-700">
          <SlotName modelId={result.modelId} /> returned an incompatible format and was excluded from comparison.
        </p>
        {result.parseError && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-red-600">Details</summary>
            <p className="mt-0.5 text-xs text-red-600">{result.parseError}</p>
          </details>
        )}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full text-left px-4 py-3 hover:bg-slate-50/60 transition-colors"
      >
        <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap">
          <ModelChip modelId={result.modelId} size="xs" />
          <span className={`h-2 w-2 rounded-full shrink-0 ${HEALTH_DOT_COLORS[vm.parseHealth]}`} title={`Parse health: ${vm.parseHealth}`} />
          {vm.trustScore !== null && (
            <span className="text-xs text-slate-600 whitespace-nowrap">
              trust {Math.round(vm.trustScore * 100)}%
              {vm.capped && TRUST_SCORE_CAP_REASON[vm.parseHealth] && (
                <span
                  className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-100 text-[9px] font-bold text-amber-700 cursor-help align-text-top"
                  title={TRUST_SCORE_CAP_REASON[vm.parseHealth]!}
                >
                  !
                </span>
              )}
            </span>
          )}
          {vm.marked?.substitutedLabel && <span className="text-xs text-slate-500 whitespace-nowrap">{vm.marked.substitutedLabel}</span>}
          {vm.alignment && vm.alignment.participated > 0 && (
            <span className="text-xs text-slate-600 whitespace-nowrap">
              aligns {vm.alignment.matched}/{vm.alignment.participated}
            </span>
          )}
          {vm.marked && <MarkedSlotCounts marked={vm.marked} />}
          {vm.disputes > 0 && (
            <TintBadge tone="warning">
              disputes {vm.disputes} claim{vm.disputes === 1 ? "" : "s"}
            </TintBadge>
          )}
          {vm.uniqueClaims > 0 &&
            (vm.marked ? (
              <TintBadge tone="accent">
                +{vm.uniqueClaims} single-source claim{vm.uniqueClaims === 1 ? "" : "s"}
              </TintBadge>
            ) : (
              <TintBadge tone="accent">
                +{vm.uniqueClaims} unique claim{vm.uniqueClaims === 1 ? "" : "s"}
              </TintBadge>
            ))}
          {vm.citations > 0 && (
            <TintBadge tone="accent">
              {vm.citations} citation{vm.citations === 1 ? "" : "s"}
            </TintBadge>
          )}
          {vm.capped && <TintBadge tone="warning">degraded · trust capped</TintBadge>}
          <span className="ml-auto flex items-center gap-2 shrink-0">
            <span className="text-xs text-slate-400">{formatLatency(result.latencyMs)}</span>
            <Chevron expanded={expanded} />
          </span>
        </div>
        {vm.headline && <p className="mt-1.5 text-sm text-slate-700 truncate">{vm.headline}</p>}
      </button>
      {expanded && result.data && (
        <div className="px-4 pb-4 pt-3 border-t border-slate-100 bg-slate-50/50">
          <ModelAnswerBody schema={schema} data={result.data} />
        </div>
      )}
    </div>
  );
}

// ─── Root component ─────────────────────────────────────────────────────────

export interface ListViewProps {
  schema: ResultSchema;
  results: AdaptiveModelResult[];
  alignedClaims?: AlignedClaim[];
  gate: AdaptiveGateResult;
  synthesisReport: AdaptiveSynthesisReport;
  trustSummary?: AdaptiveTrustSummary;
  /** Switches the parent tab shell to Synthesis Report and scrolls to the given `data-section` anchor. */
  onNavigateToSynthesis?: (sectionId: string) => void;
}

/** Order 5 (Contract P): a marked report rendered on its own gets the same row semantics as under AdaptivePanelResponse. */
export default function ListView(props: ListViewProps) {
  return (
    <PositionPresentationBoundary report={props.synthesisReport} roster={props.results.map((r) => r.modelId)}>
      <ListViewBody {...props} />
    </PositionPresentationBoundary>
  );
}

function ListViewBody({
  schema,
  results,
  alignedClaims,
  gate,
  synthesisReport,
  trustSummary,
  onNavigateToSynthesis,
}: ListViewProps) {
  const rows = useMemo(() => alignedClaims || [], [alignedClaims]);
  const position = usePositionPresentation();
  const counts = useMemo(() => (position ? panelCounts(rows, position.roster) : null), [position, rows]);
  const [sortMode, setSortMode] = useState<SortMode>("trust");
  const [expandedModels, setExpandedModels] = useState<Set<ModelId>>(new Set());

  const consensusCount = countByStatus(rows, "consensus");
  const splitCount = countByStatus(rows, "split");
  const limitedCoverageCount = countByStatus(rows, "limited_coverage");
  const singleModelCount = countByStatus(rows, "single_source");

  const sortedVMs = useMemo(() => {
    const vms = results.map((result) => buildRowVM(schema, result, rows, trustSummary, position));
    return sortRows(vms, sortMode);
  }, [schema, results, rows, trustSummary, sortMode, position]);

  const toggle = (modelId: ModelId) => {
    setExpandedModels((prev) => {
      const next = new Set(prev);
      next.has(modelId) ? next.delete(modelId) : next.add(modelId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <RunHeaderStrip
        schema={schema}
        gate={gate}
        synthesisReport={synthesisReport}
        alignedClaimsCount={rows.length}
        splitCount={splitCount}
        limitedCoverageCount={limitedCoverageCount}
        counts={counts}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <PulseCard
          label="Consensus claims"
          value={counts ? counts.claimByStatus.consensus : consensusCount}
          onClick={() => onNavigateToSynthesis?.("agreement-disagreement-map")}
        />
        <PulseCard
          label={counts ? "Recorded opposing positions" : "Split claims"}
          value={counts ? counts.opposing : splitCount}
          accent="split"
          onClick={() => onNavigateToSynthesis?.("disagreements")}
        />
        <PulseCard
          label={counts ? "Single-source claims" : "Single-model insights"}
          value={counts ? counts.claimByStatus.single_source : singleModelCount}
          onClick={() => onNavigateToSynthesis?.("single-model-insights")}
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <span className="text-xs text-slate-500">
            {results.length} model{results.length === 1 ? "" : "s"}
          </span>
          <SortControl sortMode={sortMode} onChange={setSortMode} />
        </div>
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden divide-y divide-slate-100">
          {sortedVMs.map((vm) => (
            <ModelRow
              key={vm.result.modelId}
              schema={schema}
              vm={vm}
              expanded={expandedModels.has(vm.result.modelId)}
              onToggle={() => toggle(vm.result.modelId)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
