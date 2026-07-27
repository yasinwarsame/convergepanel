/**
 * Integration Test: end-to-end adaptive pipeline for one contested_empirical
 * run — 5 mock model responses (one deliberately garbage JSON), asserting:
 *  - the garbage response yields a failed cell (parseError) without crashing
 *  - the remaining 4 responses validate and produce a real aligned claims matrix
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { ModelResult } from "@/lib/types";

function wellFormedResponse(overrides: { settled: string; disputedId: string; disputedText: string }) {
  return JSON.stringify({
    summary: "Economists broadly agree on some drivers of inflation but split sharply on others.",
    settledClaims: [
      {
        id: overrides.settled,
        claim: "Excess demand relative to supply pushes prices up.",
        stance: "asserts",
        confidence: "settled",
        evidenceType: "empirical",
      },
    ],
    disputedClaims: [
      {
        id: overrides.disputedId,
        claim: overrides.disputedText,
        stance: "asserts",
        confidence: "contested",
        evidenceType: "theoretical",
        camps: [
          { label: "Monetarist view", position: "Money supply growth is the primary cause." },
          { label: "Structuralist view", position: "Supply chain concentration is the primary cause." },
        ],
      },
    ],
    keyMetrics: [{ label: "US CPI YoY", value: 3.2, unit: "%", asOf: "2026-06", source: "BLS" }],
    openQuestions: ["How persistent will core inflation be?"],
  });
}

describe("adaptive pipeline integration: contested_empirical with 5 models", () => {
  afterEach(() => jest.clearAllMocks());

  it("produces an aligned claims matrix and isolates the garbage-JSON model as a failed cell", async () => {
    const schema = SCHEMA_REGISTRY.contested_empirical;

    // 4 well-formed responses using the same slug for the settled claim (exact
    // match) and near-identical slugs for the disputed claim (fuzzy match),
    // plus one deliberately broken response from "grok".
    const results: ModelResult[] = [
      {
        modelId: "chatgpt",
        status: "ok",
        rawText: wellFormedResponse({
          settled: "demand-pull-driver",
          disputedId: "money-supply-vs-supply-chain",
          disputedText: "Core inflation is mainly monetary.",
        }),
        latencyMs: 500,
      },
      {
        modelId: "claude",
        status: "ok",
        rawText: wellFormedResponse({
          settled: "demand-pull-driver",
          disputedId: "money-supply-vs-supply-chains",
          disputedText: "Core inflation is mainly structural.",
        }),
        latencyMs: 500,
      },
      {
        modelId: "grok",
        status: "ok",
        rawText: "{not valid json at all!!",
        latencyMs: 500,
      },
      {
        modelId: "perplexity",
        status: "ok",
        rawText: wellFormedResponse({
          settled: "demand-pull-driver",
          disputedId: "money-supply-vs-supply-chain-effects",
          disputedText: "Both monetary and structural factors matter.",
        }),
        latencyMs: 500,
      },
      {
        modelId: "gemini",
        status: "ok",
        rawText: wellFormedResponse({
          settled: "demand-pull-drivers",
          disputedId: "money-supply-vs-supplychain",
          disputedText: "The debate is unresolved.",
        }),
        latencyMs: 500,
      },
    ];

    const output = await finalizeAdaptiveRun(schema, results);

    // Never crashes: exactly one result per model, in the same order.
    expect(output.adaptiveResults).toHaveLength(5);
    expect(output.adaptiveResults.map((r) => r.modelId)).toEqual([
      "chatgpt",
      "claude",
      "grok",
      "perplexity",
      "gemini",
    ]);

    // The garbage-JSON model is isolated as a failed cell, not a crash.
    const grokResult = output.adaptiveResults.find((r) => r.modelId === "grok")!;
    expect(grokResult.ok).toBe(false);
    expect(grokResult.parseError).toBeTruthy();

    // The other 4 parsed cleanly.
    const okModelIds = output.adaptiveResults.filter((r) => r.ok).map((r) => r.modelId);
    expect(okModelIds).toEqual(["chatgpt", "claude", "perplexity", "gemini"]);

    // A real aligned claims matrix was produced: the settled claim (identical
    // slug across all 4 valid models, one typo'd) should merge into one row
    // covering all 4 successful models; the disputed claim (fuzzy slugs)
    // should also merge into one row with camps preserved.
    expect(output.alignedClaims).toBeDefined();
    const settledRow = output.alignedClaims!.find((c) => c.claimText.includes("Excess demand"));
    expect(settledRow).toBeDefined();
    expect(settledRow!.cells.filter(Boolean)).toHaveLength(4);
    // grok never appears in any row since its claims failed validation entirely.
    for (const row of output.alignedClaims!) {
      expect(row.cells.some((c) => c?.modelId === "grok")).toBe(false);
    }

    const disputedRow = output.alignedClaims!.find((c) =>
      c.cells.some((cell) => cell && cell.camps && cell.camps.length > 0)
    );
    expect(disputedRow).toBeDefined();
    expect(disputedRow!.cells.filter(Boolean).length).toBeGreaterThanOrEqual(2);

    // No network call was needed — slug matching alone resolved every cluster.
    expect(mockedCallGemini).not.toHaveBeenCalled();
  });
});
