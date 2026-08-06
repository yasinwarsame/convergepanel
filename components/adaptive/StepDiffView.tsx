"use client";

/**
 * step_diff renderer (procedural).
 * Steps aligned by order index. A step index present in every model's
 * sequence renders as a normal row; an index missing from some models
 * shows those models as absent (dash) and badges the rest as "unique".
 */

import { AdaptiveRendererProps } from "./types";
import { Card, SectionLabel, BulletList, FailedResultsNote, splitResults, getModelLabel } from "./shared";

export default function StepDiffView({ results }: AdaptiveRendererProps) {
  const { ok, failed } = splitResults(results);

  const maxSteps = Math.max(0, ...ok.map((r) => ((r.data?.steps as any[] | undefined)?.length ?? 0)));
  const rows = Array.from({ length: maxSteps }, (_, i) => i + 1);

  return (
    <div className="space-y-4">
      <FailedResultsNote failed={failed} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {ok.map((r) => (
          <div key={r.modelId} className="text-sm">
            <span className="font-semibold text-slate-900">{getModelLabel(r.modelId)}: </span>
            <span className="text-slate-700">{r.data?.goal as string}</span>
          </div>
        ))}
      </div>

      {/* Adaptive Synthesis Report, Phase 2 pilot — prerequisites was
          already collected by proceduralFields but never rendered anywhere
          in this view. Merged across models (near-duplicate items are
          common when each model restates the same prerequisite) rather
          than shown per-model, since a prerequisite is either needed or
          not, unlike a step's ordered content. */}
      {ok.some((r) => ((r.data?.prerequisites as string[] | undefined)?.length ?? 0) > 0) && (
        <Card>
          <SectionLabel>Prerequisites</SectionLabel>
          <BulletList items={Array.from(new Set(ok.flatMap((r) => (r.data?.prerequisites as string[] | undefined) || [])))} />
        </Card>
      )}

      <Card>
        <SectionLabel>Steps</SectionLabel>
        <div className="space-y-2">
          {rows.map((order) => {
            const present = ok.filter((r) => {
              const step = (r.data?.steps as any[] | undefined)?.find((s) => s.order === order);
              return !!step;
            });
            const isUniversal = present.length === ok.length;
            return (
              <div key={order} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white text-xs font-semibold">
                    {order}
                  </span>
                  {!isUniversal && (
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                      Only in {present.length} of {ok.length} models
                    </span>
                  )}
                </div>
                <div className="space-y-1 pl-7">
                  {ok.map((r) => {
                    const step = (r.data?.steps as any[] | undefined)?.find((s) => s.order === order);
                    if (!step) {
                      return (
                        <p key={r.modelId} className="text-xs text-slate-300">
                          {getModelLabel(r.modelId)}: —
                        </p>
                      );
                    }
                    return (
                      <p key={r.modelId} className="text-sm text-slate-800">
                        <span className="font-medium text-slate-600">{getModelLabel(r.modelId)}: </span>
                        {step.action}
                        {step.failureMode && (
                          <span className="block text-xs text-red-600 mt-0.5">Failure mode: {step.failureMode}</span>
                        )}
                      </p>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {ok.some((r) => ((r.data?.commonFailures as string[] | undefined)?.length ?? 0) > 0) && (
        <Card>
          <SectionLabel>Common failures</SectionLabel>
          <BulletList
            items={Array.from(new Set(ok.flatMap((r) => (r.data?.commonFailures as string[] | undefined) || [])))}
          />
        </Card>
      )}
    </div>
  );
}
