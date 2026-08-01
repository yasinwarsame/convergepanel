/**
 * Milestone 2 — proves finalizeAdaptiveRun() takes the parallel
 * ranked_enumeration path end-to-end: real per-model JSON in, a real
 * RankedEnumerationResult out, and NONE of alignedClaims/gate/
 * synthesisReport/trustSummary populated (those belong to the claim-matrix
 * pipeline, which this schema never touches — see enumAlignment.ts).
 */

import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { QueryClassification } from "@/lib/adaptiveSchema/types";
import { ModelResult } from "@/lib/types";

function modelResult(modelId: string, items: Array<{ id: string; label: string; rank: number }>): ModelResult {
  return {
    modelId: modelId as any,
    status: "ok",
    rawText: JSON.stringify({ items }),
    latencyMs: 5,
  };
}

function classification(overrides: Partial<QueryClassification> = {}): QueryClassification {
  return {
    queryType: "ranked_enumeration",
    domain: "test",
    answerShape: "ranked_list",
    quantExpected: true,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence: 0.9,
    riskLevel: "casual",
    evidenceRequirement: "low",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "semantic_item_overlap",
    requestedCount: null,
    requiresClarification: false,
    rationale: "test fixture",
    ...overrides,
  };
}

describe("finalizeAdaptiveRun — ranked_enumeration takes the parallel path", () => {
  it("produces a real RankedEnumerationResult and none of the claim-matrix fields", async () => {
    const results: ModelResult[] = [
      modelResult("chatgpt", [{ id: "chatgpt-tool", label: "ChatGPT", rank: 1 }]),
      modelResult("claude", [{ id: "chatgpt", label: "ChatGPT", rank: 1 }]),
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.ranked_enumeration, results, "What are the top AI tools?", undefined, classification());

    expect(output.schemaId).toBe("ranked_enumeration");
    expect(output.rankedEnumeration).toBeDefined();
    expect(output.rankedEnumeration!.items).toHaveLength(1);
    expect(output.rankedEnumeration!.items[0].coverageCount).toBe(2);

    // Never touches the claim-matrix pipeline for this schema.
    expect(output.alignedClaims).toBeUndefined();
    expect(output.gate).toBeUndefined();
    expect(output.synthesisReport).toBeUndefined();
    expect(output.trustSummary).toBeUndefined();
  });

  it("threads classification.requestedCount through to the shortfall check", async () => {
    const results: ModelResult[] = [modelResult("chatgpt", [{ id: "only-one", label: "Only One", rank: 1 }])];

    const output = await finalizeAdaptiveRun(
      SCHEMA_REGISTRY.ranked_enumeration,
      results,
      "Top 20 things",
      undefined,
      classification({ requestedCount: 20 })
    );

    expect(output.rankedEnumeration!.requestedCount).toBe(20);
    expect(output.rankedEnumeration!.shortfallNote).toMatch(/20/);
  });

  it("still produces a (empty) RankedEnumerationResult when every model fails to parse, never throws", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: "not json", latencyMs: 5 },
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.ranked_enumeration, results, "q", undefined, classification());

    expect(output.rankedEnumeration).toBeDefined();
    expect(output.rankedEnumeration!.items).toEqual([]);
  });

  it("has no requestedCount when classification is omitted (defaults to null, not a crash)", async () => {
    const results: ModelResult[] = [modelResult("chatgpt", [{ id: "x", label: "X", rank: 1 }])];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.ranked_enumeration, results, "q");
    expect(output.rankedEnumeration!.requestedCount).toBeNull();
  });
});
