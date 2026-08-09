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
          <div className="mb-2 flex items-center justify-between gap-2">
            <SectionLabel>Metrics</SectionLabel>
            {modelIds.length > 0 && (
              <span className="text-[11px] text-slate-400 md:hidden">Scroll to see all models &rarr;</span>
            )}
          </div>
          {/* Contained horizontal scroll with a CSS-only right-edge scroll
              shadow (no JS overflow measurement — this repo's adaptive
              components render via renderToStaticMarkup/server-rendering,
              with no real browser layout available at test time, so a
              runtime-state affordance would be untestable here; a pure-CSS
              approach is also the naturally correct choice since it derives
              directly from actual scroll position, never a guess). Two
              background layers on the scroll container itself: a "cover"
              gradient anchored to the CONTENT's right edge that scrolls
              WITH the table (background-attachment: local) — once fully
              scrolled, this cover sits flush with the visible edge and no
              longer masks anything; and a shadow "indicator" pinned to the
              VIEWPORT's right edge (background-attachment: scroll) that the
              cover only reveals while there's more content to the right.
              Same role/aria-label/tabIndex/focus-ring contract as
              ComparisonMatrixView's equivalent scroll region. */}
          <div
            role="region"
            aria-label="Metrics table, scroll horizontally to see all models"
            tabIndex={0}
            className="overflow-x-auto rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
            style={{
              backgroundImage:
                "linear-gradient(to left, white 30%, rgba(255,255,255,0)), radial-gradient(farthest-side at 100% 50%, rgba(15,23,42,0.18), rgba(15,23,42,0))",
              backgroundRepeat: "no-repeat",
              backgroundSize: "40px 100%, 14px 100%",
              backgroundPosition: "100% 0, 100% 0",
              backgroundAttachment: "local, scroll",
            }}
          >
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-200">
                  <th scope="col" className="text-left font-semibold text-slate-600 py-2 pr-4">
                    Metric
                  </th>
                  {modelIds.map((modelId) => (
                    <th
                      key={modelId}
                      scope="col"
                      className="text-left font-semibold text-slate-600 py-2 px-2 whitespace-nowrap"
                    >
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
                      <th scope="row" className="py-2.5 pr-4 text-left text-slate-900 font-medium">
                        {labelDisplay.get(key)}
                      </th>
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
