/**
 * Milestone 2 — proves finalizeAdaptiveRun() takes the parallel
 * comparison_matrix path end-to-end: real per-model JSON in, a real
 * ComparisonMatrixResult out, and NONE of alignedClaims/gate/
 * synthesisReport/trustSummary/rankedEnumeration populated (those belong to
 * other pipelines this schema never touches — see comparisonAlignment.ts).
 */

import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { ModelResult } from "@/lib/types";

function modelResult(modelId: string, cells: Array<{ subject: string; attribute: string; value: string }>): ModelResult {
  return {
    modelId: modelId as any,
    status: "ok",
    rawText: JSON.stringify({ cells }),
    latencyMs: 5,
  };
}

describe("finalizeAdaptiveRun — comparison_matrix takes the parallel path", () => {
  it("produces a real ComparisonMatrixResult and none of the other pipelines' fields", async () => {
    const results: ModelResult[] = [
      modelResult("chatgpt", [{ subject: "iPhone 15", attribute: "Price", value: "$799" }]),
      modelResult("claude", [{ subject: "iPhone 15", attribute: "Price", value: "$799" }]),
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.comparison_matrix, results, "Compare iPhone 15 and Galaxy S24 on price");

    expect(output.schemaId).toBe("comparison_matrix");
    expect(output.comparisonMatrix).toBeDefined();
    expect(output.comparisonMatrix!.cells).toHaveLength(1);
    expect(output.comparisonMatrix!.cells[0].coverageCount).toBe(2);
    expect(output.comparisonMatrix!.cells[0].agreement).toBe("consensus");

    expect(output.alignedClaims).toBeUndefined();
    expect(output.gate).toBeUndefined();
    expect(output.synthesisReport).toBeUndefined();
    expect(output.trustSummary).toBeUndefined();
    expect(output.rankedEnumeration).toBeUndefined();
  });

  it("still produces an (empty) ComparisonMatrixResult when every model fails to parse, never throws", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: "not json", latencyMs: 5 },
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.comparison_matrix, results, "q");

    expect(output.comparisonMatrix).toBeDefined();
    expect(output.comparisonMatrix!.cells).toEqual([]);
  });

  it("works with no classification argument at all (optional 5th param)", async () => {
    const results: ModelResult[] = [modelResult("chatgpt", [{ subject: "X", attribute: "Price", value: "$1" }])];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.comparison_matrix, results, "q");
    expect(output.comparisonMatrix!.cells).toHaveLength(1);
  });
});
