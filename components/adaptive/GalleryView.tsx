"use client";

/**
 * gallery renderer (creative_generative).
 * Side-by-side raw outputs, minimal chrome — no analytical framing since
 * there's nothing to reconcile between models here.
 */

import { AdaptiveRendererProps } from "./types";
import { Card, FailedResultsNote, splitResults, getModelLabel } from "./shared";

export default function GalleryView({ results }: AdaptiveRendererProps) {
  const { ok, failed } = splitResults(results);

  return (
    <div className="space-y-4">
      <FailedResultsNote failed={failed} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {ok.map((r) => (
          <Card key={r.modelId}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{getModelLabel(r.modelId)}</p>
            <div className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">{r.data?.output as string}</div>
            {Array.isArray(r.data?.styleNotes) && r.data.styleNotes.length > 0 && (
              <p className="mt-3 text-xs text-slate-400 italic">{r.data.styleNotes.join(" · ")}</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
