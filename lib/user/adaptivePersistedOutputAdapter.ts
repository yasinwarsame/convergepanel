/**
 * Query-Routing Redesign, Phase 1 — client-safe adapter from a validated
 * PersistedAdaptiveOutput (returned by GET /api/user/runs/[runId], already
 * run through parsePersistedAdaptiveOutput() server-side) to the same
 * AdaptivePanelPayload shape the LIVE /api/run-panel response's `adaptive`
 * field uses. Reusing that exact shape means history restoration goes
 * through the SAME schemaId/answerShape renderer routing
 * (AdaptivePanelResponse.tsx) as a live run — no duplicated
 * renderer-selection logic, no reclassification, no model call.
 *
 * `results: []` is deliberate, not a placeholder bug: no per-model raw
 * adaptive data is persisted in the envelope (see persistedOutput.ts's
 * module doc for why — it's already redundant with runDocument.perModel).
 * None of the 9 dedicated renderers this adapter targets read `results`
 * directly; only AdaptiveResultsView's fallback path does, and that path
 * is never reached here since the schema-specific named result below is
 * always present for a successfully-parsed envelope.
 */

import type { AdaptivePanelPayload } from "@/components/ResultsDisplay";
import type { PersistedAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";

export function adaptPersistedOutputToPanelPayload(output: PersistedAdaptiveOutput): AdaptivePanelPayload {
  const base = {
    classification: output.classification,
    schemaId: output.schemaId,
    results: [],
  };

  switch (output.schemaId) {
    case "ranked_enumeration":
      return { ...base, rankedEnumeration: output.result };
    case "comparison_matrix":
      return { ...base, comparisonMatrix: output.result };
    case "definition_explanation":
      return { ...base, definitionExplanation: output.result };
    case "causal_explanation":
      return { ...base, causalExplanation: output.result };
    case "checklist_taxonomy":
      return { ...base, checklistTaxonomy: output.result };
    case "deep_research":
      return { ...base, deepResearch: output.result };
    case "evidence_review":
      return { ...base, evidenceReview: output.result };
    case "bias_blindspot_audit":
      return { ...base, biasBlindspotAudit: output.result };
    case "decision_support":
      return { ...base, decisionSupport: output.result };
  }
}
