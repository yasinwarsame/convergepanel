"use client";

/**
 * verdict_card renderer (factual_lookup).
 * Single card with the modal (most common) answer; outliers collapse
 * behind a "N of M models differ" affordance.
 */

import { useState } from "react";
import { AdaptiveRendererProps } from "./types";
import { Card, SectionLabel, FailedResultsNote, splitResults, getModelLabel } from "./shared";
import ModelChip from "@/components/ModelChip";

function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase().replace(/\s+/g, " ");
}

export default function VerdictCardView({ results }: AdaptiveRendererProps) {
  const { ok, failed } = splitResults(results);
  const [showOutliers, setShowOutliers] = useState(false);

  if (ok.length === 0) {
    return <FailedResultsNote failed={failed} />;
  }

  const counts = new Map<string, { display: string; modelIds: string[] }>();
  for (const r of ok) {
    const answer = (r.data?.answer as string) || "";
    const key = normalizeAnswer(answer);
    if (!counts.has(key)) counts.set(key, { display: answer, modelIds: [] });
    counts.get(key)!.modelIds.push(r.modelId);
  }

  const sorted = Array.from(counts.values()).sort((a, b) => b.modelIds.length - a.modelIds.length);
  const modal = sorted[0];
  const outlierGroups = sorted.slice(1);
  const outlierCount = ok.length - modal.modelIds.length;

  return (
    <div className="space-y-4">
      <FailedResultsNote failed={failed} />

      <Card>
        <SectionLabel>Answer</SectionLabel>
        <p className="text-lg text-slate-900 font-medium">{modal.display}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {modal.modelIds.map((id) => (
            <ModelChip key={id} modelId={id} size="xs" />
          ))}
        </div>

        {outlierCount > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => setShowOutliers((v) => !v)}
              className="text-sm font-medium text-sky-600 hover:underline"
            >
              {showOutliers ? "Hide" : "Show"} — {outlierCount} of {ok.length} model{ok.length === 1 ? "" : "s"} differ
            </button>
            {showOutliers && (
              <div className="mt-3 space-y-3">
                {outlierGroups.map((group, i) => (
                  <div key={i} className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                    <p className="text-sm text-slate-800">{group.display}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {group.modelIds.map((id) => (
                        <ModelChip key={id} modelId={id} size="xs" />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {ok.map((r) => (
          <div key={r.modelId} className="text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{getModelLabel(r.modelId)}: </span>
            {r.data?.source as string}
            {r.data?.caveat && r.data.caveat !== "none" && (
              <span className="block mt-0.5 text-slate-400">Caveat: {r.data.caveat as string}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
