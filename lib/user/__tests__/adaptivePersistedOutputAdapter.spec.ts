/**
 * Query-Routing Redesign, Phase 1 — adaptPersistedOutputToPanelPayload()
 * tests. Proves each of the 9 schemas maps to the correct named field on
 * AdaptivePanelPayload (the same shape AdaptivePanelResponse.tsx's existing,
 * unchanged renderer routing already dispatches on for a LIVE run) — i.e.
 * history restoration reaches the correct dedicated renderer without any
 * new renderer-selection logic.
 */

import { adaptPersistedOutputToPanelPayload } from "@/lib/user/adaptivePersistedOutputAdapter";
import { PersistedAdaptiveOutput, PersistedAdaptiveSchemaId, SCHEMA_ANSWER_SHAPE } from "@/lib/adaptiveSchema/persistedOutput";

const CLASSIFICATION = {
  queryType: "decision_support",
  domain: "test",
  answerShape: "decision_support_view",
  quantExpected: false,
  timeSensitivity: "low",
  userIntent: "make_decision",
  confidence: 0.9,
  riskLevel: "professional",
  evidenceRequirement: "medium",
  freshness: "timeless",
  inputType: "text",
  verificationMethod: "cross_model_consistency",
  requestedCount: null,
  requiresClarification: false,
  rationale: "test fixture",
} as PersistedAdaptiveOutput["classification"];

const META = {
  schemaVersion: 1,
  queryType: "decision_support",
  answerShape: "decision_support_view",
  dataBasis: "training_prior",
  freshness: "timeless",
  riskLevel: "professional",
  evidenceQuality: "not_applicable",
  uncertainties: [],
  blindSpots: [],
  humanReviewNeeded: false,
  generatedAt: "2026-07-28T00:00:00.000Z",
} as PersistedAdaptiveOutput["meta"];

const RESULT_FIELD_BY_SCHEMA: Record<PersistedAdaptiveSchemaId, string> = {
  ranked_enumeration: "rankedEnumeration",
  comparison_matrix: "comparisonMatrix",
  definition_explanation: "definitionExplanation",
  causal_explanation: "causalExplanation",
  checklist_taxonomy: "checklistTaxonomy",
  deep_research: "deepResearch",
  evidence_review: "evidenceReview",
  bias_blindspot_audit: "biasBlindspotAudit",
  decision_support: "decisionSupport",
};

const ALL_SCHEMA_IDS = Object.keys(SCHEMA_ANSWER_SHAPE) as PersistedAdaptiveSchemaId[];

describe("adaptPersistedOutputToPanelPayload", () => {
  it.each(ALL_SCHEMA_IDS)("%s: maps to the correct named field, matching a live run's payload shape", (schemaId) => {
    const marker = { __marker: schemaId };
    const output = {
      version: 1,
      schemaId,
      answerShape: SCHEMA_ANSWER_SHAPE[schemaId],
      classification: CLASSIFICATION,
      meta: META,
      generatedAt: META.generatedAt,
      result: marker,
    } as unknown as PersistedAdaptiveOutput;

    const payload = adaptPersistedOutputToPanelPayload(output);

    expect(payload.schemaId).toBe(schemaId);
    expect(payload.classification).toBe(CLASSIFICATION);
    // No per-model raw adaptive data is persisted — deliberate, see the
    // adapter's own module doc for why this is safe.
    expect(payload.results).toEqual([]);

    const fieldName = RESULT_FIELD_BY_SCHEMA[schemaId] as keyof typeof payload;
    expect((payload as Record<string, unknown>)[fieldName]).toBe(marker);

    // Every OTHER schema-specific field must stay unset — restoring a
    // decision_support run must never also populate rankedEnumeration, etc.
    for (const [otherSchemaId, otherFieldName] of Object.entries(RESULT_FIELD_BY_SCHEMA)) {
      if (otherSchemaId === schemaId) continue;
      expect((payload as Record<string, unknown>)[otherFieldName]).toBeUndefined();
    }
  });
});
