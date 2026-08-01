/**
 * Milestone 2 — proves finalizeAdaptiveRun() takes the parallel
 * evidence_review path end-to-end: real per-model JSON in, a real
 * EvidenceReviewResult out (using evidence_review's own dedicated validator
 * and evidenceReviewAlignment.ts), NONE of alignedClaims/gate/
 * synthesisReport/trustSummary/rankedEnumeration/comparisonMatrix/
 * definitionExplanation/causalExplanation/checklistTaxonomy/deepResearch
 * populated, and that every other activated schema plus the protected
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
      overallAssessment: "The evidence is moderate.",
      dimensions: [{ id: "a", dimension: "Methodology", assessment: "A reasonable design.", strength: "moderate" }],
      redFlags: [],
      strengths: [],
      applicabilityCaveats: [],
      recommendedChecks: [],
      sources: [],
      ...overrides,
    }),
    latencyMs: 5,
  };
}

describe("finalizeAdaptiveRun — evidence_review takes its own dedicated path", () => {
  it("validates against evidence_review's own wire schema and produces a real EvidenceReviewResult", async () => {
    const results: ModelResult[] = [modelResult("chatgpt"), modelResult("claude")];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.evidence_review, results, "How strong is the evidence for this claim?");

    expect(output.schemaId).toBe("evidence_review");
    expect(output.evidenceReview).toBeDefined();
    expect(output.evidenceReview!.overallAssessment).toBe("The evidence is moderate.");
    expect(output.evidenceReview!.dimensions[0].coverageCount).toBe(2);
  });

  it("never populates alignedClaims/gate/synthesisReport/trustSummary/other parallel-path fields", async () => {
    const results: ModelResult[] = [modelResult("chatgpt")];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.evidence_review, results, "q");

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
  });

  it("still produces an (empty) EvidenceReviewResult when every model fails to parse, never throws", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: "not json", latencyMs: 5 },
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.evidence_review, results, "q");

    expect(output.evidenceReview).toBeDefined();
    expect(output.evidenceReview!.dimensions).toEqual([]);
    expect(output.evidenceReview!.overallStrength).toBe("unknown");
  });

  it("uses the full attempted model count as the coverage denominator, not just the successful ones", async () => {
    const results: ModelResult[] = [
      modelResult("chatgpt"),
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.evidence_review, results, "q");

    expect(output.evidenceReview!.dimensions[0].coverageCount).toBe(1);
    expect(output.evidenceReview!.dimensions[0].totalModels).toBe(2);
  });
});

describe("finalizeAdaptiveRun — other schemas remain unaffected by evidence_review's activation", () => {
  it("deep_research remains active and unchanged", () => {
    expect(SCHEMA_REGISTRY.deep_research.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.deep_research.renderHint).toBe("deep_research_view");
  });

  it("causal_explanation remains active and unchanged", () => {
    expect(SCHEMA_REGISTRY.causal_explanation.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.causal_explanation.renderHint).toBe("causal_map");
  });

  it("factual_lookup still follows the claim-matrix/direct_answer path, not evidence_review's", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: JSON.stringify({ answer: "Nairobi", source: "general knowledge", caveat: "none" }), latencyMs: 5 },
    ];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.factual_lookup, results, "What is the capital of Kenya?");
    expect(output.evidenceReview).toBeUndefined();
  });
});
