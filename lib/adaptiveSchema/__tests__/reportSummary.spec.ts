/**
 * Adaptive Synthesis Report, Phase 1 — reportSummary.ts tests. Covers
 * getReportTypeLabel/deriveConsensusLevel/deriveSourceGrounding — every
 * derivation reads an already-computed per-schema signal, never a new
 * alignment pass (see the module's own doc for the full per-schema map).
 */

import {
  deriveConsensusLevel,
  deriveSourceGrounding,
  deriveTotalModelsFromSchemaResult,
  getReportTypeLabel,
} from "@/lib/adaptiveSchema/reportSummary";
import { buildChecklistTaxonomyResult, ChecklistTaxonomyFields } from "@/lib/adaptiveSchema/checklistAlignment";
import { ChecklistItem } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function checklistItem(overrides: Partial<ChecklistItem> & { id: string; label: string }): ChecklistItem {
  return { ...overrides };
}

describe("getReportTypeLabel", () => {
  it("returns the schema's fixed label for non-checklist schemas", () => {
    expect(getReportTypeLabel("comparison_matrix")).toBe("Comparison Report");
    expect(getReportTypeLabel("decision_support")).toBe("Recommendation Memo");
    expect(getReportTypeLabel("factual_lookup")).toBe("Direct Answer");
    expect(getReportTypeLabel("forecast_speculative")).toBe("Trend Analysis");
  });

  it("labels checklist_taxonomy as Risk Analysis when the result is risk-shaped", () => {
    const result = buildChecklistTaxonomyResult([
      {
        modelId: "chatgpt" as ModelId,
        fields: {
          summary: "",
          items: [checklistItem({ id: "a", label: "A", severity: "high" }), checklistItem({ id: "b", label: "B", severity: "low" })],
          notes: [],
        },
      },
    ]);
    expect(getReportTypeLabel("checklist_taxonomy", result)).toBe("Risk Analysis");
  });

  it("labels checklist_taxonomy as plain Checklist when not risk-shaped", () => {
    const result = buildChecklistTaxonomyResult([
      { modelId: "chatgpt" as ModelId, fields: { summary: "", items: [checklistItem({ id: "a", label: "A" })], notes: [] } },
    ]);
    expect(getReportTypeLabel("checklist_taxonomy", result)).toBe("Checklist");
  });

  it("labels checklist_taxonomy as plain Checklist when no result is supplied at all", () => {
    expect(getReportTypeLabel("checklist_taxonomy")).toBe("Checklist");
  });

  it("falls back to a generic label for an unmapped queryType rather than throwing", () => {
    expect(getReportTypeLabel("graceful_limitation")).toBe("Research Report");
  });
});

