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
      <ul className="space-y-0.5">
        {failed.map((r) => (
          <li key={r.modelId} className="flex items-center gap-2">
            <ModelChip modelId={r.modelId} size="xs" />
            <span className="text-red-700">{r.parseError || "Response could not be parsed."}</span>
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
