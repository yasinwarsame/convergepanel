/**
 * Milestone 2 — proves finalizeAdaptiveRun() takes the parallel
 * definition_explanation path end-to-end: real per-model JSON in, a real
 * DefinitionExplanationResult out, and NONE of alignedClaims/gate/
 * synthesisReport/trustSummary/rankedEnumeration/comparisonMatrix populated
 * (those belong to other pipelines this schema never touches — see
 * definitionAlignment.ts).
 */

import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { ModelResult } from "@/lib/types";

function modelResult(modelId: string, overrides: Record<string, unknown> = {}): ModelResult {
  return {
    modelId: modelId as any,
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
      ...overrides,
    }),
    latencyMs: 5,
  };
}

describe("finalizeAdaptiveRun — definition_explanation takes the parallel path", () => {
  it("produces a real DefinitionExplanationResult and none of the other pipelines' fields", async () => {
    const results: ModelResult[] = [modelResult("chatgpt"), modelResult("claude")];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.definition_explanation, results, "What is X?");

    expect(output.schemaId).toBe("definition_explanation");
    expect(output.definitionExplanation).toBeDefined();
    expect(output.definitionExplanation!.primary).not.toBeNull();
    expect(output.definitionExplanation!.primary!.coverageCount).toBe(2);

    expect(output.alignedClaims).toBeUndefined();
    expect(output.gate).toBeUndefined();
    expect(output.synthesisReport).toBeUndefined();
    expect(output.trustSummary).toBeUndefined();
    expect(output.rankedEnumeration).toBeUndefined();
    expect(output.comparisonMatrix).toBeUndefined();
  });

  it("still produces an (empty-primary) DefinitionExplanationResult when every model fails to parse, never throws", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: "not json", latencyMs: 5 },
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.definition_explanation, results, "q");

    expect(output.definitionExplanation).toBeDefined();
    expect(output.definitionExplanation!.primary).toBeNull();
  });

  it("uses the full attempted model count as the coverage denominator, not just the successful ones", async () => {
    const results: ModelResult[] = [
      modelResult("chatgpt"),
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.definition_explanation, results, "q");

    expect(output.definitionExplanation!.primary!.coverageCount).toBe(1);
    expect(output.definitionExplanation!.primary!.totalModels).toBe(2);
  });

  it("merges semantically equivalent (paraphrased) definitions end-to-end into one interpretation", async () => {
    const results: ModelResult[] = [
      modelResult("chatgpt", { term: "CAGR", directAnswer: "CAGR is the annual growth rate of an investment smoothed over a period." }),
      modelResult("claude", { term: "CAGR", directAnswer: "CAGR is the smoothed annual growth rate of an investment over a period." }),
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.definition_explanation, results, "What does CAGR mean?");

    expect(output.definitionExplanation!.isAmbiguous).toBe(false);
    expect(output.definitionExplanation!.alternateInterpretations).toEqual([]);
    expect(output.definitionExplanation!.primary!.coverageCount).toBe(2);
  });

  it("keeps materially different accepted meanings separate end-to-end ('What is a model?')", async () => {
    const results: ModelResult[] = [
      modelResult("chatgpt", { term: "model", directAnswer: "In machine learning, a model is a function trained on data to make predictions." }),
      modelResult("claude", { term: "model", directAnswer: "A fashion model is a person who displays clothing and products commercially." }),
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.definition_explanation, results, "What is a model?");

    expect(output.definitionExplanation!.isAmbiguous).toBe(true);
    expect(output.definitionExplanation!.alternateInterpretations).toHaveLength(1);
    expect(output.definitionExplanation!.primary).not.toBeNull();
  });

  it("normalizes the 'none' sentinel to undefined end-to-end for example/analogy/advancedDetail", async () => {
    const results: ModelResult[] = [modelResult("chatgpt")];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.definition_explanation, results, "q");

    expect(output.definitionExplanation!.primary!.example).toBeUndefined();
    expect(output.definitionExplanation!.primary!.analogy).toBeUndefined();
    expect(output.definitionExplanation!.primary!.advancedDetail).toBeUndefined();
  });
});
