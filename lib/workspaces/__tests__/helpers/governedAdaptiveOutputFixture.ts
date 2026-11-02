/**
 * A complete, valid Milestone-2 (Decision Support) persisted adaptive output — the same shape
 * lib/adaptiveSchema/__tests__/governanceInitialization.spec.ts uses — so the REAL governance initializer builds and
 * writes a governance record in the B1 exclusion proof.
 */
import { SCHEMA_ANSWER_SHAPE, type PersistedAdaptiveOutputV1 } from "@/lib/adaptiveSchema/persistedOutput";

export function governedAdaptiveOutput(): PersistedAdaptiveOutputV1 {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: SCHEMA_ANSWER_SHAPE.decision_support,
    classification: {
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
    },
    meta: {
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
      generatedAt: "2026-07-29T00:00:00.000Z",
    },
    result: {
      decisionQuestion: "Which CRM should we choose?",
      options: [{ id: "hubspot", label: "HubSpot", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] }],
      criteria: [{ id: "cost", label: "Total cost", source: "user", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] }],
      assessments: [],
      recommendation: { action: "choose_option", recommendedOptionId: "hubspot", rationale: "Lower cost fits the stated budget.", caveats: [], isContested: false, supportCount: 2, totalModelsWithRecommendation: 2 },
      assumptions: [],
      uncertainties: [],
      risks: [],
      sensitivityFindings: [],
      reversibleNextStep: "Run a 2-week pilot with HubSpot.",
      humanReviewNeeded: false,
      sourceBacked: false,
      sources: [],
      totalModels: 2,
    },
    generatedAt: "2026-07-29T00:00:00.000Z",
  } as PersistedAdaptiveOutputV1;
}
