/**
 * Phase 2 pilot history-reload fix, widened in Batch 3 persistence
 * foundation (2C-1) — finalizeAdaptiveRun()'s persistedLegacyOutput
 * population tests.
 *
 * Proves: (1) a procedural run, with ADAPTIVE_VERIFICATION_ENABLED and a
 * classification, gets persistedLegacyOutput attached, carrying the same
 * alignedClaims/gate/synthesisReport/trustSummary the live response
 * already returns — no re-derivation, just a second reference to the same
 * computed objects; (1b) each of the 7 remaining Batch 3 schemas
 * (contested_empirical, legal_regulatory, financial_valuation,
 * factual_lookup, medical_health, forecast_speculative,
 * creative_generative) gets the exact same treatment, since all 8 reach
 * the identical claims-matrix fall-through in orchestrate.ts; (2) a
 * Milestone-2 dedicated schema (comparison_matrix) NEVER gets
 * persistedLegacyOutput — this envelope is deliberately scoped to the
 * legacy-active family, never the Milestone-2 one; (3) without a
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
import { parsePersistedLegacyAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";

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

  it.each([
    [
      "contested_empirical",
      {
        summary: "Experts disagree on the magnitude of the effect.",
        settledClaims: [{ id: "baseline-effect", claim: "The effect exists.", stance: "asserts", confidence: "settled", evidenceType: "empirical" }],
        disputedClaims: [
          {
            id: "effect-magnitude",
            claim: "The effect is large.",
            stance: "asserts",
            confidence: "contested",
            evidenceType: "empirical",
            camps: [{ label: "Large-effect camp", position: "The effect is substantial." }],
          },
        ],
        keyMetrics: [{ label: "Effect size", value: 0.3, unit: "SD", asOf: "2026", source: "meta-analysis" }],
        openQuestions: ["Does the effect hold across populations?"],
      },
    ],
    [
      "legal_regulatory",
      {
        applicableRule: "Reasonable accommodation must be provided absent undue hardship.",
        jurisdiction: "US federal",
        elements: ["Qualified individual", "Known disability", "Reasonable accommodation requested"],
        keyAuthority: ["ADA 42 U.S.C. § 12112"],
        exceptions: ["Undue hardship on the employer"],
        unsettledIssues: [{ id: "remote-work-accommodation", claim: "Remote work is always a reasonable accommodation.", stance: "uncertain", confidence: "contested", evidenceType: "authoritative" }],
        attorneyQuestions: ["Does this situation qualify as undue hardship?"],
      },
    ],
    [
      "financial_valuation",
      {
        thesis: "The company is undervalued relative to growth.",
        metrics: [{ label: "P/E", value: 18, unit: "x", asOf: "2026-Q2", source: "10-Q" }],
        bullCase: "Margin expansion continues.",
        bearCase: "Growth decelerates faster than priced in.",
        keyAssumptions: ["Revenue growth stays above 10%."],
        riskFactors: ["Macro slowdown."],
      },
    ],
    [
      "factual_lookup",
      {
        answer: "Paris.",
        source: "widely cited reference",
        caveat: "none",
      },
    ],
    [
      "medical_health",
      {
        summary: "Regular exercise reduces cardiovascular risk.",
        mechanism: "Improves endothelial function and lipid profile.",
        evidenceByTier: [{ id: "rct-evidence", claim: "Exercise reduces cardiovascular events.", stance: "asserts", confidence: "settled", evidenceType: "empirical" }],
        guidelinePositions: ["AHA recommends 150 minutes/week moderate activity."],
        redFlags: ["Chest pain during exertion."],
        clinicianQuestions: ["Is this safe given my current medications?"],
      },
    ],
    [
      "forecast_speculative",
      {
        scenarios: [
          { label: "Baseline", probability: 0.6, narrative: "Trends continue.", leadingIndicators: ["Stable growth"] },
          { label: "Upside", probability: 0.4, narrative: "Acceleration.", leadingIndicators: ["Demand surge"] },
        ],
        baseRates: ["Historically this occurs ~40% of the time."],
        keyUncertainties: ["Policy response."],
      },
    ],
    [
      "creative_generative",
      {
        output: "A short poem about autumn leaves falling gently to the ground.",
        styleNotes: ["Free verse", "Nature imagery"],
      },
    ],
  ] as const)(
    "attaches persistedLegacyOutput for the Batch 3 schema '%s' (2C-1) — same claims-matrix fall-through as procedural, same envelope shape",
    async (schemaId, fixtureData) => {
      jest.resetModules();
      jest.doMock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "test-key" }));
      const { finalizeAdaptiveRun } = await import("@/lib/adaptiveSchema/orchestrate");
      mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, errorMessage: "n/a", latencyMs: 5 });

      const schema = SCHEMA_REGISTRY[schemaId];
      const results: ModelResult[] = [
        { modelId: "chatgpt", status: "ok", rawText: JSON.stringify(fixtureData), latencyMs: 500 },
        { modelId: "claude", status: "ok", rawText: JSON.stringify(fixtureData), latencyMs: 500 },
      ];
      const output = await finalizeAdaptiveRun(schema, results, "A representative question for this schema", undefined, {
        ...CLASSIFICATION,
        queryType: schemaId,
        answerShape: schema.renderHint,
      });

      expect(output.persistedLegacyOutput).toBeDefined();
      const envelope = output.persistedLegacyOutput!;
      expect(envelope.version).toBe(1);
      expect(envelope.schemaId).toBe(schemaId);
      expect(envelope.classification.queryType).toBe(schemaId);
      // Existing structured fields all present — same shape procedural already proved out.
      expect(envelope.results).toBe(output.adaptiveResults);
      // creative_generative's early-return branch doesn't include
      // alignedClaims on `output` at all (there's nothing to align), so the
      // envelope's own `[]` has no live-response counterpart to compare
      // against for that one schema.
      if (schemaId !== "creative_generative") {
        expect(envelope.alignedClaims).toBe(output.alignedClaims);
      } else {
        expect(envelope.alignedClaims).toEqual([]);
      }
      expect(envelope.gate).toBe(output.gate);
      expect(envelope.synthesisReport).toBe(output.synthesisReport);
      expect(envelope.trustSummary).toBe(output.trustSummary);

      // Serialization round-trip (Part 9-C) — the exact transform Firestore
      // persistence + History reload puts every envelope through.
      const roundTripped = JSON.parse(JSON.stringify(envelope));
      const parsed = parsePersistedLegacyAdaptiveOutput(roundTripped);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.output.schemaId).toBe(schemaId);
        // creative_generative has no claim/metric/scenario/step fields, so
        // it never reaches gate/synthesisReport computation, live or
        // historical (see persistedOutput.ts's interface doc) — every
        // other schema in this family does.
        if (schemaId === "creative_generative") {
          expect(envelope.gate).toBeUndefined();
          expect(envelope.synthesisReport).toBeUndefined();
          expect(parsed.output.gate).toBeUndefined();
          expect(parsed.output.synthesisReport).toBeUndefined();
          expect(parsed.output.results.length).toBeGreaterThan(0);
        } else {
          expect(envelope.gate).toBeDefined();
          expect(envelope.synthesisReport).toBeDefined();
          expect(parsed.output.gate!.status).toBe(envelope.gate!.status);
          expect(parsed.output.synthesisReport!.unifiedAnswer).toBe(envelope.synthesisReport!.unifiedAnswer);
        }
      }
    }
  );

  it("never attaches persistedLegacyOutput for a Milestone-2 dedicated schema (comparison_matrix) — this envelope is deliberately scoped to the legacy-active family, never the Milestone-2 one", async () => {
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
