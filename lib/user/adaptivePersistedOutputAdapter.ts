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
import type { PersistedAdaptiveOutput, PersistedLegacyAdaptiveOutputV1 } from "@/lib/adaptiveSchema/persistedOutput";
import type { ReportStatusInput } from "@/lib/adaptiveSchema/reportStatus";

/**
 * Adaptive Synthesis Report, Phase 1 (docs/adaptive-synthesis-report-design.md
 * §4.1) — governance fields come from a SIBLING field on GET
 * /api/user/runs/[runId]'s response (`data.adaptive.humanReview`/
 * `.reviewRouting`), not from `output` itself (PersistedAdaptiveOutput has
 * no governance data — that's GovernanceRecordV1, a separate document
 * field). Optional so existing callers that haven't threaded these through
 * yet still compile — TopSummaryBar degrades to "Incomplete" when absent.
 */
export interface AdaptiveGovernanceContext {
  humanReview?: ReportStatusInput["humanReview"];
  reviewRouting?: ReportStatusInput["reviewRouting"];
}

export function adaptPersistedOutputToPanelPayload(
  output: PersistedAdaptiveOutput,
  governance?: AdaptiveGovernanceContext
): AdaptivePanelPayload {
  const base = {
    classification: output.classification,
    schemaId: output.schemaId,
    results: [],
    generatedAt: output.generatedAt,
    meta: output.meta,
    persistenceStatus: "saved" as const,
    humanReview: governance?.humanReview,
    reviewRouting: governance?.reviewRouting,
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

/**
 * Phase 2 pilot history-reload fix — the `procedural`-only sibling of
 * `adaptPersistedOutputToPanelPayload` above, for
 * `PersistedLegacyAdaptiveOutputV1` (a separate type/Firestore field, see
 * persistedOutput.ts's doc). Unlike the Milestone-2 adapter above,
 * `results` is NOT empty here — this envelope persists the real per-model
 * `AdaptiveModelResult[]` precisely so Model Responses' raw-output section
 * renders identically to a live run, not a placeholder.
 */
export function adaptPersistedLegacyOutputToPanelPayload(
  output: PersistedLegacyAdaptiveOutputV1,
  governance?: AdaptiveGovernanceContext
): AdaptivePanelPayload {
  return {
    classification: output.classification,
    schemaId: output.schemaId,
    results: output.results,
    alignedClaims: output.alignedClaims,
    gate: output.gate,
    synthesisReport: output.synthesisReport,
    trustSummary: output.trustSummary,
    generatedAt: output.generatedAt,
    persistenceStatus: "saved" as const,
    humanReview: governance?.humanReview,
    reviewRouting: governance?.reviewRouting,
  };
}
