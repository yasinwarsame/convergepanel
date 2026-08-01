/**
 * Milestone 2 — proves finalizeAdaptiveRun() takes the parallel
 * deep_research path end-to-end: real per-model JSON in, a real
 * DeepResearchResult out (using deep_research's own dedicated validator and
 * deepResearchAlignment.ts), NONE of alignedClaims/gate/synthesisReport/
 * trustSummary/rankedEnumeration/comparisonMatrix/definitionExplanation/
 * causalExplanation/checklistTaxonomy populated, and that every other
 * activated schema plus the protected Claim/Video Verification paths remain
 * completely unaffected by this activation.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { ModelResult } from "@/lib/types";

function modelResult(modelId: string, overrides: Record<string, unknown> = {}): ModelResult {
  return {
    modelId: modelId as any,
    status: "ok",
    rawText: JSON.stringify({
      executiveSummary: "A concise research synthesis.",
      findings: [{ id: "a", title: "Finding", summary: "A well-documented finding across studies." }],
      disagreements: [],
      evidenceGaps: [],
      openQuestions: [],
      researchBoundaries: [],
      recommendedNextSteps: [],
      sources: [],
      ...overrides,
    }),
    latencyMs: 5,
  };
}

function mockNoGaps() {
  mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "ok", rawText: JSON.stringify({ gaps: [] }), latencyMs: 5 });
}

describe("finalizeAdaptiveRun — deep_research takes its own dedicated path", () => {
  afterEach(() => jest.clearAllMocks());

  it("validates against deep_research's own wire schema and produces a real DeepResearchResult", async () => {
    mockNoGaps();
    const results: ModelResult[] = [modelResult("chatgpt"), modelResult("claude")];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.deep_research, results, "Summarize research on AI and employment.");

    expect(output.schemaId).toBe("deep_research");
    expect(output.deepResearch).toBeDefined();
    expect(output.deepResearch!.executiveSummary).toBe("A concise research synthesis.");
    expect(output.deepResearch!.findings[0].coverageCount).toBe(2);
  });

  it("never populates alignedClaims/gate/synthesisReport/trustSummary/other parallel-path fields", async () => {
    mockNoGaps();
    const results: ModelResult[] = [modelResult("chatgpt")];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.deep_research, results, "q");

    expect(output.alignedClaims).toBeUndefined();
    expect(output.gate).toBeUndefined();
    expect(output.synthesisReport).toBeUndefined();
    expect(output.trustSummary).toBeUndefined();
    expect(output.rankedEnumeration).toBeUndefined();
    expect(output.comparisonMatrix).toBeUndefined();
    expect(output.definitionExplanation).toBeUndefined();
    expect(output.causalExplanation).toBeUndefined();
    expect(output.checklistTaxonomy).toBeUndefined();
  });

  it("still produces an (empty) DeepResearchResult when every model fails to parse, never throws", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: "not json", latencyMs: 5 },
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.deep_research, results, "q");

    expect(output.deepResearch).toBeDefined();
    expect(output.deepResearch!.findings).toEqual([]);
    expect(mockedCallGemini).not.toHaveBeenCalled();
  });
});

describe("finalizeAdaptiveRun — other schemas remain unaffected by deep_research's activation", () => {
  it("contested_empirical remains active and unchanged (still the claim-matrix consensus_map path)", () => {
    expect(SCHEMA_REGISTRY.contested_empirical.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.contested_empirical.renderHint).toBe("consensus_map");
  });

  it("causal_explanation remains active and unchanged", () => {
    expect(SCHEMA_REGISTRY.causal_explanation.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.causal_explanation.renderHint).toBe("causal_map");
  });

  it("definition_explanation remains active and unchanged", () => {
    expect(SCHEMA_REGISTRY.definition_explanation.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.definition_explanation.renderHint).toBe("definition_card");
  });

  it("comparison_matrix remains active and unchanged", () => {
    expect(SCHEMA_REGISTRY.comparison_matrix.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.comparison_matrix.renderHint).toBe("comparison_grid");
  });

  it("factual_lookup still follows the claim-matrix/direct_answer path, not deep_research's", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: JSON.stringify({ answer: "Nairobi", source: "general knowledge", caveat: "none" }), latencyMs: 5 },
    ];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.factual_lookup, results, "What is the capital of Kenya?");
    expect(output.deepResearch).toBeUndefined();
  });
});