describe("deriveConsensusLevel", () => {
  const base = { schemaId: "comparison_matrix" as const };

  it("returns unscored when nothing is supplied", () => {
    expect(deriveConsensusLevel(base)).toBe("unscored");
  });

  it("comparison_matrix: tiers from the consensus/majority vs split/single_source cell ratio", () => {
    const strong = deriveConsensusLevel({
      ...base,
      comparisonMatrix: {
        subjects: [],
        lowConfidenceSubjects: [],
        attributes: [],
        lowConfidenceAttributes: [],
        totalModels: 2,
        hasVerifiedSourceData: false,
        directConclusion: "",
        tradeoffs: [],
        bestUseRecommendations: [],
        uncertainties: [],
        cells: [
          { subjectId: "s", subject: "S", attributeId: "a", attribute: "A", valuesByModel: {} as any, coverageCount: 2, totalModels: 2, coverageRatio: 1, agreement: "consensus" },
          { subjectId: "s2", subject: "S2", attributeId: "a", attribute: "A", valuesByModel: {} as any, coverageCount: 2, totalModels: 2, coverageRatio: 1, agreement: "majority" },
        ],
      },
    });
    expect(strong).toBe("strong");
  });

  it("decision_support: isContested forces split regardless of support ratio", () => {
    const level = deriveConsensusLevel({
      ...base,
      decisionSupport: {
        decisionQuestion: "",
        options: [],
        criteria: [],
        assessments: [],
        recommendation: { action: "escalate", rationale: "", caveats: [], isContested: true, supportCount: 4, totalModelsWithRecommendation: 5 },
        assumptions: [],
        uncertainties: [],
        risks: [],
        sensitivityFindings: [],
        humanReviewNeeded: false,
        sourceBacked: false,
        totalModels: 5,
      },
    });
    expect(level).toBe("split");
  });

  it("evidence_review: reuses overallStrength directly", () => {
    const strengthToLevel = (overallStrength: "strong" | "moderate" | "weak" | "contested" | "unknown") =>
      deriveConsensusLevel({
        ...base,
        evidenceReview: {
          overallAssessment: "",
          overallStrength,
          dimensions: [],
          lowConfidenceDimensions: [],
          redFlags: [],
          strengths: [],
          applicabilityCaveats: [],
          recommendedChecks: [],
          sourceBacked: false,
          totalModels: 1,
        },
      });
    expect(strengthToLevel("strong")).toBe("strong");
    expect(strengthToLevel("contested")).toBe("split");
    expect(strengthToLevel("unknown")).toBe("unscored");
  });

  it("ranked_enumeration: unscored when rankCorrelation is null", () => {
    const level = deriveConsensusLevel({
      ...base,
      rankedEnumeration: { items: [], lowConfidenceItems: [], requestedCount: null, actualCount: 0, rankCorrelation: null, hasLiveQueryLogData: false, totalModels: 1 },
    });
    expect(level).toBe("unscored");
  });

  it("original-9 family: falls back to gate.status when no per-schema result is present", () => {
    expect(deriveConsensusLevel({ ...base, gate: { status: "pass", runCertainty: 0.9, loadBearingSplitCount: 0, loadBearingClaims: [] } })).toBe("strong");
    expect(deriveConsensusLevel({ ...base, gate: { status: "caution", runCertainty: 0.5, loadBearingSplitCount: 1, loadBearingClaims: [] } })).toBe("moderate");
    expect(deriveConsensusLevel({ ...base, gate: { status: "fail", runCertainty: 0.1, loadBearingSplitCount: 2, loadBearingClaims: [] } })).toBe("weak");
  });

  it("prefers a per-schema signal over gate when both happen to be present", () => {
    const level = deriveConsensusLevel({
      ...base,
      gate: { status: "fail", runCertainty: 0.1, loadBearingSplitCount: 2, loadBearingClaims: [] },
      evidenceReview: {
        overallAssessment: "",
        overallStrength: "strong",
        dimensions: [],
        lowConfidenceDimensions: [],
        redFlags: [],
        strengths: [],
        applicabilityCaveats: [],
        recommendedChecks: [],
        sourceBacked: false,
        totalModels: 1,
      },
    });
    expect(level).toBe("strong");
  });
});

describe("deriveSourceGrounding", () => {
  it("returns unscored when nothing is supplied", () => {
    expect(deriveSourceGrounding({})).toBe("unscored");
  });

  it("tiers from meta.sourceCoverage.ratio when a real per-unit ratio exists", () => {
    expect(
      deriveSourceGrounding({ meta: { sourceCoverage: { supportedUnits: 9, totalUnits: 10, ratio: 0.9 } } as any })
    ).toBe("strong");
  });

  it("falls back to the response-level sourceBacked boolean, tiered at moderate/weak, when no per-unit ratio exists", () => {
    expect(deriveSourceGrounding({ meta: { sourceBacked: true } as any })).toBe("moderate");
    expect(deriveSourceGrounding({ meta: { sourceBacked: false } as any })).toBe("weak");
  });

  it("falls back to trustSummary.overallTrust for the original-9/factual_lookup family (no meta at all)", () => {
    expect(deriveSourceGrounding({ trustSummary: { perModel: [], overallTrust: 0.8 } })).toBe("strong");
    expect(deriveSourceGrounding({ trustSummary: { perModel: [], overallTrust: 0.1 } })).toBe("weak");
  });

  it("prefers meta over trustSummary when both are present", () => {
    expect(
      deriveSourceGrounding({
        meta: { sourceCoverage: { supportedUnits: 1, totalUnits: 10, ratio: 0.1 } } as any,
        trustSummary: { perModel: [], overallTrust: 0.9 },
      })
    ).toBe("weak");
  });
});

describe("deriveTotalModelsFromSchemaResult", () => {
  it("returns null when no per-schema result is supplied", () => {
    expect(deriveTotalModelsFromSchemaResult({})).toBeNull();
  });

  it("reads totalModels off whichever per-schema result is present", () => {
    expect(
      deriveTotalModelsFromSchemaResult({
        evidenceReview: {
          overallAssessment: "",
          overallStrength: "strong",
          dimensions: [],
          lowConfidenceDimensions: [],
          redFlags: [],
          strengths: [],
          applicabilityCaveats: [],
          recommendedChecks: [],
          sourceBacked: false,
          totalModels: 3,
        },
      })
    ).toBe(3);
  });
});
