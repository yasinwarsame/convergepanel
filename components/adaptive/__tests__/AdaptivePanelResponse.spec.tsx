/**
 * AdaptivePanelResponse renderer-selection tests.
 *
 * Covers the root cause found while auditing why comparison/risk-shaped
 * adaptive runs were rendering through the legacy List/Compare/Synthesis
 * shell: the classifier was silently falling back to "generic" for nearly
 * every query (a Gemini "thinking" token-budget bug fixed in classifier.ts/
 * gemini.ts), so real Milestone-2 schemas like comparison_matrix and
 * checklist_taxonomy were never actually reached at the renderer layer even
 * though their dedicated views already existed. These tests pin the
 * renderer-selection contract directly (given a correct classification,
 * the right view renders) independent of the classifier itself.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { buildComparisonMatrixResult } from "@/lib/adaptiveSchema/comparisonAlignment";
import { buildChecklistTaxonomyResult, ChecklistTaxonomyFields } from "@/lib/adaptiveSchema/checklistAlignment";
import { AdaptiveModelResult, AdaptiveSynthesisReport as AdaptiveSynthesisReportType, ChecklistItem, ComparisonCell, QueryClassification, QueryType } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function baseClassification(queryType: QueryType, overrides: Partial<QueryClassification> = {}): QueryClassification {
  return {
    queryType,
    domain: "test",
    answerShape: SCHEMA_REGISTRY[queryType].renderHint,
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
    rationale: "test fixture",
    ...overrides,
  };
}

function modelResult(modelId: string, schemaId: QueryType, data: Record<string, unknown>): AdaptiveModelResult {
  return { modelId: modelId as ModelId, schemaId, ok: true, data: data as any };
}

function checklistItem(overrides: Partial<ChecklistItem> & { id: string; label: string }): ChecklistItem {
  return { ...overrides };
}

function comparisonCell(overrides: Partial<ComparisonCell> & Pick<ComparisonCell, "subject" | "attribute" | "value">): ComparisonCell {
  return { ...overrides };
}

describe("AdaptivePanelResponse — comparison_matrix routes to ComparisonMatrixView", () => {
  it("renders the comparison grid directly, bypassing List/Compare/Synthesis and Trust Summary/Verification Gate entirely", () => {
    const schema = SCHEMA_REGISTRY.comparison_matrix;
    const classification = baseClassification("comparison_matrix");
    const results = [modelResult("chatgpt", "comparison_matrix", { cells: [] })];
    const comparisonMatrix = buildComparisonMatrixResult([
      {
        modelId: "chatgpt" as ModelId,
        cells: [comparisonCell({ subject: "ChatGPT", attribute: "Citations", value: "Weak" })],
        directConclusion: "ChatGPT and Perplexity lead for different reasons.",
      },
    ]);

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        comparisonMatrix,
        question: "Compare ChatGPT, Claude, Gemini, Perplexity, and Grok for professional research.",
      })
    );

    expect(html).toMatch(/direct conclusion/i);
    expect(html).not.toMatch(/unified answer/i);
    expect(html).not.toMatch(/trust summary/i);
    expect(html).not.toMatch(/verification gate/i);
    expect(html).not.toMatch(/agreement.*disagreement map/i);
    // Adaptive Synthesis Report, Phase 2 pilot — Model Responses/Panel
    // Evidence/Review & Governance now render below the primary view.
    expect(html).toMatch(/model responses/i);
    expect(html).toMatch(/panel agreement/i);
    expect(html).toMatch(/review status/i);
  });
});

describe("AdaptivePanelResponse — risk-shaped checklist_taxonomy routes to RiskAnalysisView", () => {
  const schema = SCHEMA_REGISTRY.checklist_taxonomy;
  const classification = baseClassification("checklist_taxonomy");

  it("renders the risk register when items carry risk fields, distinct from the plain checklist heading", () => {
    const fields: ChecklistTaxonomyFields = {
      summary: "AI-generated market research carries several risks worth managing.",
      items: [
        checklistItem({
          id: "hallucination",
          label: "Hallucinated data",
          category: "Data quality",
          severity: "high",
          likelihood: "medium",
          mitigation: "Cross-check figures against a primary source before use.",
        }),
      ],
      notes: [],
    };
    const checklistTaxonomy = buildChecklistTaxonomyResult([{ modelId: "chatgpt" as ModelId, fields }]);
    const results = [modelResult("chatgpt", "checklist_taxonomy", fields as any)];

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        checklistTaxonomy,
        question: "What are the main risks of relying on AI-generated market research?",
      })
    );

    expect(html).toMatch(/executive risk conclusion/i);
    expect(html).toMatch(/risk register/i);
    expect(html).toMatch(/high severity/i);
    expect(html).not.toMatch(/unified answer/i);
    expect(html).not.toMatch(/trust summary/i);
    expect(html).not.toMatch(/verification gate/i);
  });

  it("renders the plain checklist, not the risk register, when no item carries a risk field", () => {
    const fields: ChecklistTaxonomyFields = {
      summary: "Checklist for launching a SaaS product.",
      items: [checklistItem({ id: "dpa", label: "Sign a data processing agreement", category: "Legal" })],
      notes: [],
    };
    const checklistTaxonomy = buildChecklistTaxonomyResult([{ modelId: "chatgpt" as ModelId, fields }]);
    const results = [modelResult("chatgpt", "checklist_taxonomy", fields as any)];

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        checklistTaxonomy,
        question: "What should I check before launching a SaaS product?",
      })
    );

    expect(html).not.toMatch(/executive risk conclusion/i);
    expect(html).not.toMatch(/risk register/i);
  });
});

/** Minimal-but-complete AdaptiveSynthesisReport fixture — every field the
 * Phase 2 pilot's PanelEvidenceSection actually reads (unlike the old
 * pre-pilot fixture, which only needed to survive a tab that was never
 * rendered by default and so could get away with an incomplete object). */
