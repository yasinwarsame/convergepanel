/**
 * Milestone 2 — proves finalizeAdaptiveRun() takes the parallel
 * checklist_taxonomy path end-to-end: real per-model JSON in, a real
 * ChecklistTaxonomyResult out, and NONE of alignedClaims/gate/
 * synthesisReport/trustSummary/rankedEnumeration/comparisonMatrix/
 * definitionExplanation/causalExplanation populated.
 */

import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { ModelResult } from "@/lib/types";

function modelResult(modelId: string, items: Array<{ id: string; label: string; category?: string }>): ModelResult {
  return {
    modelId: modelId as any,
    status: "ok",
    rawText: JSON.stringify({ summary: "A checklist.", items, notes: [] }),
    latencyMs: 5,
  };
}

describe("finalizeAdaptiveRun — checklist_taxonomy takes the parallel path", () => {
  it("produces a real ChecklistTaxonomyResult and none of the other pipelines' fields", async () => {
    const results: ModelResult[] = [
      modelResult("chatgpt", [{ id: "dpa", label: "Data processing agreement" }]),
      modelResult("claude", [{ id: "dpa", label: "Data processing agreement" }]),
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.checklist_taxonomy, results, "GDPR readiness checklist");

    expect(output.schemaId).toBe("checklist_taxonomy");
    expect(output.checklistTaxonomy).toBeDefined();
    expect(output.checklistTaxonomy!.categories[0].items[0].coverageCount).toBe(2);

    expect(output.alignedClaims).toBeUndefined();
    expect(output.gate).toBeUndefined();
    expect(output.synthesisReport).toBeUndefined();
    expect(output.trustSummary).toBeUndefined();
    expect(output.rankedEnumeration).toBeUndefined();
    expect(output.comparisonMatrix).toBeUndefined();
    expect(output.definitionExplanation).toBeUndefined();
    expect(output.causalExplanation).toBeUndefined();
  });

  it("still produces an (empty) ChecklistTaxonomyResult when every model fails to parse, never throws", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: "not json", latencyMs: 5 },
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.checklist_taxonomy, results, "q");

    expect(output.checklistTaxonomy).toBeDefined();
    expect(output.checklistTaxonomy!.categories).toEqual([]);
  });

  it("groups items into a taxonomy when the panel provides categories", async () => {
    const results: ModelResult[] = [
      modelResult("chatgpt", [{ id: "reactive", label: "Rule-based agents", category: "Reactive" }]),
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.checklist_taxonomy, results, "What kinds of AI agents exist?");

    expect(output.checklistTaxonomy!.categories.map((c) => c.category)).toEqual(["Reactive"]);
  });
});
