/**
 * Adaptive Synthesis Report, Phase 2 (3-schema pilot) — PanelEvidenceSection
 * structural tests. renderToStaticMarkup (no jsdom).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PanelEvidenceSection from "@/components/adaptive/PanelEvidenceSection";
import {
  AdaptiveGateResult,
  AdaptiveSynthesisReport,
  CausalExplanationResult,
  ComparisonMatrixResult,
  DecisionSupportResult,
  DeepResearchResult,
  DefinitionExplanationResult,
} from "@/lib/adaptiveSchema/types";
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

describe("PanelEvidenceSection — Phase 2A batch 1 (deep_research/decision_support/causal_explanation/definition_explanation)", () => {
  function deepResearchFixture(overrides: Partial<DeepResearchResult> = {}): DeepResearchResult {
    return {
      executiveSummary: "Remote work modestly reduces measured productivity.",
      findings: [
        { id: "f1", title: "Finding A", summary: "s", category: "General", evidenceStrength: "strong", sourceBacked: true, coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: ["chatgpt", "claude"] as any },
        { id: "f2", title: "Finding B", summary: "s2", category: "General", evidenceStrength: "contested", sourceBacked: false, coverageCount: 1, totalModels: 2, coverageRatio: 0.5, contributingModels: ["chatgpt"] as any },
      ],
      lowConfidenceFindings: [],
      disagreements: [],
      evidenceGaps: [],
      openQuestions: [],
      panelBlindSpots: [],
      researchBoundaries: [],
      recommendedNextSteps: [],
      sourceCoverage: { findingsWithSources: 1, totalFindings: 2, coverageRatio: 0.5 },
      totalModels: 2,
      ...overrides,
    };
  }

  it("deep_research: tallies findings by evidence strength and notes when there are no disagreements", () => {
    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "deep_research",
        deepResearch: deepResearchFixture(),
        modelsUsed: ["chatgpt", "claude"] as ModelId[],
      })
    );
    expect(html).toMatch(/finding evidence strength/i);
    expect(html).toMatch(/strong.*1/i);
    expect(html).toMatch(/contested.*1/i);
    expect(html).toMatch(/did not flag any material disagreements/i);
  });

  it("deep_research: lists lower-confidence findings in full (not just a count) when present", () => {
    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "deep_research",
        deepResearch: deepResearchFixture({
          lowConfidenceFindings: [
            { id: "lc1", title: "Rare finding", summary: "Raised by only one model.", category: "General", evidenceStrength: "unknown", sourceBacked: false, coverageCount: 1, totalModels: 3, coverageRatio: 0.33, contributingModels: ["chatgpt"] as any },
          ],
        }),
        modelsUsed: ["chatgpt", "claude", "grok"] as ModelId[],
      })
    );
    expect(html).toMatch(/lower-confidence findings/i);
    expect(html).toContain("Rare finding");
    expect(html).toContain("Raised by only one model.");
  });

  function decisionSupportFixture(overrides: Partial<DecisionSupportResult> = {}): DecisionSupportResult {
    return {
      decisionQuestion: "Which CRM should we choose?",
      options: [{ id: "o1", label: "Option A", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: ["chatgpt", "claude"] as any }],
      criteria: [{ id: "c1", label: "Cost", source: "user", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: ["chatgpt", "claude"] as any }],
      assessments: [
        { optionId: "o1", criterionId: "c1", assessment: "Affordable", evidenceStrength: "strong", coverageCount: 2, totalModels: 2, contributingModels: ["chatgpt", "claude"] as any },
      ],
      recommendation: { action: "go", rationale: "Strong fit.", caveats: [], isContested: false, supportCount: 2, totalModelsWithRecommendation: 2 },
      assumptions: [],
      uncertainties: [],
      risks: [],
      sensitivityFindings: [],
      humanReviewNeeded: false,
      sourceBacked: true,
      totalModels: 2,
      ...overrides,
    };
  }

  it("decision_support: tallies option×criterion assessments by evidence strength and reports convergence", () => {
    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "decision_support",
        decisionSupport: decisionSupportFixture(),
        modelsUsed: ["chatgpt", "claude"] as ModelId[],
      })
    );
    expect(html).toMatch(/assessment evidence strength/i);
    expect(html).toMatch(/strong.*1/i);
    expect(html).toMatch(/converged.*no material split/i);
  });

  it("decision_support: surfaces a contested recommendation without misrepresenting supportCount as support for the shown recommendation", () => {
    // supportCount/totalModelsWithRecommendation can mean "converged on choosing
    // an option" even while contested on WHICH option (decisionSupportAlignment.ts
    // lines 469-491) — so the copy must not claim these models "supported the
    // recommendation shown above" the way earlier copy did.
    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "decision_support",
        decisionSupport: decisionSupportFixture({
          recommendation: { action: "go", rationale: "Split panel.", caveats: [], isContested: true, supportCount: 2, totalModelsWithRecommendation: 4 },
        }),
        modelsUsed: ["chatgpt", "claude", "grok", "gemini"] as ModelId[],
      })
    );
    expect(html).toMatch(/contested/i);
    expect(html).not.toMatch(/supported the recommendation/i);
  });

  function causalExplanationFixture(overrides: Partial<CausalExplanationResult> = {}): CausalExplanationResult {
    return {
      directAnswer: "X causes Y.",
      factors: [
        { id: "f1", label: "Direct cause", category: "direct_cause", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: ["chatgpt", "claude"] as any, evidenceStrength: "strong", sourceBacked: true },
      ],
      causalChain: [{ id: "l1", mechanism: "A leads to B", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: ["chatgpt", "claude"] as any }],
      confounders: [],
      disputedInterpretations: [],
      unknowns: [],
      testsOrEvidenceNeeded: [],
      sourceBacked: true,
      totalModels: 2,
      ...overrides,
    };
  }

  it("causal_explanation: tallies factors by evidence strength and notes when nothing is disputed", () => {
    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "causal_explanation",
        causalExplanation: causalExplanationFixture(),
        modelsUsed: ["chatgpt", "claude"] as ModelId[],
      })
    );
    expect(html).toMatch(/factor evidence strength/i);
    expect(html).toMatch(/strong.*1/i);
    expect(html).toMatch(/did not flag any disputed interpretations/i);
  });

  it("causal_explanation: reflects contested factors in the tally, distinct from unrelated disputed interpretations", () => {
    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "causal_explanation",
        causalExplanation: causalExplanationFixture({
          factors: [
            { id: "f1", label: "Disputed cause", category: "direct_cause", coverageCount: 1, totalModels: 2, coverageRatio: 0.5, contributingModels: ["chatgpt"] as any, evidenceStrength: "contested", sourceBacked: false },
          ],
          disputedInterpretations: [{ label: "Some models attribute this differently.", supportingModels: ["claude"] as any }],
        }),
        modelsUsed: ["chatgpt", "claude"] as ModelId[],
      })
    );
    expect(html).toMatch(/contested.*1/i);
    expect(html).not.toMatch(/did not flag any disputed interpretations/i);
  });

  function definitionExplanationFixture(overrides: Partial<DefinitionExplanationResult> = {}): DefinitionExplanationResult {
    return {
      primary: {
        coverageCount: 2,
        totalModels: 2,
        coverageRatio: 1,
        contributingModels: ["chatgpt", "claude"] as any,
        term: "Photosynthesis",
        directAnswer: "The process plants use to convert light into energy.",
        explanation: "e",
        keyPoints: [],
        distinctions: [],
        processSteps: [],
        commonMisconceptions: [],
        relatedConcepts: [],
        sources: ["britannica.com/photosynthesis"],
      } as any,
      alternateInterpretations: [],
      isAmbiguous: false,
      sourceBacked: true,
      totalModels: 2,
      ...overrides,
    };
  }

  it("definition_explanation: shows coverage per interpretation and consolidated sources", () => {
    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "definition_explanation",
        definitionExplanation: definitionExplanationFixture(),
        modelsUsed: ["chatgpt", "claude"] as ModelId[],
      })
    );
    expect(html).toMatch(/interpretation coverage/i);
    expect(html).toMatch(/Photosynthesis.*2\/2/);
    expect(html).toMatch(/sources cited/i);
    expect(html).toContain("britannica.com/photosynthesis");
  });

  it("definition_explanation: consolidates sources across primary AND alternate interpretations, deduped", () => {
    const html = renderToStaticMarkup(
      createElement(PanelEvidenceSection, {
        schemaId: "definition_explanation",
        definitionExplanation: definitionExplanationFixture({
          alternateInterpretations: [
            {
              coverageCount: 1,
              totalModels: 2,
              coverageRatio: 0.5,
              contributingModels: ["grok"] as any,
              term: "Photosynthesis (alt)",
              directAnswer: "An alternate reading.",
              explanation: "e",
              keyPoints: [],
              distinctions: [],
              processSteps: [],
              commonMisconceptions: [],
              relatedConcepts: [],
              sources: ["britannica.com/photosynthesis", "wikipedia.org/photosynthesis"],
            } as any,
          ],
        }),
        modelsUsed: ["chatgpt", "claude", "grok"] as ModelId[],
      })
    );
    const matches = html.match(/britannica\.com\/photosynthesis/g) || [];
    expect(matches.length).toBe(1); // deduped, not repeated once per interpretation
    expect(html).toContain("wikipedia.org/photosynthesis");
    expect(html).toMatch(/Photosynthesis \(alt\).*1\/2/);
  });

  it("all 4 batch-1 branches are collapsed by default, matching every other Panel Evidence branch", () => {
    for (const props of [
      { schemaId: "deep_research" as const, deepResearch: deepResearchFixture() },
      { schemaId: "decision_support" as const, decisionSupport: decisionSupportFixture() },
      { schemaId: "causal_explanation" as const, causalExplanation: causalExplanationFixture() },
      { schemaId: "definition_explanation" as const, definitionExplanation: definitionExplanationFixture() },
    ]) {
      const html = renderToStaticMarkup(createElement(PanelEvidenceSection, { ...props, modelsUsed: ["chatgpt"] as ModelId[] }));
      expect(html).toMatch(/<details/);
      expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    }
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
