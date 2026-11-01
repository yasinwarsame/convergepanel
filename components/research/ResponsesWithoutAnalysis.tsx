/**
 * P0 research-results restoration (2026-11-01).
 *
 * `ResultsDisplay` renders this when a run has model rows but nothing to put
 * in the comprehensive view: no adaptive result, no consensus report and no
 * persisted synthesis. That view needs a Unified Answer.
 *
 * Before this existed, that state showed "No unified answer yet. Run the
 * panel…", which hid saved model responses behind copy meant for a question
 * that was never run. This is what users saw for completed saved runs whose
 * analysis was never persisted.
 *
 * Contract (owner ruling, P0):
 *   - Every model response with text is shown, under the run's own recorded
 *     identity for that slot.
 *   - Unified Answer, consensus, Agreement / Disagreement Map and synthesis are
 *     each explicitly labelled unavailable. Nothing is inferred, merged or
 *     presented as a multi-model conclusion.
 *   - Models that failed are listed with their recorded status.
 *   - With no usable response at all, it says so; it never invites re-running a
 *     run that already completed.
 *   - Pure presentation: no fetch, no synthesis trigger, no model call.
 */

import type { ModelResult } from "@/lib/types";
import { runModelIdentityLabel, runModelProvenanceFromResultRow } from "@/lib/panel/runModelIdentity";

export type ResponsesWithoutAnalysisProps = {
  /** Every row of the run, in recorded order: successful and failed. */
  results: ModelResult[];
  /** Successful rows that carry non-empty text (the caller's own `okResults`). */
  responses: ModelResult[];
  /** Reads a row's text the same way the comprehensive view does. */
  textOf: (result: ModelResult) => string;
  synthesisStatus: "idle" | "loading" | "complete" | "error";
};

export const UNAVAILABLE_ANALYSIS_SECTIONS = ["Unified Answer", "Consensus", "Agreement / Disagreement Map", "Synthesis Report"] as const;

function analysisStatusLine(status: ResponsesWithoutAnalysisProps["synthesisStatus"]): string {
  if (status === "loading") return "The Unified Answer and synthesis are being generated. The model responses are shown below in the meantime.";
  if (status === "error") return "The Unified Answer and synthesis could not be generated for this run. The model responses are shown below.";
  return "The Unified Answer, consensus, Agreement / Disagreement Map and synthesis are not available for this run. The model responses are shown below exactly as they were saved.";
}

export default function ResponsesWithoutAnalysis({ results, responses, textOf, synthesisStatus }: ResponsesWithoutAnalysisProps) {
  const failed = results.filter((r) => r.status !== "ok" && r.status !== "substituted");
  const responded = results.length - failed.length;
  const label = (r: ModelResult) => runModelIdentityLabel(runModelProvenanceFromResultRow(r));

  if (responses.length === 0) {
    return (
      <section data-testid="responses-without-analysis" data-state="no-usable-response" className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-6 text-sm text-slate-700">
          <h3 className="text-sm font-semibold text-slate-900">No model returned a usable response</h3>
          <p className="mt-1">
            This run finished, but none of its {results.length} model{results.length === 1 ? "" : "s"} returned a response that can be shown, so there is no Unified Answer.
          </p>
        </div>
        {failed.length > 0 && <FailedModels failed={failed} label={label} />}
      </section>
    );
  }

  return (
    <section data-testid="responses-without-analysis" data-state={synthesisStatus === "loading" ? "analysis-pending" : "analysis-unavailable"} className="space-y-6">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-6 py-5 text-sm text-amber-900" role="status">
        <h3 className="text-sm font-semibold">
          {responded} of {results.length} models responded
        </h3>
        <p className="mt-1">{analysisStatusLine(synthesisStatus)}</p>
        <ul className="mt-3 space-y-0.5" data-testid="unavailable-analysis-sections">
          {UNAVAILABLE_ANALYSIS_SECTIONS.map((name) => (
            <li key={name}>
              {name}: {synthesisStatus === "loading" ? "pending" : "unavailable"}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <h3 className="mb-4 text-lg font-semibold text-slate-900">Model responses</h3>
        {responses.map((result) => (
          <div key={result.modelId} className="mb-5 last:mb-0" data-testid="saved-model-response" data-model-id={result.modelId}>
            {/* The run's own recorded identity for this slot, never a product label. */}
            <h4 className="mb-2 font-medium text-slate-900">{label(result)}</h4>
            <div className="whitespace-pre-wrap rounded bg-slate-50 p-4 text-sm text-slate-700">{textOf(result)}</div>
          </div>
        ))}
      </div>

      {failed.length > 0 && <FailedModels failed={failed} label={label} />}
    </section>
  );
}

function FailedModels({ failed, label }: { failed: ModelResult[]; label: (r: ModelResult) => string }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-6" data-testid="failed-models">
      <h3 className="mb-2 text-sm font-semibold text-red-900">Models that did not respond</h3>
      <ul className="space-y-1 text-sm text-red-800">
        {failed.map((r) => (
          <li key={r.modelId}>
            {label(r)}: {r.status}
          </li>
        ))}
      </ul>
    </div>
  );
}
