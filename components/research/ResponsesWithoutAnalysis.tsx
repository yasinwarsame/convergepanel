/**
 * P0 research-results restoration (2026-11-01).
 *
 * `ResultsDisplay` renders this when a run has model rows but nothing to put in the comprehensive view: no adaptive
 * result, no consensus report and no persisted synthesis. That view needs a Unified Answer.
 *
 * Before this existed, that state showed "No unified answer yet. Run the panel…". It hid saved model responses behind
 * copy meant for a question that was never run, and that is what users saw for completed saved runs whose analysis was
 * never persisted.
 *
 * Contract (owner ruling, P0):
 *   - Every model response with text is shown, under the run's own recorded identity for that slot.
 *   - Unified Answer, consensus, Agreement / Disagreement Map and synthesis are each labelled explicitly as unavailable,
 *     not available yet, or pending. Nothing is inferred, merged or presented as a multi-model conclusion.
 *   - Models that failed, or that succeeded with no text, are listed with their recorded status. The count in the
 *     heading is exactly the number of responses shown.
 *   - With no usable response at all it says so, and never invites re-running a run that already completed.
 *   - Pure presentation: no fetch, no synthesis trigger, no model call. The governance banner is the caller's.
 */

import type { ModelResult } from "@/lib/types";
import { runModelIdentityLabel, runModelProvenanceFromResultRow } from "@/lib/panel/runModelIdentity";
import { parseStructuredResponse } from "@/lib/research/savedResponseDisplay";
import StructuredResearchResult from "@/components/workspace/projects/StructuredResearchResult";

export type ResponsesWithoutAnalysisProps = {
  /** Every row of the run, in recorded order: successful and failed. */
  results: ModelResult[];
  /** Successful rows that carry non-empty text (the caller's own `okResults`). */
  responses: ModelResult[];
  /** Reads a row's text the same way the comprehensive view does. */
  textOf: (result: ModelResult) => string;
  synthesisStatus: "idle" | "loading" | "complete" | "error";
  /**
   * The caller's synthesis policy (`allowSynthesisGeneration`). True only on the live composer, where the renderer
   * itself may still start the synthesis. False on durable reads, which never generate one.
   */
  analysisMayStillBeGenerated?: boolean;
  orgGovernanceStatus?: "approved" | "needs_review" | "blocked" | null;
};

export const UNAVAILABLE_ANALYSIS_SECTIONS = ["Unified Answer", "Consensus", "Agreement / Disagreement Map", "Synthesis Report"] as const;

type AnalysisState = "pending" | "not_yet" | "failed" | "unavailable";

function analysisState(status: ResponsesWithoutAnalysisProps["synthesisStatus"], mayStillBeGenerated: boolean): AnalysisState {
  if (status === "loading") return "pending";
  if (status === "error") return "failed";
  return mayStillBeGenerated ? "not_yet" : "unavailable";
}

const STATE_LINE: Record<AnalysisState, string> = {
  pending: "The Unified Answer and synthesis are being generated. The model responses are shown below in the meantime.",
  not_yet: "The Unified Answer, consensus, Agreement / Disagreement Map and synthesis have not been generated yet. The model responses are shown below.",
  failed: "The Unified Answer and synthesis could not be generated for this run. The model responses are shown below.",
  unavailable: "The Unified Answer, consensus, Agreement / Disagreement Map and synthesis are not available for this run. The model responses are shown below exactly as they were saved.",
};

const SECTION_LABEL: Record<AnalysisState, string> = { pending: "pending", not_yet: "not available yet", failed: "unavailable", unavailable: "unavailable" };

const ORG_STATUS_LINE: Record<"needs_review" | "blocked", string> = {
  needs_review: "Governance status: needs review before acting on this result.",
  blocked: "Governance status: blocked by your organization's governance policy.",
};

