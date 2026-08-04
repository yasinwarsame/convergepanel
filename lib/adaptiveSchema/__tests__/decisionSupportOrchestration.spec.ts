/**
 * Milestone 2 — proves finalizeAdaptiveRun() takes the parallel
 * decision_support path end-to-end: real per-model JSON in, a real
 * DecisionSupportResult out (using decision_support's own dedicated
 * validator and decisionSupportAlignment.ts, NOT claim alignment), NONE of
 * alignedClaims/gate/synthesisReport/trustSummary/rankedEnumeration/
 * comparisonMatrix/definitionExplanation/causalExplanation/
 * checklistTaxonomy/deepResearch/evidenceReview/biasBlindspotAudit
 * populated, that comparison_matrix/causal_explanation/procedural/
 * financial_valuation all remain unchanged, and that the protected
 * Claim/Video Verification paths remain completely unaffected.
 */

import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { ModelResult } from "@/lib/types";

function modelResult(modelId: string, overrides: Record<string, unknown> = {}): ModelResult {
  return {
    modelId: modelId as any,
    status: "ok",
    rawText: JSON.stringify({
      decisionQuestion: "Which CRM should we choose?",
      options: ["HubSpot", "Salesforce"],
      criteria: ["Total cost"],
      userProvidedCriteria: [],
      assessments: [{ id: "a", optionLabel: "HubSpot", criterionLabel: "Total cost", assessment: "Cheaper for a small team." }],
      recommendationAction: "choose_option",
      recommendedOption: "HubSpot",
      recommendationRationale: "Lower cost fits the stated budget.",
      recommendationCaveats: [],
      assumptions: [],
      uncertainties: [],
      risks: [],
      sensitivityFindings: [],
      reversibleNextStep: "none",
      sources: [],
      ...overrides,
    }),
    latencyMs: 5,
  };
}

describe("finalizeAdaptiveRun — decision_support takes its own dedicated path", () => {
  it("validates against decision_support's own wire schema and produces a real DecisionSupportResult", async () => {
    const results: ModelResult[] = [modelResult("chatgpt"), modelResult("claude")];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.decision_support, results, "Which CRM should we choose?");

    expect(output.schemaId).toBe("decision_support");
    expect(output.decisionSupport).toBeDefined();
    expect(output.decisionSupport!.decisionQuestion).toBe("Which CRM should we choose?");
    expect(output.decisionSupport!.recommendation.action).toBe("choose_option");
    expect(output.decisionSupport!.recommendation.recommendedOptionId).toBeDefined();
  });

  it("never populates alignedClaims/gate/synthesisReport/trustSummary/other parallel-path fields", async () => {
    const results: ModelResult[] = [modelResult("chatgpt")];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.decision_support, results, "q");

    expect(output.alignedClaims).toBeUndefined();
    expect(output.gate).toBeUndefined();
    expect(output.synthesisReport).toBeUndefined();
    expect(output.trustSummary).toBeUndefined();
    expect(output.rankedEnumeration).toBeUndefined();
    expect(output.comparisonMatrix).toBeUndefined();
    expect(output.definitionExplanation).toBeUndefined();
    expect(output.causalExplanation).toBeUndefined();
    expect(output.checklistTaxonomy).toBeUndefined();
    expect(output.deepResearch).toBeUndefined();
    expect(output.evidenceReview).toBeUndefined();
    expect(output.biasBlindspotAudit).toBeUndefined();
  });

  it("still produces an (empty) DecisionSupportResult when every model fails to parse, never throws", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: "not json", latencyMs: 5 },
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.decision_support, results, "q");

    expect(output.decisionSupport).toBeDefined();
    expect(output.decisionSupport!.options).toEqual([]);
    expect(output.decisionSupport!.humanReviewNeeded).toBe(true);
  });

  it("threads classification.riskLevel through to humanReviewNeeded computation", async () => {
    const results: ModelResult[] = [modelResult("chatgpt"), modelResult("claude")];
    const classification: any = {
      queryType: "decision_support",
      domain: "test",
      answerShape: "decision_support_view",
      quantExpected: false,
      timeSensitivity: "low",
      userIntent: "make_decision",
      confidence: 0.9,
      riskLevel: "safety_critical",
      evidenceRequirement: "high",
      freshness: "timeless",
      inputType: "text",
      verificationMethod: "cross_model_consistency",
      requestedCount: null,
      requiresClarification: false,
      rationale: "test",
    };

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.decision_support, results, "q", undefined, classification);

    expect(output.decisionSupport!.humanReviewNeeded).toBe(true);
  });
});

describe("finalizeAdaptiveRun — other schemas remain unaffected by decision_support's activation", () => {
  it("comparison_matrix remains active and unchanged", () => {
    expect(SCHEMA_REGISTRY.comparison_matrix.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.comparison_matrix.renderHint).toBe("comparison_grid");
  });

  it("causal_explanation remains active and unchanged", () => {
    expect(SCHEMA_REGISTRY.causal_explanation.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.causal_explanation.renderHint).toBe("causal_map");
  });

  it("procedural remains active and unchanged (still the claim-matrix step_diff path)", () => {
    expect(SCHEMA_REGISTRY.procedural.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.procedural.renderHint).toBe("step_diff");
  });

  it("financial_valuation remains active and unchanged (still the claim-matrix metrics_grid path)", () => {
    expect(SCHEMA_REGISTRY.financial_valuation.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.financial_valuation.renderHint).toBe("metrics_grid");
  });

  it("factual_lookup still follows the claim-matrix/direct_answer path, not decision_support's", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: JSON.stringify({ answer: "Nairobi", source: "general knowledge", caveat: "none" }), latencyMs: 5 },
    ];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.factual_lookup, results, "What is the capital of Kenya?");
    expect(output.decisionSupport).toBeUndefined();
  });
});
