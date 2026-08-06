/**
 * Query-Routing Redesign, Phase 1 — adaptPersistedOutputToPanelPayload()
 * tests. Proves each of the 9 schemas maps to the correct named field on
 * AdaptivePanelPayload (the same shape AdaptivePanelResponse.tsx's existing,
 * unchanged renderer routing already dispatches on for a LIVE run) — i.e.
 * history restoration reaches the correct dedicated renderer without any
 * new renderer-selection logic.
 */

import { adaptPersistedOutputToPanelPayload, adaptPersistedLegacyOutputToPanelPayload } from "@/lib/user/adaptivePersistedOutputAdapter";
import { PersistedAdaptiveOutput, PersistedAdaptiveSchemaId, PersistedLegacyAdaptiveOutputV1, SCHEMA_ANSWER_SHAPE } from "@/lib/adaptiveSchema/persistedOutput";

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

/**
 * Phase 2 pilot history-reload fix — adaptPersistedLegacyOutputToPanelPayload()
 * tests. Proves the persisted procedural fields (results/alignedClaims/
 * gate/synthesisReport/trustSummary) survive the history adapter intact,
 * landing on the SAME AdaptivePanelPayload top-level fields a live
 * procedural run's response already populates — no new renderer-selection
 * logic, no re-derivation, no JSON string anywhere in the output.
 */
describe("adaptPersistedLegacyOutputToPanelPayload", () => {
  const LEGACY_OUTPUT = {
    version: 1,
    schemaId: "procedural",
    classification: CLASSIFICATION,
    generatedAt: "2026-08-06T00:00:00.000Z",
    results: [{ modelId: "chatgpt", schemaId: "procedural", ok: true, data: { goal: "Set up a repo.", prerequisites: ["Git"], steps: [], commonFailures: [] } }],
    alignedClaims: [{ id: "c1", claimText: "Step 1", cells: [], agreementScore: 1, certaintyScore: 1, status: "consensus" }],
    gate: { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, loadBearingClaims: [] },
    synthesisReport: {
      unifiedAnswer: "Do the thing in order.",
      panelVerdict: "Panel converges.",
      gate: "pass",
      runCertainty: 0.8,
      whereModelsAgree: [],
      whereModelsDisagree: [],
      certaintyAssessment: "x",
      narrativeSections: [],
      executiveSummary: "x",
      disagreements: [],
      biasAndBlindSpots: [],
      biasEmptyReason: "insufficient_models",
      panelCoverageGaps: [],
      diagnostics: { citedClaimCount: 0, totalClaimCount: 0, evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 }, homogeneityFlag: false, meanAgreement: 0.8 },
      verdictCard: { question: "q", topConsensus: "x", consensusModelCount: 2, keyDisagreement: null, disagreementDetail: null, disagreementModelCount: 0, caveat: null, recommendedNextSteps: [] },
      degraded: false,
    },
    trustSummary: { perModel: [], overallTrust: 0.8 },
  } as unknown as PersistedLegacyAdaptiveOutputV1;

  it("maps schemaId, classification, and every claim-matrix field onto AdaptivePanelPayload's top-level fields — the SAME fields a live procedural run's response populates", () => {
    const payload = adaptPersistedLegacyOutputToPanelPayload(LEGACY_OUTPUT);

    expect(payload.schemaId).toBe("procedural");
    expect(payload.classification).toBe(CLASSIFICATION);
    expect(payload.results).toBe(LEGACY_OUTPUT.results);
    expect(payload.alignedClaims).toBe(LEGACY_OUTPUT.alignedClaims);
    expect(payload.gate).toBe(LEGACY_OUTPUT.gate);
    expect(payload.synthesisReport).toBe(LEGACY_OUTPUT.synthesisReport);
    expect(payload.trustSummary).toBe(LEGACY_OUTPUT.trustSummary);
    expect(payload.persistenceStatus).toBe("saved");
  });

  it("results are real per-model AdaptiveModelResult objects, not an empty placeholder — Model Responses' raw-output section needs real data to render on reload, unlike the 9-schema adapter above", () => {
    const payload = adaptPersistedLegacyOutputToPanelPayload(LEGACY_OUTPUT);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0].data).toEqual({ goal: "Set up a repo.", prerequisites: ["Git"], steps: [], commonFailures: [] });
  });

  it("no field on the payload ever contains a raw JSON string — every field is the already-parsed, already-typed object the live run produced", () => {
    const payload = adaptPersistedLegacyOutputToPanelPayload(LEGACY_OUTPUT);
    const serialized = JSON.stringify(payload);
    // A raw, unparsed JSON-shaped model answer would show up as a doubly-
    // escaped string fragment like `\"goal\":` inside the outer JSON —
    // this proves `results[].data` is a real object, never a string.
    expect(serialized).not.toMatch(/\\"goal\\"/);
    expect(typeof payload.results[0].data).toBe("object");
  });

  it("threads humanReview/reviewRouting through when provided, same contract as the 9-schema adapter", () => {
    const payload = adaptPersistedLegacyOutputToPanelPayload(LEGACY_OUTPUT, {
      humanReview: { status: "unreviewed" },
      reviewRouting: "not_configured",
    });
    expect(payload.humanReview).toEqual({ status: "unreviewed" });
    expect(payload.reviewRouting).toBe("not_configured");
  });

  it("leaves every Milestone-2-only field (rankedEnumeration, comparisonMatrix, etc.) unset — procedural must never populate a field only the 9 dedicated schemas use", () => {
    const payload = adaptPersistedLegacyOutputToPanelPayload(LEGACY_OUTPUT);
    for (const fieldName of Object.values(RESULT_FIELD_BY_SCHEMA)) {
      expect((payload as Record<string, unknown>)[fieldName]).toBeUndefined();
    }
  });
});
