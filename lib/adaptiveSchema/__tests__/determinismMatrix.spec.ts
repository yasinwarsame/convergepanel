/**
 * Milestone-2 Producer Canonicalization, Step 13 — end-to-end determinism
 * matrix across every active Milestone-2 schema, using the REAL producer
 * functions (not hand-built fixtures) with per-model input deliberately
 * shaped to leave every conditionally-spread optional field unset — the
 * exact worst case that used to produce an explicit-undefined own-property
 * before the producer canonicalization fix.
 *
 * For each schema: build `milestone2.result` via the real producer, freeze
 * it into a minimal `AdaptiveResearchExportV1` record, render the JSON
 * export at "creation time" (record as originally built, still carrying any
 * genuine `undefined`s in memory), then render it again after passing the
 * record through the REAL `sanitizeForFirestore()` (simulating exactly what
 * a Firestore write+read cycle does before a JSON export is regenerated).
 * Byte-for-byte (`Buffer.compare`) and SHA-256 equality between the two
 * renders is the actual product guarantee (`hashReproducible: true`) this
 * whole effort exists to restore.
 */

import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { renderAdaptiveResearchJsonV1 } from "@/lib/adaptiveSchema/jsonExport";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { ModelId } from "@/lib/types";
import { PersistedAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";

import { buildComparisonMatrixResult } from "@/lib/adaptiveSchema/comparisonAlignment";
import { buildRankedEnumerationResult } from "@/lib/adaptiveSchema/enumAlignment";
import { buildDefinitionExplanationResult, DefinitionExplanationFields } from "@/lib/adaptiveSchema/definitionAlignment";
import { buildCausalExplanationResult, CausalExplanationFields } from "@/lib/adaptiveSchema/causalAlignment";
import { buildChecklistTaxonomyResult } from "@/lib/adaptiveSchema/checklistAlignment";
import { buildEvidenceReviewResult, EvidenceReviewFields } from "@/lib/adaptiveSchema/evidenceReviewAlignment";
import { buildDecisionSupportResult, DecisionSupportFields } from "@/lib/adaptiveSchema/decisionSupportAlignment";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn().mockResolvedValue({ modelId: "gemini", status: "ok", rawText: JSON.stringify({ gaps: [], biasAndBlindSpots: [] }), latencyMs: 5 }),
}));

function baseRecord(schemaId: PersistedAdaptiveSchemaId, result: unknown): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: `exp-matrix-${schemaId}`,
    runId: `run-matrix-${schemaId}`,
    schemaId,
    schemaFamily: "milestone2",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "uid-matrix",
    format: "json",
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "milestone2", kind: "unreviewed", isOwnerOverride: false },
    reportSnapshot: {
      question: "Determinism matrix fixture question.",
      models: [{ modelId: "chatgpt" as ModelId, ok: true }, { modelId: "claude" as ModelId, ok: true }],
      reportTypeLabel: "Determinism Matrix Fixture",
      consensusLevel: "moderate",
      sourceGroundingLevel: "unscored",
      reportGeneratedAt: "2026-01-01T00:00:00.000Z",
      milestone2: {
        schemaId,
        result,
        meta: {} as any,
      },
    },
    exportMetadata: {
      exportId: `exp-matrix-${schemaId}`,
      runId: `run-matrix-${schemaId}`,
      schemaVersion: 1,
      exportedSections: ["reportSnapshot.milestone2"],
      createdAt: "2026-01-01T00:00:00.000Z",
      requestingUser: "uid-matrix",
      finalReportVersion: 1,
    },
  };
}

/** Asserts creation-time and post-Firestore-round-trip JSON renders are byte-identical and SHA-256-identical — the core `hashReproducible: true` guarantee. */
function assertDeterministic(record: AdaptiveResearchExportV1) {
  const creation = renderAdaptiveResearchJsonV1(record);
  const roundTripped = sanitizeForFirestore(record) as AdaptiveResearchExportV1;
  const regenerated = renderAdaptiveResearchJsonV1(roundTripped);
  expect(Buffer.compare(creation.bytes, regenerated.bytes)).toBe(0);
  expect(creation.sha256).toBe(regenerated.sha256);
}

