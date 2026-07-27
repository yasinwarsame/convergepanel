"use client";

/**
 * metrics_grid renderer (financial_valuation).
 * Comparison centerpiece: a table with rows = metric labels, columns =
 * models, cells = value + unit. Min/max per row are highlighted so numeric
 * divergence between models is immediately visible.
 */

import { ModelId } from "@/lib/types";
import { AdaptiveRendererProps } from "./types";
import { Card, SectionLabel, BulletList, FailedResultsNote, PerModelCardGrid, splitResults, getModelLabel } from "./shared";

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

export default function MetricsGridView({ results }: AdaptiveRendererProps) {
  const { ok, failed } = splitResults(results);
  const modelIds = results.map((r) => r.modelId) as ModelId[];

  // Union of metric labels (matched case-insensitively), in first-seen order.
  const labelOrder: string[] = [];
  const labelDisplay = new Map<string, string>();
  for (const r of ok) {
    const metrics = (r.data?.metrics as any[] | undefined) || [];
    for (const m of metrics) {
      const key = normalizeLabel(m.label);
      if (!labelDisplay.has(key)) {
        labelOrder.push(key);
        labelDisplay.set(key, m.label);
      }
    }
  }

  const cellByModelAndLabel = new Map<string, Map<ModelId, { value: number | null; unit: string; asOf: string }>>();
  for (const r of ok) {
    const metrics = (r.data?.metrics as any[] | undefined) || [];
    for (const m of metrics) {
      const key = normalizeLabel(m.label);
      if (!cellByModelAndLabel.has(key)) cellByModelAndLabel.set(key, new Map());
      cellByModelAndLabel.get(key)!.set(r.modelId, { value: m.value, unit: m.unit, asOf: m.asOf });
    }
  }

  return (
    <div className="space-y-4">
      <FailedResultsNote failed={failed} />

      {labelOrder.length > 0 && (
        <Card>
          <SectionLabel>Metrics</SectionLabel>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left font-semibold text-slate-600 py-2 pr-4">Metric</th>
                  {modelIds.map((modelId) => (
                    <th key={modelId} className="text-left font-semibold text-slate-600 py-2 px-2 whitespace-nowrap">
                      {getModelLabel(modelId)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {labelOrder.map((key) => {
                  const row = cellByModelAndLabel.get(key)!;
                  const numericValues = modelIds
                    .map((id) => row.get(id)?.value)
                    .filter((v): v is number => typeof v === "number");
                  const min = numericValues.length > 1 ? Math.min(...numericValues) : null;
                  const max = numericValues.length > 1 ? Math.max(...numericValues) : null;

                  return (
                    <tr key={key} className="border-b border-slate-100">
                      <td className="py-2.5 pr-4 text-slate-900 font-medium">{labelDisplay.get(key)}</td>
                      {modelIds.map((modelId) => {
                        const cell = row.get(modelId);
                        if (!cell) {
                          return (
                            <td key={modelId} className="py-2.5 px-2 text-slate-300">
                              —
                            </td>
                          );
                        }
                        const isMin = min !== null && cell.value === min && min !== max;
                        const isMax = max !== null && cell.value === max && min !== max;
                        const highlight = isMax
                          ? "bg-green-50 text-green-800"
                          : isMin
                          ? "bg-orange-50 text-orange-800"
                          : "text-slate-800";
                        return (
                          <td key={modelId} className={`py-2.5 px-2 rounded ${highlight}`}>
                            {cell.value ?? "—"} {cell.unit}
                            <span className="block text-xs text-slate-400">{cell.asOf}</span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <PerModelCardGrid
        results={ok}
        renderBody={(data) => (
          <div className="space-y-2 text-sm">
            <p className="text-slate-800">{data.thesis}</p>
            {data.bullCase && (
              <p>
                <span className="font-semibold text-green-700">Bull case: </span>
                <span className="text-slate-700">{data.bullCase}</span>
              </p>
            )}
            {data.bearCase && (
              <p>
                <span className="font-semibold text-orange-700">Bear case: </span>
                <span className="text-slate-700">{data.bearCase}</span>
              </p>
            )}
            {Array.isArray(data.keyAssumptions) && data.keyAssumptions.length > 0 && (
              <div>
                <SectionLabel>Key assumptions</SectionLabel>
                <BulletList items={data.keyAssumptions} />
              </div>
            )}
            {Array.isArray(data.riskFactors) && data.riskFactors.length > 0 && (
              <div>
                <SectionLabel>Risk factors</SectionLabel>
                <BulletList items={data.riskFactors} />
              </div>
            )}
          </div>
        )}
      />
    </div>
  );
}
