"use client";

/**
 * scenario_tree renderer (forecast_speculative).
 * Scenarios matched across models by normalized label, sorted by average
 * probability. Each scenario shows a probability bar per model so the
 * spread in how likely each model thinks it is is visible at a glance.
 */

import { ModelId } from "@/lib/types";
import { AdaptiveRendererProps } from "./types";
import { Card, SectionLabel, BulletList, FailedResultsNote, ProbabilityBar, splitResults, getModelLabel } from "./shared";

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

const BAR_COLORS = ["bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500", "bg-indigo-500"];

export default function ScenarioTreeView({ results }: AdaptiveRendererProps) {
  const { ok, failed } = splitResults(results);
  const modelIds = results.map((r) => r.modelId) as ModelId[];
  const colorByModel = new Map<ModelId, string>(modelIds.map((id, i) => [id, BAR_COLORS[i % BAR_COLORS.length]]));

  const groupOrder: string[] = [];
  const groupLabel = new Map<string, string>();
  const groupByModel = new Map<string, Map<ModelId, any>>();

  for (const r of ok) {
    const scenarios = (r.data?.scenarios as any[] | undefined) || [];
    for (const s of scenarios) {
      const key = normalizeLabel(s.label);
      if (!groupLabel.has(key)) {
        groupOrder.push(key);
        groupLabel.set(key, s.label);
        groupByModel.set(key, new Map());
      }
      groupByModel.get(key)!.set(r.modelId, s);
    }
  }

  const sortedKeys = [...groupOrder].sort((a, b) => {
    const avg = (key: string) => {
      const m = groupByModel.get(key)!;
      const values = Array.from(m.values()).map((s) => s.probability as number);
      return values.reduce((sum, v) => sum + v, 0) / values.length;
    };
    return avg(b) - avg(a);
  });

  return (
    <div className="space-y-4">
      <FailedResultsNote failed={failed} />

      <Card>
        <SectionLabel>Scenarios</SectionLabel>
        <div className="space-y-4">
          {sortedKeys.map((key) => {
            const byModel = groupByModel.get(key)!;
            const representative = byModel.values().next().value;
            return (
              <div key={key} className="rounded-lg border border-slate-200 p-3">
                <p className="font-semibold text-slate-900 mb-2">{groupLabel.get(key)}</p>
                <div className="space-y-1.5 mb-2">
                  {modelIds.map((modelId) => {
                    const s = byModel.get(modelId);
                    return (
                      <div key={modelId} className="flex items-center gap-2 text-xs">
                        <span className="w-24 shrink-0 text-slate-500">{getModelLabel(modelId)}</span>
                        {s ? (
                          <>
                            <div className="flex-1">
                              <ProbabilityBar probability={s.probability} colorClass={colorByModel.get(modelId)} />
                            </div>
                            <span className="w-10 shrink-0 text-right text-slate-700 font-medium">
                              {Math.round(s.probability * 100)}%
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-300">not raised</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-sm text-slate-700">{representative?.narrative}</p>
                {Array.isArray(representative?.leadingIndicators) && representative.leadingIndicators.length > 0 && (
                  <p className="mt-1 text-xs text-slate-500">
                    Watch for: {representative.leadingIndicators.join(", ")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {ok.some((r) => ((r.data?.baseRates as string[] | undefined)?.length ?? 0) > 0) && (
        <Card>
          <SectionLabel>Base rates</SectionLabel>
          <BulletList items={Array.from(new Set(ok.flatMap((r) => (r.data?.baseRates as string[] | undefined) || [])))} />
        </Card>
      )}

      {ok.some((r) => ((r.data?.keyUncertainties as string[] | undefined)?.length ?? 0) > 0) && (
        <Card>
          <SectionLabel>Key uncertainties</SectionLabel>
          <BulletList
            items={Array.from(new Set(ok.flatMap((r) => (r.data?.keyUncertainties as string[] | undefined) || [])))}
          />
        </Card>
      )}
    </div>
  );
}