function synthesisReportFixture(overrides: Partial<AdaptiveSynthesisReportType> = {}): AdaptiveSynthesisReportType {
  return {
    unifiedAnswer: "The panel's synthesized answer.",
    panelVerdict: "Panel converges on the core answer.",
    gate: "pass",
    runCertainty: 0.8,
    whereModelsAgree: ["Models agree on the basics."],
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
      topConsensus: "Models agree on the basics.",
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

/**
 * Corrected during Phase 2C-3 final review: the ORIGINAL version of this
 * test (pre-review) claimed contested_empirical "still renders the tabbed
 * shell" when gate/synthesisReport are absent, asserting only the loose
 * `/list|compare|synthesis/i` — which incidentally still matches text
 * inside the PROMOTED layout (e.g. "Panel Evidence", "Full synthesis
 * report") and therefore never actually caught that the tri-tab
 * `PanelViewTabs` shell is NOT what renders here.
 *
 * The real control flow (AdaptivePanelResponse.tsx): `PHASE2_PILOT_SCHEMAS`
 * is now checked BEFORE the generic `!gate || !synthesisReport` fallback
 * (reordered in 2C-3 specifically so creative_generative — which never
 * computes gate/synthesisReport — reaches its promoted layout instead of
 * the bare AdaptiveResultsView fallback). Since ALL 8 legacy-active schemas
 * are now in PHASE2_PILOT_SCHEMAS, and every Milestone-2/factual_lookup
 * schema returns via its own earlier renderHint branch, there is currently
 * NO registered QueryType that can still reach either (a) the bare
 * `AdaptiveResultsView`-only fallback at line ~544, or (b) the tri-tab
 * `PanelViewTabs` shell below it — both are dead code for real traffic
 * today (reachable only if a future QueryType were added to the registry
 * without also being added to PHASE2_PILOT_SCHEMAS or given an explicit
 * earlier branch).
 *
 * This means gate/synthesisReport-absence for ANY of the 8 promoted
 * schemas — not just creative_generative — now renders the SAME promoted
 * progressive-disclosure layout, with PrimarySynthesisStrip and
 * ModelResponsesSection's listView omitted (both already conditional) and
 * PanelEvidenceSection/ReviewGovernanceSection degrading gracefully (both
 * already accept gate/synthesisReport as optional props). This is safe —
 * confirmed here by asserting each schema's OWN dedicated view still
 * renders, the tri-tab shell never appears, and no consensus/disagreement
 * language is fabricated from the missing synthesisReport — but it is a
 * real, previously-untested behavioral change for the other 7 schemas
 * that the pre-review test's weak assertion would not have caught.
 */
describe("AdaptivePanelResponse — gate/synthesisReport-absence for ANY of the 8 promoted schemas renders the promoted layout safely, never the tri-tab shell, never fabricated consensus", () => {
  const FIXTURE_BY_SCHEMA: Record<
    "procedural" | "generic" | "contested_empirical" | "legal_regulatory" | "medical_health" | "financial_valuation" | "forecast_speculative" | "creative_generative",
    { data: Record<string, unknown>; dedicatedMarker: RegExp }
  > = {
    procedural: { data: { goal: "Set up 2FA", steps: [] }, dedicatedMarker: /set up 2fa/i },
    generic: { data: { summary: "A generic answer." }, dedicatedMarker: /a generic answer/i },
    contested_empirical: {
      data: { summary: "Experts broadly agree the effect exists but disagree on magnitude.", settledClaims: [], disputedClaims: [], keyMetrics: [], openQuestions: [] },
      dedicatedMarker: /where the models land/i,
    },
    legal_regulatory: {
      data: { applicableRule: "Reasonable accommodation must be provided absent undue hardship.", jurisdiction: "US federal", elements: [], keyAuthority: [], exceptions: [], unsettledIssues: [], attorneyQuestions: [] },
      dedicatedMarker: /applicable rule/i,
    },
    medical_health: {
      data: { summary: "Regular exercise reduces cardiovascular risk.", mechanism: "x", evidenceByTier: [], guidelinePositions: ["AHA recommends 150 minutes/week."], redFlags: [], clinicianQuestions: [] },
      dedicatedMarker: /guideline positions/i,
    },
    financial_valuation: {
      data: { thesis: "The company is undervalued.", metrics: [{ label: "P/E", value: 18, unit: "x", asOf: "2026", source: "10-Q" }], bullCase: "Margin expansion.", bearCase: "Growth slows.", keyAssumptions: [], riskFactors: [] },
      dedicatedMarker: /bull case/i,
    },
    forecast_speculative: {
      data: { scenarios: [{ label: "Baseline", probability: 0.6, narrative: "Trends continue.", leadingIndicators: [] }], baseRates: ["Historically ~40%."], keyUncertainties: [] },
      dedicatedMarker: /base rates/i,
    },
    creative_generative: {
      data: { output: "A short poem about autumn leaves falling gently to the ground.", styleNotes: [] },
      dedicatedMarker: /autumn leaves falling gently/i,
    },
  };

  it.each(Object.keys(FIXTURE_BY_SCHEMA) as (keyof typeof FIXTURE_BY_SCHEMA)[])(
    "%s: gate/synthesisReport absent + alignedClaims=[] — renders the promoted layout (own dedicated view), never the tri-tab shell, never fabricates consensus",
    (schemaId) => {
      const schema = SCHEMA_REGISTRY[schemaId];
      const { data, dedicatedMarker } = FIXTURE_BY_SCHEMA[schemaId];
      const classification = baseClassification(schemaId);
      const results = [modelResult("chatgpt", schemaId, data), modelResult("claude", schemaId, data)];

      let html = "";
      expect(() => {
        html = renderToStaticMarkup(
          createElement(AdaptivePanelResponse, {
            schema,
            classification,
            results,
            alignedClaims: [],
            question: "A representative question",
          })
        );
      }).not.toThrow();

      // The schema's own dedicated view is what actually renders — proves
      // this isn't a blank page or a silent crash swallowed by the fallback.
      expect(html).toMatch(dedicatedMarker);
      // The tri-tab shell (List View / Compare View / Synthesis Report
      // button labels from PanelViewTabs) never renders for any of the 8.
      expect(html).not.toMatch(/list view|compare view/i);
      // No consensus/disagreement language fabricated from an absent
      // synthesisReport.
      expect(html).not.toMatch(/models agree/i);
      expect(html).not.toMatch(/models disagree/i);
      // Secondary sections still present (collapsed), not silently dropped.
      expect(html).toMatch(/model responses/i);
      expect(html).toMatch(/review.{0,10}governance/i);
    }
  );
});

describe("AdaptivePanelResponse — Phase 2 pilot: generic gets the promoted view + stacked sections, not tabs", () => {
  it("renders GenericSectionsView as the default surface with Panel Evidence/Review & Governance below, no tab UI", () => {
    const schema = SCHEMA_REGISTRY.generic;
    const classification = baseClassification("generic");
    const results = [modelResult("chatgpt", "generic", { summary: "Some answer" })];

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        gate: { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, loadBearingClaims: [] } as any,
        synthesisReport: synthesisReportFixture(),
        question: "A generic question",
      })
    );

    expect(html).toMatch(/review status/i);
    expect(html).toMatch(/full synthesis report/i);
    expect(html).not.toMatch(/list view|compare view/i);
  });
});

