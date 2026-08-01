"use client";

/**
 * Shared building blocks for adaptive renderers.
 * Matches the existing hardcoded-Tailwind legacy style used by
 * ResultsDisplay.tsx / app/page.tsx (slate palette, rounded-xl cards) —
 * this surface predates the cp-* token system, see CLAUDE.md.
 */

import { ModelId } from "@/lib/types";
import { AdaptiveModelResult, AdaptiveStakes } from "@/lib/adaptiveSchema/types";
import { getPanelModelConfig, getModelDisplayNameSafe } from "@/lib/panelModels";
import ModelChip from "@/components/ModelChip";

export function getModelLabel(modelId: ModelId | string): string {
  return getModelDisplayNameSafe(modelId);
}

export function splitResults(results: AdaptiveModelResult[]): {
  ok: AdaptiveModelResult[];
  failed: AdaptiveModelResult[];
} {
  return {
    ok: results.filter((r) => r.ok && r.data),
    failed: results.filter((r) => !r.ok || !r.data),
  };
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-200 bg-white p-4 ${className}`}>{children}</div>;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{children}</h4>;
}

export function BulletList({ items }: { items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <ul className="list-disc list-outside pl-5 space-y-1 text-sm leading-relaxed text-slate-800">
      {items.map((item, idx) => (
        <li key={idx}>{item}</li>
      ))}
    </ul>
  );
}

/** Failed / parseError models: rendered as a small non-blocking notice, never crashes the comparison. */
export function FailedResultsNote({ failed }: { failed: AdaptiveModelResult[] }) {
  if (failed.length === 0) return null;
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <p className="font-semibold mb-1">
        {failed.length} model{failed.length === 1 ? "" : "s"} couldn&apos;t be compared
      </p>
      <ul className="space-y-1">
        {failed.map((r) => (
          <li key={r.modelId} className="flex items-start gap-2">
            <ModelChip modelId={r.modelId} size="xs" />
            <div className="text-red-700">
              <p>{getModelLabel(r.modelId)} returned an incompatible format and was excluded from comparison.</p>
              {r.parseError && (
                <details className="mt-0.5">
                  <summary className="cursor-pointer text-xs text-red-600">Details</summary>
                  <p className="mt-0.5 text-xs text-red-600">{r.parseError}</p>
                </details>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Grid of one card per successful model — the fallback layout for scalar/string[] fields with no natural matrix. */
export function PerModelCardGrid({
  results,
  renderBody,
}: {
  results: AdaptiveModelResult[];
  renderBody: (data: Record<string, any>, modelId: ModelId) => React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {results.map((r) => (
        <Card key={r.modelId}>
          <div className="mb-2">
            <ModelChip modelId={r.modelId} size="xs" />
          </div>
          {r.data ? renderBody(r.data, r.modelId) : null}
        </Card>
      ))}
    </div>
  );
}

const CONFIDENCE_STYLES: Record<string, string> = {
  settled: "bg-green-50 text-green-800 border-green-200",
  majority_view: "bg-green-50 text-green-700 border-green-200",
  contested: "bg-orange-50 text-orange-800 border-orange-200",
  speculative: "bg-blue-50 text-blue-700 border-blue-200",
};

export function ConfidencePill({ confidence }: { confidence: string }) {
  const style = CONFIDENCE_STYLES[confidence] || "bg-slate-50 text-slate-700 border-slate-200";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}>
      {confidence.replace("_", " ")}
    </span>
  );
}

export function ProbabilityBar({ probability, colorClass = "bg-sky-500" }: { probability: number; colorClass?: string }) {
  const pct = Math.max(0, Math.min(1, probability)) * 100;
  return (
    <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
      <div className={`h-full ${colorClass}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

const STAKES_LABELS: Record<AdaptiveStakes, string> = {
  low: "Low stakes",
  important: "Important",
  "decision-critical": "Decision-critical",
};

const STAKES_STYLES: Record<AdaptiveStakes, { bg: string; text: string; dot: string }> = {
  low: { bg: "bg-slate-100", text: "text-slate-600", dot: "bg-slate-400" },
  important: { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-400" },
  "decision-critical": { bg: "bg-rose-50", text: "text-rose-700", dot: "bg-rose-500" },
};

const STAKES_TOOLTIPS: Record<AdaptiveStakes, string> = {
  "decision-critical": "May affect action, compliance, safety, or strategic decisions",
  important: "Materially shapes interpretation or follow-up",
  low: "Supporting context or low-impact observation",
};

export type BadgeTone = "warning" | "accent" | "danger";

const BADGE_TONE_STYLES: Record<BadgeTone, string> = {
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  accent: "bg-sky-50 text-sky-700 border-sky-200",
  danger: "bg-red-50 text-red-700 border-red-200",
};

/** Generic tinted pill — same visual language as StakesBadge/ConfidencePill, for any deviation callout on a row (e.g. List View's per-model differentiator badges). */
export function TintBadge({ tone, children, title }: { tone: BadgeTone; children: React.ReactNode; title?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_TONE_STYLES[tone]}`}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * Milestone 2 UI consistency cleanup — one shared phrasing for every
 * "N of M models did X" badge across the 9 adaptive renderers. Prevents the
 * wording drift a static review found (some renderers said "models agree",
 * others just "models", others a bare "N/M") by making the mode explicit
 * and matching the ACTUAL metric each schema computes:
 *   - "covered": how many models raised/mentioned this item at all (the vast
 *     majority of Milestone 2 coverage counts — none of these schemas score
 *     genuine stance agreement, that's AlignedClaim's job).
 *   - "agreed": reserved for a schema that has an actual cross-model VALUE
 *     agreement signal (e.g. comparison_matrix's cell `agreement` enum,
 *     which is consensus/majority/split, not mere mention coverage).
 *   - "assessed": how many models populated a specific cross-referenced cell
 *     (comparison_matrix's cells, decision_support's assessments) — distinct
 *     from axis-level "covered".
 *   - "converged": recommendation-level convergence (decision_support's
 *     recommendation support count) — never a certainty score by itself,
 *     callers append that caveat separately.
 */
export type ModelCoverageMode = "covered" | "agreed" | "assessed" | "converged";

const MODEL_COVERAGE_VERB: Record<ModelCoverageMode, string> = {
  covered: "covered this",
  agreed: "agreed",
  assessed: "assessed this",
  converged: "converged on this",
};

export function formatModelCoverage({ covered, total, mode }: { covered: number; total: number; mode: ModelCoverageMode }): string {
  return `${covered} of ${total} models ${MODEL_COVERAGE_VERB[mode]}`;
}

/**
 * Milestone 2 UI consistency cleanup — the three-state empty-result
 * distinction `bias_blindspot_audit`/`decision_support` introduced (after a
 * real bug was caught during the former's build), backported to every
 * renderer. `"no_models"` means the run had nothing to work with at all
 * (every connector failed/timed out); `"models_no_usable_output"` means
 * models responded but no usable structured result survived validation —
 * a materially different, more actionable distinction for debugging
 * connector outages vs. validator failures.
 */
export type RendererEmptyState = "no_models" | "models_no_usable_output" | "has_content";

export function classifyRendererEmptyState(totalModels: number, hasContent: boolean): RendererEmptyState {
  if (totalModels === 0) return "no_models";
  if (!hasContent) return "models_no_usable_output";
  return "has_content";
}

/** Generic copy for `"no_models"` — always the same across every renderer, since the run-level cause is identical regardless of schema. `"models_no_usable_output"` prefers a schema-specific message (every renderer already has one); the generic fallback only covers a renderer that doesn't. */
export function EmptyStateCard({
  state,
  schemaSpecificMessage,
}: {
  state: Exclude<RendererEmptyState, "has_content">;
  schemaSpecificMessage?: string;
}) {
  const message =
    state === "no_models"
      ? "No model responses were available for this run."
      : schemaSpecificMessage || "Models responded, but no usable structured result could be produced.";
  return (
    <Card>
      <p className="text-sm text-slate-500 italic">{message}</p>
    </Card>
  );
}

/** Mirrors the legacy SeverityBadge (PanelSynthesisView.tsx) — same tiers, same tooltip copy. */
export function StakesBadge({ stakes }: { stakes: AdaptiveStakes }) {
  const style = STAKES_STYLES[stakes] ?? STAKES_STYLES.low;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${style.bg} ${style.text}`}
      title={STAKES_TOOLTIPS[stakes]}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {STAKES_LABELS[stakes]}
    </span>
  );
}
