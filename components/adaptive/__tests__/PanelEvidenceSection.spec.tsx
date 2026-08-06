/**
 * Adaptive Synthesis Report, Phase 2 (3-schema pilot) — PanelEvidenceSection
 * structural tests. renderToStaticMarkup (no jsdom).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PanelEvidenceSection from "@/components/adaptive/PanelEvidenceSection";
import { AdaptiveGateResult, AdaptiveSynthesisReport, ComparisonMatrixResult } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function synthesisReportFixture(overrides: Partial<AdaptiveSynthesisReport> = {}): AdaptiveSynthesisReport {
  return {
    unifiedAnswer: "The panel's synthesized answer.",
    panelVerdict: "Panel converges on the core answer.",
    gate: "pass",
    runCertainty: 0.8,
    whereModelsAgree: [],
    whereModelsDisagree: [],
    certaintyAssessment: "Run certainty 80% (gate: pass).",
    narrativeSections: [],
    executiveSummary: "Executive summary of the run.",
    disagreements: [],
    biasAndBlindSpots: [],
    biasEmptyReason: "insufficient_models",
    panelCoverageGaps: [],
    diagnostics: {
      citedClaimCount: 0,
      totalClaimCount: 0,
      evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 },
      homogeneityFlag: false,
      meanAgreement: 0.8,
    },
    verdictCard: {
      question: "A question",
      topConsensus: "Models agree.",
      consensusModelCount: 1,
      keyDisagreement: null,
      disagreementDetail: null,
      disagreementModelCount: 0,
      caveat: null,
      recommendedNextSteps: [],
    },
    degraded: false,
    ...overrides,
  };
}

const gate: AdaptiveGateResult = { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, loadBearingClaims: [] };

describe("PanelEvidenceSection — comparison_matrix branch", () => {
  function comparisonMatrixFixture(overrides: Partial<ComparisonMatrixResult> = {}): ComparisonMatrixResult {
    return {
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
      cells: [],
      ...overrides,
    };
  }

  it("renders the agreement tally, disagreement rows, and sources for split cells", () => {
    const comparisonMatrix = comparisonMatrixFixture({
      cells: [
        {
          subjectId: "chatgpt",
          subject: "ChatGPT",
          attributeId: "price",
          attribute: "Price",
          valuesByModel: { chatgpt: "$20/mo", claude: "$25/mo" } as any,
          coverageCount: 2,
          totalModels: 2,
          coverageRatio: 1,
          agreement: "split",
          sources: ["openai.com/pricing"],
        },
      ],
    });

    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "comparison_matrix",
        comparisonMatrix,
        modelsUsed: ["chatgpt", "claude"] as ModelId[],
      })
    );

    expect(html).toMatch(/panel agreement/i);
    expect(html).toMatch(/split.*1/i);
    expect(html).toMatch(/where the panel disagrees/i);
    expect(html).toMatch(/\$20\/mo/);
    expect(html).toMatch(/\$25\/mo/);
    expect(html).toMatch(/sources cited/i);
    expect(html).toMatch(/openai\.com\/pricing/);
    // Pin against the exact regex an existing AdaptivePanelResponse test
    // asserts against (not.toMatch(/agreement.*disagreement map/i)) — this
    // copy choice must never accidentally collide with it.
    expect(html).not.toMatch(/disagreement map/i);
    // Deliberately excluded — already shown by ComparisonMatrixView itself.
    expect(html).not.toMatch(/direct conclusion/i);
    expect(html).not.toMatch(/unified answer/i);
  });

  it("renders no disagreement/sources sections when there are none", () => {
    const comparisonMatrix = comparisonMatrixFixture({
      cells: [
        {
          subjectId: "chatgpt",
          subject: "ChatGPT",
          attributeId: "price",
          attribute: "Price",
          valuesByModel: { chatgpt: "$20/mo" } as any,
          coverageCount: 1,
          totalModels: 1,
          coverageRatio: 1,
          agreement: "consensus",
        },
      ],
    });

    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "comparison_matrix",
        comparisonMatrix,
        modelsUsed: ["chatgpt"] as ModelId[],
      })
    );

    expect(html).toMatch(/consensus.*1/i);
    expect(html).not.toMatch(/where the panel disagrees/i);
    expect(html).not.toMatch(/sources cited/i);
  });
});

describe("PanelEvidenceSection — procedural/generic (gate + synthesisReport) branch", () => {
  it("renders the full evidence record (agreement/disagreement map, single-model insights, disagreements) — self-collapsed, and never duplicates Unified Answer/Panel Verdict (those now live in PrimarySynthesisStrip/ReviewGovernanceSection)", () => {
    const alignedClaims = [
      {
        id: "c1",
        claimText: "A claim both models agree on",
        cells: [
          { modelId: "chatgpt" as ModelId, stance: "agrees" as const, rawStance: "asserts" as const, confidence: "majority_view" as const, excerpt: "x" },
          { modelId: "claude" as ModelId, stance: "agrees" as const, rawStance: "asserts" as const, confidence: "majority_view" as const, excerpt: "y" },
        ],
        agreementScore: 1,
        certaintyScore: 1,
        status: "consensus" as const,
      },
      {
        id: "c2",
        claimText: "A claim only one model raised",
        cells: [{ modelId: "chatgpt" as ModelId, stance: "agrees" as const, rawStance: "asserts" as const, confidence: "majority_view" as const, excerpt: "z" }, null],
        agreementScore: 1,
        certaintyScore: 1,
        status: "single_source" as const,
      },
    ];

    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "generic",
        gate,
        synthesisReport: synthesisReportFixture(),
        alignedClaims,
        modelsUsed: ["chatgpt", "claude"] as ModelId[],
      })
    );

    expect(html).toMatch(/panel evidence/i);
    expect(html).toMatch(/agreement.*disagreement map/i);
    expect(html).toMatch(/single-model insights/i);
    // Unified Answer/Panel Verdict/the full-report fallback all moved out —
    // asserting their absence here pins that they're never duplicated.
    expect(html).not.toMatch(/unified answer/i);
    expect(html).not.toMatch(/panel verdict/i);
    expect(html).not.toMatch(/full synthesis report/i);
    // Collapsed by default.
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it("shows the Cross-model comparison ClaimMatrix block only when showClaimMatrix is true", () => {
    const alignedClaims = [
      {
        id: "c1",
        claimText: "A claim",
        cells: [{ modelId: "chatgpt" as ModelId, stance: "agrees" as const, rawStance: "asserts" as const, confidence: "majority_view" as const, excerpt: "x" }],
        agreementScore: 1,
        certaintyScore: 1,
        status: "consensus" as const,
      },
    ];

    const withMatrix = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "procedural",
        gate,
        synthesisReport: synthesisReportFixture(),
        alignedClaims,
        modelsUsed: ["chatgpt"] as ModelId[],
        showClaimMatrix: true,
      })
    );
    expect(withMatrix).toMatch(/cross-model comparison/i);

    const withoutMatrix = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "generic",
        gate,
        synthesisReport: synthesisReportFixture(),
        alignedClaims,
        modelsUsed: ["chatgpt"] as ModelId[],
        showClaimMatrix: false,
      })
    );
    expect(withoutMatrix).not.toMatch(/cross-model comparison/i);
  });

  it("renders trust summary only when provided", () => {
    const withTrust = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "generic",
        gate,
        synthesisReport: synthesisReportFixture(),
        trustSummary: { perModel: [{ modelId: "chatgpt" as ModelId, claimsContributed: 1, majorityAlignment: 1, citationScore: 1, contradictionCount: 0, parseHealth: "ok", trustScore: 0.9, capped: false }], overallTrust: 0.9 },
        modelsUsed: ["chatgpt"] as ModelId[],
      })
    );
    expect(withTrust).toMatch(/trust summary/i);
  });
});

describe("PanelEvidenceSection — no matching branch", () => {
  it("renders nothing when neither comparisonMatrix nor gate+synthesisReport are provided", () => {
    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "generic",
        modelsUsed: ["chatgpt"] as ModelId[],
      })
    );
    expect(html).toBe("");
  });
});