describe("AdaptivePanelResponse — Phase 2 pilot: procedural gets the promoted view + stacked sections, not tabs", () => {
  it("renders StepDiffView as the default surface, relocates the cross-model comparison block, no tab UI", () => {
    const schema = SCHEMA_REGISTRY.procedural;
    const classification = baseClassification("procedural");
    const results = [modelResult("chatgpt", "procedural", { goal: "Set up 2FA", steps: [] })];
    const alignedClaims = [
      {
        id: "step-1",
        claimText: "Step 1: Enable two-factor authentication",
        cells: [{ modelId: "chatgpt" as ModelId, stance: "agrees" as const, rawStance: "asserts" as const, confidence: "majority_view" as const, excerpt: "step" }],
        agreementScore: 1,
        certaintyScore: 1,
        status: "consensus" as const,
      },
    ];

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        alignedClaims,
        gate: { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, loadBearingClaims: [] } as any,
        synthesisReport: synthesisReportFixture(),
        question: "How do I set up two-factor authentication?",
      })
    );

    expect(html).toMatch(/review status/i);
    expect(html).toMatch(/cross-model comparison/i);
    expect(html).not.toMatch(/list view|compare view/i);
  });
});

/**
 * Progressive-disclosure contract (post-review redesign of the Phase 2
 * pilot): "never hidden behind tabs" does not mean "show everything
 * expanded on one long page." Pins the exact acceptance criteria from that
 * review — a reader must be able to answer "what's the answer / how
 * confident / what do models agree on / what do they disagree on" from the
 * unexpanded page, while Model Responses/Panel Evidence/Review & Governance
 * stay reachable but collapsed by default.
 */
