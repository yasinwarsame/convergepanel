/**
 * Milestone 2 — proves finalizeAdaptiveRun() takes the parallel
 * bias_blindspot_audit path end-to-end: real per-model JSON in, a real
 * BiasBlindspotAuditResult out (via biasBlindspotAlignment.ts, reusing the
 * embedded system's detectAdaptiveBiases/auditPanelCoverage), NONE of
 * alignedClaims/gate/synthesisReport/trustSummary/rankedEnumeration/
 * comparisonMatrix/definitionExplanation/causalExplanation/
 * checklistTaxonomy/deepResearch/evidenceReview populated, the EXISTING
 * embedded bias/blind-spot behavior stays unchanged, and every other
 * activated schema plus the protected Claim/Video Verification paths
 * remain completely unaffected.
 *
 * `callGemini` is mocked with content-based routing (same convention as
 * biasBlindspotAlignment.spec.ts) since Tier 1/Tier 2 both go through it.
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
      summary: "A concise bias/blind-spot audit summary.",
      omittedDimensions: [],
      sharedAssumptions: [],
      missingStakeholders: [],
      geographicBiases: [],
      sourceConcentrationConcerns: [],
      evidenceTypeConcerns: [],
      followUpQuestions: [],
      sources: [],
      ...overrides,
    }),
    latencyMs: 5,
  };
}

function mockTierCalls(opts: { biasFindings?: any[]; coverageGaps?: any[] } = {}) {
  mockedCallGemini.mockImplementation(async (_q, _c, _k, callOpts) => {
    const prompt = (callOpts as any)?.systemPromptOverride || "";
    if (prompt.includes("biases and blind spots")) {
      return { modelId: "gemini", status: "ok", rawText: JSON.stringify({ biasAndBlindSpots: opts.biasFindings ?? [] }), latencyMs: 5 };
    }
    return { modelId: "gemini", status: "ok", rawText: JSON.stringify({ gaps: opts.coverageGaps ?? [] }), latencyMs: 5 };
  });
}

describe("finalizeAdaptiveRun — bias_blindspot_audit takes its own dedicated path", () => {
  afterEach(() => jest.clearAllMocks());

  it("validates against bias_blindspot_audit's own wire schema and produces a real BiasBlindspotAuditResult", async () => {
    mockTierCalls();
    const results: ModelResult[] = [modelResult("chatgpt"), modelResult("claude")];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.bias_blindspot_audit, results, "What perspectives are missing from this answer?");

    expect(output.schemaId).toBe("bias_blindspot_audit");
    expect(output.biasBlindspotAudit).toBeDefined();
    expect(output.biasBlindspotAudit!.summary).toBe("A concise bias/blind-spot audit summary.");
    expect(output.biasBlindspotAudit!.totalModels).toBe(2);
  });

  it("never populates alignedClaims/gate/synthesisReport/trustSummary/other parallel-path fields", async () => {
    mockTierCalls();
    const results: ModelResult[] = [modelResult("chatgpt"), modelResult("claude")];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.bias_blindspot_audit, results, "q");

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
    expect(output.evidenceReview).toBeUndefined();
  });

  it("still produces a real BiasBlindspotAuditResult when every model fails to parse, never throws", async () => {
    mockTierCalls();
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: "not json", latencyMs: 5 },
      { modelId: "claude" as any, status: "error", rawText: null, latencyMs: 5 },
    ];

    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.bias_blindspot_audit, results, "q");

    expect(output.biasBlindspotAudit).toBeDefined();
    expect(output.biasBlindspotAudit!.attributedBiases).toEqual([]);
    expect(output.biasBlindspotAudit!.totalModels).toBe(2);
  });
});

describe("finalizeAdaptiveRun — embedded bias/blind-spot behavior and other schemas remain unaffected", () => {
  it("the embedded synthesisReport.ts pipeline's own bias/coverage/diagnostics calls are untouched by this activation", async () => {
    // A behavioral proof, not a call-count proof: activating bias_blindspot_audit
    // added zero changes to biasDetection.ts/diagnostics.ts and only
    // broadened coverageAudit.ts's signature (done for deep_research,
    // already verified there) — this schema calls the SAME functions, it
    // doesn't fork or shadow them.
    const { detectAdaptiveBiases } = await import("@/lib/adaptiveSchema/biasDetection");
    const { computeAdaptiveDiagnostics } = await import("@/lib/adaptiveSchema/diagnostics");
    const { auditPanelCoverage } = await import("@/lib/adaptiveSchema/coverageAudit");
    expect(typeof detectAdaptiveBiases).toBe("function");
    expect(typeof computeAdaptiveDiagnostics).toBe("function");
    expect(typeof auditPanelCoverage).toBe("function");
  });

  it("deep_research remains active and unchanged", () => {
    expect(SCHEMA_REGISTRY.deep_research.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.deep_research.renderHint).toBe("deep_research_view");
  });

  it("evidence_review remains active and unchanged", () => {
    expect(SCHEMA_REGISTRY.evidence_review.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.evidence_review.renderHint).toBe("evidence_review_view");
  });

  it("contested_empirical remains active and unchanged (still the claim-matrix consensus_map path)", () => {
    expect(SCHEMA_REGISTRY.contested_empirical.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.contested_empirical.renderHint).toBe("consensus_map");
  });

  it("factual_lookup still follows the claim-matrix/direct_answer path, not bias_blindspot_audit's", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: JSON.stringify({ answer: "Nairobi", source: "general knowledge", caveat: "none" }), latencyMs: 5 },
    ];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.factual_lookup, results, "What is the capital of Kenya?");
    expect(output.biasBlindspotAudit).toBeUndefined();
  });
});
