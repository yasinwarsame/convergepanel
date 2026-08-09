/**
 * Adaptive Research Export, Phase 1 — buildExportSnapshot() tests.
 * Covers both schema families and the semantic safeguards Part 8
 * requires: creative consensus stays "Not scored" (never fabricated),
 * financial valuation isn't averaged (metric identity preserved, not
 * collapsed by this layer), forecast scenarios keep their real
 * probabilities (never invented), evidence coverage never becomes
 * "evidence strength" (reuses deriveSourceGrounding's own vocabulary,
 * never a new label).
 */

import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { AdaptiveModelResult, QueryClassification } from "@/lib/adaptiveSchema/types";
import { PersistedAdaptiveOutputV1, PersistedLegacyAdaptiveOutputV1 } from "@/lib/adaptiveSchema/persistedOutput";
import { ModelId } from "@/lib/types";

function classification(overrides: Partial<QueryClassification> = {}): QueryClassification {
  return {
    queryType: "comparison_matrix",
    domain: "test",
    answerShape: "comparison_grid",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence: 0.9,
    riskLevel: "professional",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: null,
    requiresClarification: false,
    rationale: "test",
    ...overrides,
  };
}

describe("buildExportSnapshot — Milestone-2 family", () => {
  function milestone2Output(): PersistedAdaptiveOutputV1 {
    return {
      version: 1,
      schemaId: "comparison_matrix",
      answerShape: "comparison_grid",
      classification: classification(),
      meta: {
        schemaVersion: 1,
        queryType: "comparison_matrix",
        answerShape: "comparison_grid",
        dataBasis: "mixed",
        freshness: "timeless",
        riskLevel: "professional",
        evidenceQuality: "moderate",
        uncertainties: [],
        blindSpots: [],
        humanReviewNeeded: false,
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      generatedAt: "2026-01-01T00:00:00.000Z",
      result: { subjects: [], attributes: [], cells: [], totalModels: 2, lowConfidenceSubjects: [], lowConfidenceAttributes: [], hasVerifiedSourceData: false },
    };
  }

  it("produces a milestone2 snapshot branch, never a legacy branch", () => {
    const { reportSnapshot } = buildExportSnapshot({
      question: "q",
      selectedModels: ["chatgpt", "claude"] as ModelId[],
      milestone2: { output: milestone2Output() },
    });
    expect(reportSnapshot.milestone2).toBeDefined();
    expect(reportSnapshot.legacy).toBeUndefined();
  });

  it("decisionReceipt is absent (not fabricated) when no GovernanceRecordV1 exists yet", () => {
    const { reportSnapshot, governanceStatusAtExport } = buildExportSnapshot({
      question: "q",
      selectedModels: ["chatgpt"] as ModelId[],
      milestone2: { output: milestone2Output() },
    });
    expect(reportSnapshot.milestone2?.decisionReceipt).toBeUndefined();
    expect(governanceStatusAtExport).toEqual({ family: "milestone2", kind: "incomplete", isOwnerOverride: false });
  });

  it("classification floor derives from riskLevel, never invented", () => {
    const { classification: cls } = buildExportSnapshot({
      question: "q",
      selectedModels: [] as ModelId[],
      milestone2: { output: { ...milestone2Output(), classification: classification({ riskLevel: "safety_critical" }) } },
    });
    expect(cls).toBe("restricted");
  });
});

describe("buildExportSnapshot — legacy family", () => {
  function legacyOutput(overrides: Partial<PersistedLegacyAdaptiveOutputV1> = {}): PersistedLegacyAdaptiveOutputV1 {
    return {
      version: 1,
      schemaId: "financial_valuation",
      classification: classification({ queryType: "financial_valuation", riskLevel: "professional" }),
      generatedAt: "2026-01-01T00:00:00.000Z",
      results: [
        { modelId: "chatgpt" as ModelId, schemaId: "financial_valuation", ok: true, data: { thesis: "x", metrics: [{ label: "P/E", value: 18, unit: "x", asOf: "2026" }] } },
        { modelId: "claude" as ModelId, schemaId: "financial_valuation", ok: true, data: { thesis: "y", metrics: [{ label: "P/E", value: 22, unit: "x", asOf: "2026" }] } },
      ] as AdaptiveModelResult[],
      alignedClaims: [],
      ...overrides,
    };
  }

  it("financial_valuation: both models' metric values are preserved verbatim in the snapshot's modelResponses — this layer never averages/collapses them", () => {
    const { reportSnapshot } = buildExportSnapshot({
      question: "q",
      selectedModels: ["chatgpt", "claude"] as ModelId[],
      legacy: { output: legacyOutput(), governanceStatus: "needs_review" },
    });
    const responses = reportSnapshot.legacy?.modelResponses;
    expect(responses).toHaveLength(2);
    expect((responses?.[0].data as any).metrics[0].value).toBe(18);
    expect((responses?.[1].data as any).metrics[0].value).toBe(22);
    // No averaged/blended value anywhere in the snapshot.
    expect(JSON.stringify(reportSnapshot)).not.toMatch(/"value":20\b/);
  });

  it("creative_generative (alignedClaims=[], gate/synthesisReport absent): consensus/source-grounding stay 'unscored' — never fabricated", () => {
    const { reportSnapshot } = buildExportSnapshot({
      question: "q",
      selectedModels: ["chatgpt", "claude"] as ModelId[],
      legacy: {
        output: legacyOutput({ schemaId: "creative_generative", classification: classification({ queryType: "creative_generative" }) }),
        governanceStatus: "needs_review",
      },
    });
    expect(reportSnapshot.consensusLevel).toBe("unscored");
    expect(reportSnapshot.sourceGroundingLevel).toBe("unscored");
    expect(reportSnapshot.legacy?.synthesisReport).toBeUndefined();
  });

  it("forecast_speculative: a real gate/synthesisReport is passed through verbatim — no probability is invented at this layer", () => {
    const gate = { status: "caution" as const, runCertainty: 0.6, loadBearingSplitCount: 0, loadBearingClaims: [] };
    const synthesisReport = {
      unifiedAnswer: "Panel split on the baseline scenario.",
      panelVerdict: "caution",
      gate: "caution" as const,
      runCertainty: 0.6,
      whereModelsAgree: [],
      whereModelsDisagree: [],
      certaintyAssessment: "60%",
      narrativeSections: [],
      executiveSummary: "x",
      disagreements: [],
      biasAndBlindSpots: [],
      biasEmptyReason: "insufficient_models" as const,
      panelCoverageGaps: [],
      diagnostics: { citedClaimCount: 0, totalClaimCount: 0, evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 }, homogeneityFlag: false, meanAgreement: 0.6 },
      verdictCard: { question: "q", topConsensus: "x", consensusModelCount: 1, keyDisagreement: null, disagreementDetail: null, disagreementModelCount: 0, caveat: null, recommendedNextSteps: [] },
      degraded: false,
    };
    const { reportSnapshot } = buildExportSnapshot({
      question: "q",
      selectedModels: ["chatgpt"] as ModelId[],
      legacy: {
        output: legacyOutput({
          schemaId: "forecast_speculative",
          classification: classification({ queryType: "forecast_speculative" }),
          alignedClaims: [{ id: "c1", claimText: "x", cells: [], agreementScore: 0.5, certaintyScore: 0.6, status: "split" }],
          gate,
          synthesisReport,
        }),
        governanceStatus: "needs_review",
      },
    });
    expect(reportSnapshot.legacy?.gate?.runCertainty).toBe(0.6);
    expect(reportSnapshot.legacy?.synthesisReport?.unifiedAnswer).toBe("Panel split on the baseline scenario.");
  });

  it("evidence coverage vocabulary never becomes 'evidence strength' — the snapshot's field is literally sourceGroundingLevel, reusing reportSummary.ts's own tiers, no new label invented", () => {
    const { reportSnapshot } = buildExportSnapshot({
      question: "q",
      selectedModels: ["chatgpt"] as ModelId[],
      legacy: { output: legacyOutput(), governanceStatus: "needs_review" },
    });
    expect(["strong", "moderate", "weak", "unscored"]).toContain(reportSnapshot.sourceGroundingLevel);
  });

  it("legacy governance status is the real 3-value model, never coerced into the 8-status vocabulary", () => {
    const { governanceStatusAtExport } = buildExportSnapshot({
      question: "q",
      selectedModels: [] as ModelId[],
      legacy: { output: legacyOutput(), governanceStatus: "blocked" },
    });
    expect(governanceStatusAtExport).toEqual({ family: "legacy", status: "blocked" });
  });

  it("throws when neither milestone2 nor legacy input is provided — never silently produces an empty snapshot", () => {
    expect(() => buildExportSnapshot({ question: "q", selectedModels: [] as ModelId[] })).toThrow();
  });
});