describe("AdaptivePanelResponse — Phase 2 pilot progressive disclosure", () => {
  const collapsibleLabels = [/model responses/i, /panel evidence/i, /review.{0,10}governance/i];

  function assertCollapsedByDefault(html: string) {
    for (const label of collapsibleLabels) {
      expect(html).toMatch(label);
    }
    // No <details> anywhere in the output is open by default.
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  }

  it("procedural: the answer, consensus, and disagreement are visible without expanding anything, secondary sections are present but collapsed", () => {
    const schema = SCHEMA_REGISTRY.procedural;
    const classification = baseClassification("procedural");
    const results = [modelResult("chatgpt", "procedural", { goal: "Set up 2FA", steps: [], prerequisites: ["A GitHub account"] })];

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        gate: { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, loadBearingClaims: [] } as any,
        synthesisReport: synthesisReportFixture({
          unifiedAnswer: "Enable two-factor authentication in your account security settings.",
          verdictCard: {
            question: "How do I set up 2FA?",
            topConsensus: "All models agree 2FA should be enabled via account security settings",
            consensusModelCount: 2,
            keyDisagreement: "Whether SMS or an authenticator app is the recommended second factor",
            disagreementDetail: "One model recommends SMS, another recommends an authenticator app.",
            disagreementModelCount: 2,
            caveat: null,
            recommendedNextSteps: [],
          },
        }),
        question: "How do I set up two-factor authentication?",
      })
    );

    // Answerable without expanding anything (PrimarySynthesisStrip, always visible):
    expect(html).toMatch(/Enable two-factor authentication in your account security settings/);
    expect(html).toMatch(/All models agree 2FA should be enabled/);
    expect(html).toMatch(/Whether SMS or an authenticator app/);
    // Consensus scoring visible in the primary experience (TopSummaryBar, always visible):
    expect(html).toMatch(/consensus/i);
    // Prerequisites — real schema data StepDiffView previously never rendered:
    expect(html).toMatch(/Prerequisites/i);
    expect(html).toMatch(/A GitHub account/);

    assertCollapsedByDefault(html);
  });

  it("generic: remains a controlled fallback (no fabricated schema-specific structure), still gets the shared strip and collapsed secondary sections", () => {
    const schema = SCHEMA_REGISTRY.generic;
    const classification = baseClassification("generic");
    const results = [modelResult("chatgpt", "generic", { summary: "A generic answer.", uncertainties: [], followUps: [] })];

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        gate: { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, loadBearingClaims: [] } as any,
        synthesisReport: synthesisReportFixture({ unifiedAnswer: "The direct synthesized answer." }),
        question: "An ambiguous question",
      })
    );

    expect(html).toMatch(/The direct synthesized answer/);
    assertCollapsedByDefault(html);
  });

  it("comparison_matrix: needs no PrimarySynthesisStrip (ComparisonMatrixView already leads with directConclusion), secondary sections still collapsed", () => {
    const schema = SCHEMA_REGISTRY.comparison_matrix;
    const classification = baseClassification("comparison_matrix");
    const results = [modelResult("chatgpt", "comparison_matrix", { cells: [] })];
    const comparisonMatrix = {
      subjects: [],
      lowConfidenceSubjects: [],
      attributes: [],
      lowConfidenceAttributes: [],
      totalModels: 1,
      hasVerifiedSourceData: false as const,
      directConclusion: "ChatGPT leads on depth.",
      tradeoffs: [],
      bestUseRecommendations: [],
      uncertainties: [],
      cells: [],
    };

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        comparisonMatrix,
        question: "Compare ChatGPT and Claude",
      })
    );

    expect(html).toMatch(/direct conclusion/i);
    // No PrimarySynthesisStrip markup ("Answer" as its own headline card) —
    // ComparisonMatrixView's own Direct Conclusion already serves this role.
    expect(html).not.toMatch(/models agree.*models disagree/is);
    assertCollapsedByDefault(html);
  });
});
