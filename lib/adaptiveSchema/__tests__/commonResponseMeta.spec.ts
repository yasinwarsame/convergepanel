/**
 * Query-Routing Redesign, Phase 1 — buildCommonResponseMeta() and its
 * source-coverage/human-review/limitation adapters.
 *
 * Covers: honest totalModels/successfulModels/failedModels/
 * modelsWithUsableOutput counting (a connector success with malformed
 * adaptive JSON does not count as usable), executionStatus in all three
 * states, schema-correct source coverage (unit-level where real units
 * exist, sourceBacked-only where they don't — never fabricated precision),
 * sourceBacked:false preserved rather than omitted, requiresHumanReview
 * never derived from model agreement/count alone, and limitation dedup.
 */

import { buildCommonResponseMeta, getAdaptiveHumanReviewSignals, getAdaptiveSourceCoverage } from "@/lib/adaptiveSchema/commonResponseMeta";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { QueryClassification, RankedEnumerationResult, DecisionSupportResult, CausalExplanationResult, DefinitionExplanationResult, EvidenceReviewResult } from "@/lib/adaptiveSchema/types";
import { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";
import { ModelResult } from "@/lib/types";

function classification(overrides: Partial<QueryClassification> = {}): QueryClassification {
  return {
    queryType: "decision_support",
    domain: "test",
    answerShape: "decision_support_view",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "make_decision",
    confidence: 0.9,
    riskLevel: "professional",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: null,
    requiresClarification: false,
    rationale: "test fixture",
    ...overrides,
  };
}

function modelResult(modelId: string, status: ModelResult["status"] = "ok"): ModelResult {
  return { modelId: modelId as any, status, rawText: status === "ok" ? "{}" : null, latencyMs: 5 };
}

function adaptiveResult(modelId: string, ok: boolean): AdaptiveModelResult {
  return { modelId: modelId as any, schemaId: "decision_support", ok, data: ok ? {} : null };
}

const MINIMAL_DECISION_SUPPORT: DecisionSupportResult = {
  decisionQuestion: "x",
  options: [],
  criteria: [],
  assessments: [],
  recommendation: { action: "go", rationale: "x", caveats: [], isContested: false, supportCount: 2, totalModelsWithRecommendation: 2 },
  assumptions: [],
  uncertainties: [],
  risks: [],
  sensitivityFindings: [],
  humanReviewNeeded: false,
  sourceBacked: false,
  totalModels: 2,
};

describe("buildCommonResponseMeta — model counting", () => {
  it("totalModels includes every selected model, even ones the connector failed on", () => {
    const modelResults = [modelResult("chatgpt", "ok"), modelResult("claude", "error"), modelResult("grok", "timeout")];
    const adaptiveResults = [adaptiveResult("chatgpt", true), adaptiveResult("claude", false), adaptiveResult("grok", false)];
    const meta = buildCommonResponseMeta({
      schema: SCHEMA_REGISTRY.decision_support,
      classification: classification(),
      modelResults,
      adaptiveResults,
      schemaResult: MINIMAL_DECISION_SUPPORT,
    });
    expect(meta.totalModels).toBe(3);
    expect(meta.successfulModels).toBe(1);
    expect(meta.failedModels).toBe(2);
  });

  it("a connector success with malformed/unparseable adaptive JSON does not count as usable output", () => {
    const modelResults = [modelResult("chatgpt", "ok"), modelResult("claude", "ok")];
    // Both connectors succeeded, but only one produced valid adaptive JSON.
    const adaptiveResults = [adaptiveResult("chatgpt", true), adaptiveResult("claude", false)];
    const meta = buildCommonResponseMeta({
      schema: SCHEMA_REGISTRY.decision_support,
      classification: classification(),
      modelResults,
      adaptiveResults,
      schemaResult: MINIMAL_DECISION_SUPPORT,
    });
    expect(meta.successfulModels).toBe(2);
    expect(meta.modelsWithUsableOutput).toBe(1);
  });

  it("substituted connector results count as successful, matching the existing convention elsewhere", () => {
    const modelResults = [modelResult("chatgpt", "substituted")];
    const adaptiveResults = [adaptiveResult("chatgpt", true)];
    const meta = buildCommonResponseMeta({
      schema: SCHEMA_REGISTRY.decision_support,
      classification: classification(),
      modelResults,
      adaptiveResults,
      schemaResult: MINIMAL_DECISION_SUPPORT,
    });
    expect(meta.successfulModels).toBe(1);
  });
});

describe("buildCommonResponseMeta — executionStatus", () => {
  const base = { schema: SCHEMA_REGISTRY.decision_support, classification: classification(), schemaResult: MINIMAL_DECISION_SUPPORT };

  it("'completed' when every selected model succeeded and produced usable output", () => {
    const meta = buildCommonResponseMeta({
      ...base,
      modelResults: [modelResult("chatgpt"), modelResult("claude")],
      adaptiveResults: [adaptiveResult("chatgpt", true), adaptiveResult("claude", true)],
    });
    expect(meta.executionStatus).toBe("completed");
  });

  it("'partial' when at least one usable output exists but not every model succeeded", () => {
    const meta = buildCommonResponseMeta({
      ...base,
      modelResults: [modelResult("chatgpt"), modelResult("claude", "error")],
      adaptiveResults: [adaptiveResult("chatgpt", true), adaptiveResult("claude", false)],
    });
    expect(meta.executionStatus).toBe("partial");
  });

  it("'failed' when no usable adaptive structured output exists at all", () => {
    const meta = buildCommonResponseMeta({
      ...base,
      modelResults: [modelResult("chatgpt", "error"), modelResult("claude", "error")],
      adaptiveResults: [adaptiveResult("chatgpt", false), adaptiveResult("claude", false)],
    });
    expect(meta.executionStatus).toBe("failed");
  });

  it("generatedAt is a stable, parseable ISO timestamp", () => {
    const meta = buildCommonResponseMeta({
      ...base,
      modelResults: [modelResult("chatgpt")],
      adaptiveResults: [adaptiveResult("chatgpt", true)],
    });
    expect(() => new Date(meta.generatedAt).toISOString()).not.toThrow();
    expect(new Date(meta.generatedAt).toISOString()).toBe(meta.generatedAt);
  });
});

describe("getAdaptiveSourceCoverage — schema-correct, never fabricated precision", () => {
  it("ranked_enumeration: computes real unit-level coverage from item.sources", () => {
    const result: RankedEnumerationResult = {
      items: [
        { id: "a", label: "A", panelRank: 1, coverageCount: 2, totalModels: 2, coverageRatio: 1, sourceRanks: {}, sources: ["X"] },
        { id: "b", label: "B", panelRank: 2, coverageCount: 1, totalModels: 2, coverageRatio: 0.5, sourceRanks: {} },
      ],
      lowConfidenceItems: [],
      requestedCount: null,
      actualCount: 2,
      rankCorrelation: null,
      hasLiveQueryLogData: false,
      totalModels: 2,
    };
    const coverage = getAdaptiveSourceCoverage("ranked_enumeration", result);
    expect(coverage.sourceBacked).toBe(true);
    expect(coverage.sourceCoverage).toEqual({ supportedUnits: 1, totalUnits: 2, ratio: 0.5 });
  });

  it("checklist_taxonomy: honestly reports sourceBacked false and omits sourceCoverage — no item-level source signal exists for this schema", () => {
    const coverage = getAdaptiveSourceCoverage("checklist_taxonomy", { summary: "", categories: [], lowConfidenceItems: [], notes: [], totalModels: 2 } as any);
    expect(coverage.sourceBacked).toBe(false);
    expect(coverage.sourceCoverage).toBeUndefined();
  });

  it("evidence_review: uses the response-level sourceBacked boolean without fabricating per-dimension precision", () => {
    const result: EvidenceReviewResult = {
      overallAssessment: "x",
      overallStrength: "unknown",
      dimensions: [],
      lowConfidenceDimensions: [],
      redFlags: [],
      strengths: [],
      applicabilityCaveats: [],
      recommendedChecks: [],
      sourceBacked: false,
      totalModels: 2,
    };
    const coverage = getAdaptiveSourceCoverage("evidence_review", result);
    expect(coverage.sourceBacked).toBe(false);
    expect(coverage.sourceCoverage).toBeUndefined();
  });
});

describe("requiresHumanReview — real signals only, never model agreement/count alone", () => {
  it("is true for high_stakes/safety_critical riskLevel regardless of schema", () => {
    const flag = getAdaptiveHumanReviewSignals("checklist_taxonomy", classification({ riskLevel: "safety_critical" }), {
      summary: "",
      categories: [],
      lowConfidenceItems: [],
      notes: [],
      totalModels: 2,
    } as any);
    expect(flag).toBe(true);
  });

  it("is NOT set merely because only some of the selected models produced output (2 of 5) when nothing else signals review", () => {
    const flag = getAdaptiveHumanReviewSignals("checklist_taxonomy", classification({ riskLevel: "professional" }), {
      summary: "",
      categories: [],
      lowConfidenceItems: [],
      notes: [],
      totalModels: 5,
    } as any);
    expect(flag).toBe(false);
  });

  it("is true for definition_explanation when the panel produced a materially ambiguous result", () => {
    const result: DefinitionExplanationResult = {
      primary: { coverageCount: 1, totalModels: 2, coverageRatio: 0.5, contributingModels: [], term: "x", directAnswer: "a", explanation: "a", keyPoints: [], distinctions: [], processSteps: [], commonMisconceptions: [], relatedConcepts: [], sources: [] },
      alternateInterpretations: [{ coverageCount: 1, totalModels: 2, coverageRatio: 0.5, contributingModels: [], term: "x", directAnswer: "b", explanation: "b", keyPoints: [], distinctions: [], processSteps: [], commonMisconceptions: [], relatedConcepts: [], sources: [] }],
      isAmbiguous: true,
      sourceBacked: false,
      totalModels: 2,
    };
    const flag = getAdaptiveHumanReviewSignals("definition_explanation", classification({ riskLevel: "casual" }), result);
    expect(flag).toBe(true);
  });

  it("is true for causal_explanation when a factor is genuinely contested (not merely low-coverage)", () => {
    const result: CausalExplanationResult = {
      directAnswer: "x",
      factors: [
        {
          id: "a",
          label: "Factor",
          category: "direct_cause",
          coverageCount: 2,
          totalModels: 2,
          coverageRatio: 1,
          contributingModels: [],
          evidenceStrength: "contested",
          sourceBacked: false,
        },
      ],
      causalChain: [],
      confounders: [],
      disputedInterpretations: [],
      unknowns: [],
      testsOrEvidenceNeeded: [],
      sourceBacked: false,
      totalModels: 2,
    };
    const flag = getAdaptiveHumanReviewSignals("causal_explanation", classification({ riskLevel: "casual" }), result);
    expect(flag).toBe(true);
  });

  it("decision_support reuses the schema's own already-computed humanReviewNeeded rather than recomputing it", () => {
    const flagTrue = getAdaptiveHumanReviewSignals("decision_support", classification({ riskLevel: "casual" }), {
      ...MINIMAL_DECISION_SUPPORT,
      humanReviewNeeded: true,
    });
    const flagFalse = getAdaptiveHumanReviewSignals("decision_support", classification({ riskLevel: "casual" }), {
      ...MINIMAL_DECISION_SUPPORT,
      humanReviewNeeded: false,
    });
    expect(flagTrue).toBe(true);
    expect(flagFalse).toBe(false);
  });
});

describe("buildCommonResponseMeta — limitations", () => {
  it("deduplicates identical limitation strings", () => {
    const result: DecisionSupportResult = {
      ...MINIMAL_DECISION_SUPPORT,
      recommendation: { ...MINIMAL_DECISION_SUPPORT.recommendation, caveats: ["Same caveat.", "Same caveat."] },
    };
    const meta = buildCommonResponseMeta({
      schema: SCHEMA_REGISTRY.decision_support,
      classification: classification(),
      modelResults: [modelResult("chatgpt"), modelResult("claude")],
      adaptiveResults: [adaptiveResult("chatgpt", true), adaptiveResult("claude", true)],
      schemaResult: result,
    });
    const occurrences = meta.limitations!.filter((l) => l === "Same caveat.").length;
    expect(occurrences).toBe(1);
  });

  it("adds a concrete, computed statement about incomplete model output — never generic boilerplate", () => {
    const meta = buildCommonResponseMeta({
      schema: SCHEMA_REGISTRY.decision_support,
      classification: classification(),
      modelResults: [modelResult("chatgpt"), modelResult("claude", "error")],
      adaptiveResults: [adaptiveResult("chatgpt", true), adaptiveResult("claude", false)],
      schemaResult: MINIMAL_DECISION_SUPPORT,
    });
    expect(meta.limitations!.some((l) => l.includes("1 of 2 selected models did not produce usable structured output"))).toBe(true);
    expect(meta.limitations!.some((l) => /ai can make mistakes/i.test(l))).toBe(false);
  });
});