export default function ResponsesWithoutAnalysis({ results, responses, textOf, synthesisStatus, analysisMayStillBeGenerated = false, orgGovernanceStatus = null }: ResponsesWithoutAnalysisProps) {
  const shown = new Set(responses);
  // Every row that is not displayed is accounted for: a failure, or a success that carried no text.
  const notShown = results.filter((r) => !shown.has(r));
  const label = (r: ModelResult) => runModelIdentityLabel(runModelProvenanceFromResultRow(r));
  const state = analysisState(synthesisStatus, analysisMayStillBeGenerated);
  const orgLine = orgGovernanceStatus === "needs_review" || orgGovernanceStatus === "blocked" ? ORG_STATUS_LINE[orgGovernanceStatus] : null;

  if (responses.length === 0) {
    return (
      <section data-testid="responses-without-analysis" data-state="no-usable-response" className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-6 text-sm text-slate-700">
          <h3 className="text-sm font-semibold text-slate-900">No model returned a usable response</h3>
          <p className="mt-1">
            This run finished, but none of its {results.length} model{results.length === 1 ? "" : "s"} returned a response that can be shown, so there is no Unified Answer.
          </p>
          {orgLine && <p className="mt-2 font-medium text-slate-900" data-testid="org-governance-status">{orgLine}</p>}
        </div>
        {notShown.length > 0 && <ModelsWithoutResponse rows={notShown} label={label} />}
      </section>
    );
  }

  return (
    <section data-testid="responses-without-analysis" data-state={`analysis-${state === "not_yet" ? "not-yet" : state}`} className="space-y-6">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-6 py-5 text-sm text-amber-900" role="status">
        <h3 className="text-sm font-semibold">
          {responses.length} of {results.length} models returned a response
        </h3>
        <p className="mt-1">{STATE_LINE[state]}</p>
        {orgLine && <p className="mt-2 font-medium" data-testid="org-governance-status">{orgLine}</p>}
        <ul className="mt-3 space-y-0.5" data-testid="unavailable-analysis-sections">
          {UNAVAILABLE_ANALYSIS_SECTIONS.map((name) => (
            <li key={name}>
              {name}: {SECTION_LABEL[state]}
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
            <SavedResponseBody text={textOf(result)} />
          </div>
        ))}
      </div>

      {notShown.length > 0 && <ModelsWithoutResponse rows={notShown} label={label} />}
    </section>
  );
}

/**
 * Team presentation fix (2026-11-02): a saved response that is structured JSON (bare or fenced) is shown as readable
 * sections by the same renderer the Team composer uses, with every field kept. The exact saved text stays one click
 * away. Anything that does not parse within bounds is shown as saved text, as before.
 */
function SavedResponseBody({ text }: { text: string }) {
  const structured = parseStructuredResponse(text);
  if (structured === null) return <div className="whitespace-pre-wrap rounded bg-slate-50 p-4 text-sm text-slate-700" data-testid="saved-response-text">{text}</div>;
  return (
    <div className="space-y-2">
      <div className="rounded bg-slate-50 p-4" data-testid="saved-response-structured">
        <StructuredResearchResult value={structured} />
      </div>
      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer">Show the saved text exactly as returned</summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 text-xs text-slate-700">{text}</pre>
      </details>
    </div>
  );
}

/** A non-responding slot, described from its recorded status. */
export function notRespondedText(status: unknown): string {
  if (status === "timeout") return "did not respond in time";
  if (status === "refused") return "declined to answer";
  if (status === "rate_limited") return "was rate-limited by its provider";
  return "did not respond";
}

/** Rows not displayed as a response: their recorded status, or "returned no text" for a success with empty text. */
function ModelsWithoutResponse({ rows, label }: { rows: ModelResult[]; label: (r: ModelResult) => string }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-6" data-testid="failed-models">
      <h3 className="mb-2 text-sm font-semibold text-red-900">Models without a response</h3>
      <ul className="space-y-1 text-sm text-red-800">
        {rows.map((r) => (
          <li key={r.modelId}>
            {label(r)}: {r.status === "ok" || r.status === "substituted" ? "returned no text" : notRespondedText(r.status)}
          </li>
        ))}
      </ul>
    </div>
  );
}
