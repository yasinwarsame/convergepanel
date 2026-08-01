/**
 * Milestone 2 — proves finalizeAdaptiveRun() takes the parallel
 * causal_explanation path end-to-end: real per-model JSON in, a real
 * CausalExplanationResult out (built by causalAlignment.ts, using the
 * schema's own dedicated wire fields — no reuse of claim-matrix
 * validation/alignment), reaching the same shape DefinitionExplanationView-
 * style renderers consume, and NONE of alignedClaims/gate/synthesisReport/
 * trustSummary/rankedEnumeration/comparisonMatrix/definitionExplanation
 * populated. Also proves other schemas are unaffected by this activation.
 */

import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { ModelResult } from "@/lib/types";

function modelResult(modelId: string, overrides: Record<string, unknown> = {}): ModelResult {
  return {
    modelId: modelId as any,
    status: "ok",
    rawText: JSON.stringify({
      directAnswer: "Inflation rises when demand outpaces supply.",
      directCauses: ["Rising demand"],
      contributingFactors: [],
      triggers: [],
      amplifiers: [],
      alternativeExplanations: [],
      causalLinks: [],
      confounders: [],
      disputedInterpretations: [],
      unknowns: [],
      testsOrEvidenceNeeded: [],
      sources: [],
      ...overrides,
    }),
    latencyMs: 5,
  };
}

describe("finalizeAdaptiveRun — causal_explanation takes its own dedicated path", () => {
  it("validates against causal_explanation's own wire schema and produces a real CausalExplanationResult", async () => {
    const results: ModelResult[] = [modelResult("chatgpt"), modelResult("claude")];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.causal_explanation, results, "Why does inflation rise?");

    expect(output.schemaId).toBe("causal_explanation");
    expect(output.causalExplanation).toBeDefined();
    expect(output.causalExplanation!.directAnswer).toBe("Inflation rises when demand outpaces supply.");
    expect(output.causalExplanation!.factors[0].coverageCount).toBe(2);
  });

  it("never populates alignedClaims/gate/synthesisReport/trustSummary/rankedEnumeration/comparisonMatrix/definitionExplanation", async () => {
    const results: ModelResult[] = [modelResult("chatgpt"), modelResult("claude")];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.causal_explanation, results, "Why does inflation rise?");

    expect(output.alignedClaims).toBeUndefined();
    expect(output.gate).toBeUndefined();
    expect(output.synthesisReport).toBeUndefined();
    expect(output.trustSummary).toBeUndefined();
    expect(output.rankedEnumeration).toBeUndefined();
    expect(output.comparisonMatrix).toBeUndefined();
    expect(output.definitionExplanation).toBeUndefined();
  });

  it("still produces an (empty) CausalExplanationResult when every model fails to parse, never throws", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: "not json", latencyMs: 5 },
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.causal_explanation, results, "q");

    expect(output.causalExplanation).toBeDefined();
    expect(output.causalExplanation!.factors).toEqual([]);
    expect(output.causalExplanation!.directAnswer).toBe("");
  });

  it("uses the full attempted model count as the coverage denominator, not just the successful ones", async () => {
    const results: ModelResult[] = [
      modelResult("chatgpt"),
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.causal_explanation, results, "q");

    expect(output.causalExplanation!.factors[0].coverageCount).toBe(1);
    expect(output.causalExplanation!.factors[0].totalModels).toBe(2);
  });
});

describe("finalizeAdaptiveRun — other schemas remain unaffected by causal_explanation's activation", () => {
  it("factual_lookup still follows the claim-matrix path, not the causal one", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: JSON.stringify({ answer: "Nairobi", source: "general knowledge", caveat: "none" }), latencyMs: 5 },
    ];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.factual_lookup, results, "What is the capital of Kenya?");
    expect(output.causalExplanation).toBeUndefined();
    expect(output.definitionExplanation).toBeUndefined();
  });

  it("definition_explanation still follows its own dedicated path, not the causal one", async () => {
    const results: ModelResult[] = [
      {
        modelId: "chatgpt" as any,
        status: "ok",
        rawText: JSON.stringify({
          term: "none",
          directAnswer: "X is Y.",
          explanation: "A fuller explanation.",
          keyPoints: [],
          example: "none",
          analogyText: "none",
          analogyLimits: "none",
          distinctions: [],
          processSteps: [],
          advancedDetail: "none",
          commonMisconceptions: [],
          relatedConcepts: [],
          sources: [],
        }),
        latencyMs: 5,
      },
    ];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.definition_explanation, results, "What is X?");
    expect(output.definitionExplanation).toBeDefined();
    expect(output.causalExplanation).toBeUndefined();
  });

  it("decision_support is active and unchanged by this file — its own coverage lives in decisionSupportOrchestration.spec.ts", () => {
    expect(SCHEMA_REGISTRY.decision_support.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.decision_support.renderHint).toBe("decision_support_view");
  });

  it("procedural remains active and unchanged (still the claim-matrix step_diff path)", () => {
    expect(SCHEMA_REGISTRY.procedural.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.procedural.renderHint).toBe("step_diff");
  });

  it("medical_health/legal_regulatory/financial_valuation remain active and unchanged (protected high-stakes schemas)", () => {
    expect(SCHEMA_REGISTRY.medical_health.renderHint).toBe("evidence_tiers");
    expect(SCHEMA_REGISTRY.legal_regulatory.renderHint).toBe("rule_application");
    expect(SCHEMA_REGISTRY.financial_valuation.renderHint).toBe("metrics_grid");
  });
});
