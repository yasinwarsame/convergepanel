"use client";

/**
 * consensus_map renderer (contested_empirical).
 * Horizontal spectrum: settled/majority claims first, contested/speculative
 * claims after. Each row is an aligned claim with per-model stance chips;
 * disputed rows expand to show competing camps (handled inside ClaimMatrix).
 */

import { ModelId } from "@/lib/types";
import { AdaptiveRendererProps } from "./types";
import { Card, SectionLabel, BulletList, FailedResultsNote, splitResults, getModelLabel } from "./shared";
import ClaimMatrix from "./ClaimMatrix";

export default function ConsensusMapView({ results, alignedClaims }: AdaptiveRendererProps) {
  const { ok, failed } = splitResults(results);
  const modelIds = results.map((r) => r.modelId) as ModelId[];
  const claims = alignedClaims || [];

  const openQuestions = Array.from(
    new Set(ok.flatMap((r) => (r.data?.openQuestions as string[] | undefined) || []))
  );

  return (
    <div className="space-y-4">
      <FailedResultsNote failed={failed} />

      <Card>
        <SectionLabel>Where the models land</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          {ok.map((r) => (
            <div key={r.modelId} className="text-sm">
              <span className="font-semibold text-slate-900">{getModelLabel(r.modelId)}: </span>
              <span className="text-slate-700">{r.data?.summary as string}</span>
            </div>
          ))}
        </div>
        <ClaimMatrix claims={claims} modelIds={modelIds} />
      </Card>

      {ok.some((r) => ((r.data?.keyMetrics as any[] | undefined)?.length ?? 0) > 0) && (
        <Card>
          <SectionLabel>Key metrics</SectionLabel>
          <div className="space-y-2">
            {ok.map((r) => {
              const metrics = (r.data?.keyMetrics as any[] | undefined) || [];
              if (metrics.length === 0) return null;
              return (
                <div key={r.modelId} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-slate-700">{getModelLabel(r.modelId)}:</span>
                  {metrics.map((m, i) => (
                    <span key={i} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                      {m.label}: {m.value ?? "—"} {m.unit} <span className="text-slate-400">({m.asOf})</span>
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {openQuestions.length > 0 && (
        <Card>
          <SectionLabel>Open questions</SectionLabel>
          <BulletList items={openQuestions} />
        </Card>
      )}
    </div>
  );
}