describe("Determinism matrix — Milestone-2 schemas, real producers (Step 13)", () => {
  it("comparison_matrix: split cells (no consensusValue/verdictTally/rationale/sources) round-trip deterministically", () => {
    const result = buildComparisonMatrixResult([
      { modelId: "chatgpt" as ModelId, cells: [{ subject: "X", attribute: "Verdict", value: "Best overall choice" }] },
      { modelId: "claude" as ModelId, cells: [{ subject: "X", attribute: "Verdict", value: "Not recommended at all" }] },
    ]);
    assertDeterministic(baseRecord("comparison_matrix", result));
  });

  it("ranked_enumeration: single-model items (no category/rankVariance/rationale/sources/shortfallNote) round-trip deterministically", () => {
    const result = buildRankedEnumerationResult(
      [{ modelId: "chatgpt" as ModelId, items: [{ id: "x", label: "X", rank: 1 }] }],
      null
    );
    assertDeterministic(baseRecord("ranked_enumeration", result));
  });

  it("checklist_taxonomy: plain items (no severity/likelihood/impact/evidence/mitigation/monitoringSignal/residualRisk/rationale) round-trip deterministically", () => {
    const result = buildChecklistTaxonomyResult([
      { modelId: "chatgpt" as ModelId, fields: { summary: "", items: [{ id: "dpa", label: "Sign a data processing agreement" }], notes: [] } },
    ]);
    assertDeterministic(baseRecord("checklist_taxonomy", result));
  });

  it("definition_explanation: 'none'-sentinel fields (no example/analogy/advancedDetail) round-trip deterministically", () => {
    const fields = (overrides: Partial<DefinitionExplanationFields> = {}): DefinitionExplanationFields => ({
      term: "none", directAnswer: "", explanation: "", keyPoints: [], example: "none", analogyText: "none",
      analogyLimits: "none", distinctions: [], processSteps: [], advancedDetail: "none", commonMisconceptions: [],
      relatedConcepts: [], sources: [],
      ...overrides,
    });
    const result = buildDefinitionExplanationResult(
      [{ modelId: "chatgpt" as ModelId, fields: fields({ directAnswer: "X is Y." }) }],
      1
    );
    assertDeterministic(baseRecord("definition_explanation", result));
  });

  it("causal_explanation: minimal single-model input round-trips deterministically (already-safe producer)", () => {
    const fields = (overrides: Partial<CausalExplanationFields> = {}): CausalExplanationFields => ({
      directAnswer: "", directCauses: [], contributingFactors: [], triggers: [], amplifiers: [],
      alternativeExplanations: [], causalLinks: [], confounders: [], disputedInterpretations: [],
      unknowns: [], testsOrEvidenceNeeded: [], sources: [],
      ...overrides,
    });
    const result = buildCausalExplanationResult(
      [{ modelId: "chatgpt" as ModelId, fields: fields({ directAnswer: "X causes Y." }) }],
      1
    );
    assertDeterministic(baseRecord("causal_explanation", result));
  });

  it("evidence_review: minimal single-model input round-trips deterministically (already-safe producer)", () => {
    const fields = (overrides: Partial<EvidenceReviewFields> = {}): EvidenceReviewFields => ({
      overallAssessment: "", dimensions: [], redFlags: [], strengths: [], applicabilityCaveats: [],
      recommendedChecks: [], sources: [],
      ...overrides,
    });
    const result = buildEvidenceReviewResult([{ modelId: "chatgpt" as ModelId, fields: fields({ overallAssessment: "Moderate confidence." }) }]);
    assertDeterministic(baseRecord("evidence_review", result));
  });

  it("bias_blindspot_audit: minimal input (no sourceConcentration/homogeneityMessage) round-trips deterministically", async () => {
    const { buildBiasBlindspotAuditResult } = await import("@/lib/adaptiveSchema/biasBlindspotAlignment");
    const results = [{ modelId: "chatgpt" as ModelId, status: "ok" as const, rawText: "x", latencyMs: 5 }];
    const result = await buildBiasBlindspotAuditResult(
      [{ modelId: "chatgpt" as ModelId, fields: { summary: "A summary.", omittedDimensions: [], sharedAssumptions: [], missingStakeholders: [], geographicBiases: [], sourceConcentrationConcerns: [], evidenceTypeConcerns: [], followUpQuestions: [], sources: [] } }],
      1,
      "q",
      results
    );
    assertDeterministic(baseRecord("bias_blindspot_audit", result));
  });

  it("decision_support: minimal input (no reversibleNextStep/recommendedOptionId/risk fields) round-trips deterministically", () => {
    const fields = (overrides: Partial<DecisionSupportFields> = {}): DecisionSupportFields => ({
      decisionQuestion: "", options: [], criteria: [], userProvidedCriteria: [], assessments: [],
      recommendationAction: "", recommendedOption: "none", recommendationRationale: "", recommendationCaveats: [],
      assumptions: [], uncertainties: [], risks: [{ id: "r", label: "Vendor lock-in" }], sensitivityFindings: [],
      reversibleNextStep: "", sources: [],
      ...overrides,
    });
    const result = buildDecisionSupportResult([{ modelId: "chatgpt" as ModelId, fields: fields() }]);
    assertDeterministic(baseRecord("decision_support", result));
  });

  it("deep_research: minimal input round-trips deterministically", async () => {
    const { buildDeepResearchResult } = await import("@/lib/adaptiveSchema/deepResearchAlignment");
    const fields = {
      executiveSummary: "A summary of findings.",
      findings: [],
      disagreements: [],
      evidenceGaps: [],
      openQuestions: [],
      researchBoundaries: [],
      recommendedNextSteps: [],
      sources: [],
    };
    const result = await buildDeepResearchResult([{ modelId: "chatgpt" as ModelId, fields }], "q");
    assertDeterministic(baseRecord("deep_research", result));
  });
});
