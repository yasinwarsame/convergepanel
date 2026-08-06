/**
 * Phase 2 pilot history-reload fix — finalizeAdaptiveRun()'s
 * persistedLegacyOutput population tests.
 *
 * Proves: (1) a procedural run, with ADAPTIVE_VERIFICATION_ENABLED and a
 * classification, gets persistedLegacyOutput attached, carrying the same
 * alignedClaims/gate/synthesisReport/trustSummary the live response
 * already returns — no re-derivation, just a second reference to the same
 * computed objects; (2) a schema other than procedural (comparison_matrix,
 * one of the Milestone-2 dedicated schemas) NEVER gets persistedLegacyOutput
 * — this fix is deliberately scoped to procedural only; (3) without a
 * classification, no envelope is attached (mirrors attachAdaptiveEnvelope's
 * own guard); (4) with ADAPTIVE_VERIFICATION_ENABLED off, no envelope is
 * attached either (gate/synthesisReport never computed in that mode).
 */

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

import { callGemini } from "@/lib/connectors/gemini";
const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { ModelResult } from "@/lib/types";
import { QueryClassification } from "@/lib/adaptiveSchema/types";

const CLASSIFICATION: QueryClassification = {
  queryType: "procedural",
  domain: "test",
  answerShape: "step_diff",
  quantExpected: false,
  timeSensitivity: "low",
  userIntent: "learn_process",
  confidence: 0.9,
  riskLevel: "professional",
  evidenceRequirement: "medium",
  freshness: "timeless",
  inputType: "text",
  verificationMethod: "cross_model_consistency",
  requestedCount: null,
  requiresClarification: false,
  rationale: "test fixture",
};

function proceduralResponse(firstStepAction: string) {
  return JSON.stringify({
    goal: "Set up a repository and push an initial commit.",
    prerequisites: ["Git installed", "GitHub account"],
    steps: [
      { order: 1, action: firstStepAction },
      { order: 2, action: "Commit the initial files." },
    ],
    commonFailures: ["Forgetting to stage files."],
  });
}

const PROCEDURAL_RESULTS: ModelResult[] = [
  { modelId: "chatgpt", status: "ok", rawText: proceduralResponse("Open the terminal."), latencyMs: 500 },
  { modelId: "claude", status: "ok", rawText: proceduralResponse("Create the repo on GitHub."), latencyMs: 500 },
];

describe("finalizeAdaptiveRun — persistedLegacyOutput (Phase 2 pilot history-reload fix)", () => {
  afterEach(() => jest.clearAllMocks());

  it("attaches persistedLegacyOutput for schema.id === 'procedural' when ADAPTIVE_VERIFICATION_ENABLED and classification are both present", async () => {
    jest.resetModules();
    jest.doMock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "test-key" }));
    const { finalizeAdaptiveRun } = await import("@/lib/adaptiveSchema/orchestrate");
    // Bias detection / coverage audit / narrative calls all degrade
    // gracefully on a connector error — same pattern as
    // orchestrateVerification.spec.ts's own carbon-tax fixture — since
    // this test is about envelope attachment, not synthesis prose quality.
    mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, errorMessage: "n/a", latencyMs: 5 });

    const schema = SCHEMA_REGISTRY.procedural;
    const output = await finalizeAdaptiveRun(schema, PROCEDURAL_RESULTS, "How do I push an initial commit?", undefined, CLASSIFICATION);

    expect(output.gate).toBeDefined();
    expect(output.synthesisReport).toBeDefined();
    expect(output.trustSummary).toBeDefined();
    expect(output.persistedLegacyOutput).toBeDefined();

    const envelope = output.persistedLegacyOutput!;
    expect(envelope.version).toBe(1);
    expect(envelope.schemaId).toBe("procedural");
    expect(envelope.classification).toBe(CLASSIFICATION);
    // Same objects the live response returns — not a re-derivation.
    expect(envelope.results).toBe(output.adaptiveResults);
    expect(envelope.alignedClaims).toBe(output.alignedClaims);
    expect(envelope.gate).toBe(output.gate);
    expect(envelope.synthesisReport).toBe(output.synthesisReport);
    expect(envelope.trustSummary).toBe(output.trustSummary);
    // Real, already-parsed per-model data — never a raw JSON string.
    expect(envelope.results.length).toBeGreaterThan(0);
    expect(typeof envelope.results[0].data).toBe("object");
  });

  it("never attaches persistedLegacyOutput for a Milestone-2 dedicated schema (comparison_matrix) — this fix is scoped to procedural only", async () => {
    jest.resetModules();
    jest.doMock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "test-key" }));
    const { finalizeAdaptiveRun } = await import("@/lib/adaptiveSchema/orchestrate");

    const schema = SCHEMA_REGISTRY.comparison_matrix;
    const results: ModelResult[] = [
      { modelId: "chatgpt", status: "ok", rawText: JSON.stringify({ comparisonCells: [], directConclusion: "x", tradeoffs: [], bestUseRecommendations: [], uncertainties: [] }), latencyMs: 500 },
      { modelId: "claude", status: "ok", rawText: JSON.stringify({ comparisonCells: [], directConclusion: "x", tradeoffs: [], bestUseRecommendations: [], uncertainties: [] }), latencyMs: 500 },
    ];
    const output = await finalizeAdaptiveRun(schema, results, "Compare X and Y", undefined, {
      ...CLASSIFICATION,
      queryType: "comparison_matrix",
      answerShape: "comparison_grid",
    });

    expect(output.persistedLegacyOutput).toBeUndefined();
    // comparison_matrix gets the OTHER envelope instead — unaffected by this fix.
    expect(output.persistedOutput).toBeDefined();
  });

  it("never attaches persistedLegacyOutput without a classification, mirroring attachAdaptiveEnvelope's own guard", async () => {
    jest.resetModules();
    jest.doMock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "test-key" }));
    const { finalizeAdaptiveRun } = await import("@/lib/adaptiveSchema/orchestrate");
    mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, errorMessage: "n/a", latencyMs: 5 });

    const schema = SCHEMA_REGISTRY.procedural;
    const output = await finalizeAdaptiveRun(schema, PROCEDURAL_RESULTS, "How do I push an initial commit?");

    expect(output.gate).toBeDefined();
    expect(output.persistedLegacyOutput).toBeUndefined();
  });

  it("never attaches persistedLegacyOutput when ADAPTIVE_VERIFICATION_ENABLED is off — gate/synthesisReport are never computed in that mode", async () => {
    jest.resetModules();
    jest.doMock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: false, GEMINI_API_KEY: "test-key" }));
    const { finalizeAdaptiveRun } = await import("@/lib/adaptiveSchema/orchestrate");

    const schema = SCHEMA_REGISTRY.procedural;
    const output = await finalizeAdaptiveRun(schema, PROCEDURAL_RESULTS, "How do I push an initial commit?", undefined, CLASSIFICATION);

    expect(output.gate).toBeUndefined();
    expect(output.synthesisReport).toBeUndefined();
    expect(output.persistedLegacyOutput).toBeUndefined();
  });
});
