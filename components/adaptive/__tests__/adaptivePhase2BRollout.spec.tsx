/**
 * Adaptive Synthesis Report, Phase 2B (batch 2) — ranked_enumeration/
 * checklist_taxonomy/evidence_review/bias_blindspot_audit.
 *
 * Mirrors adaptivePhase2ARollout.spec.tsx's conventions exactly:
 *   - renderToStaticMarkup (no jsdom).
 *   - A full live -> persist -> parse -> adapt -> render History-chain test
 *     per schema, proving the renderer (not the already-tested adapter)
 *     correctly consumes what that chain produces.
 *   - Raw per-model fixtures are deliberately flat/minimal, matching each
 *     schema's own `fields: FieldSpec[]` wire contract — never the
 *     AGGREGATED *Result shape, which is a different object entirely (see
 *     adaptivePhase2ARollout.spec.tsx's own doc comment for why reusing the
 *     aggregated shape there throws a real React error).
 *
 * checklist_taxonomy additionally proves the risk-shaped vs plain-checklist
 * renderer split survives all the way through this file's own fixtures,
 * independent of the dedicated regression test already in
 * AdaptivePanelResponse.spec.tsx.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { SCHEMA_REGISTRY, getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { parsePersistedAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { adaptPersistedOutputToPanelPayload } from "@/lib/user/adaptivePersistedOutputAdapter";
import {
  AdaptiveModelResult,
  BiasBlindspotAuditResult,
  ChecklistTaxonomyResult,
  EvidenceReviewResult,
  QueryClassification,
  QueryType,
  RankedEnumerationResult,
} from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function baseClassification(queryType: QueryType): QueryClassification {
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
  };
}

function modelResult(modelId: string, schemaId: QueryType, data: Record<string, unknown>): AdaptiveModelResult {
  return { modelId: modelId as ModelId, schemaId, ok: true, data: data as any };
}

const META = {
  schemaVersion: 1,
  queryType: "ranked_enumeration",
  answerShape: "ranked_list",
  dataBasis: "training_prior",
  freshness: "timeless",
  riskLevel: "professional",
  evidenceQuality: "not_applicable",
  uncertainties: [],
  blindSpots: [],
  humanReviewNeeded: false,
  generatedAt: "2026-08-14T00:00:00.000Z",
} as const;

function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const rankedEnumerationResult: RankedEnumerationResult = {
  items: [
    { id: "python", label: "Python", panelRank: 1, coverageCount: 3, totalModels: 3, coverageRatio: 1, sourceRanks: { chatgpt: 1, claude: 1, grok: 1 } as any, rankVariance: 0 },
    { id: "javascript", label: "JavaScript", panelRank: 2, coverageCount: 3, totalModels: 3, coverageRatio: 1, sourceRanks: { chatgpt: 4, claude: 2, grok: 1 } as any, rankVariance: 1.56, rationale: "Ubiquitous for web development." },
  ],
  lowConfidenceItems: [],
  requestedCount: 2,
  actualCount: 2,
  rankCorrelation: 0.6,
  hasLiveQueryLogData: false,
  totalModels: 3,
};

const plainChecklistResult: ChecklistTaxonomyResult = {
  summary: "Checklist for launching a SaaS product.",
  categories: [
    {
      category: "Legal",
      items: [
        { id: "dpa", label: "Sign a data processing agreement", category: "Legal", critical: true, coverageCount: 3, totalModels: 3, coverageRatio: 1, contributingModels: ["chatgpt", "claude", "grok"] as any },
      ],
    },
  ],
  lowConfidenceItems: [],
  notes: ["This list is not exhaustive."],
  totalModels: 3,
};

const riskShapedResult: ChecklistTaxonomyResult = {
  summary: "Key risks of relying on AI-generated market research.",
  categories: [
    {
      category: "Data quality",
      items: [
        {
          id: "hallucination",
          label: "Hallucinated data",
          category: "Data quality",
          critical: false,
          coverageCount: 3,
          totalModels: 3,
          coverageRatio: 1,
          contributingModels: ["chatgpt", "claude", "grok"] as any,
          severity: "high",
          likelihood: "medium",
          mitigation: "Cross-check figures against a primary source before use.",
        },
      ],
    },
  ],
  lowConfidenceItems: [],
  notes: [],
  totalModels: 3,
};

const evidenceReviewResult: EvidenceReviewResult = {
  overallAssessment: "The study provides moderately strong evidence for its main claim.",
  overallStrength: "moderate",
  dimensions: [
    { id: "sample-size", dimension: "Sample size", assessment: "Large, well-powered sample.", strength: "strong", coverageCount: 3, totalModels: 3, coverageRatio: 1, contributingModels: ["chatgpt", "claude", "grok"] as any },
  ],
  lowConfidenceDimensions: [],
  redFlags: ["No pre-registration found."],
  strengths: ["Peer-reviewed", "Large sample"],
  applicabilityCaveats: [],
  recommendedChecks: [],
  sourceBacked: true,
  sources: [],
  totalModels: 3,
};

const biasBlindspotAuditResult: BiasBlindspotAuditResult = {
  summary: "The panel's analysis shows a moderate US-centric framing.",
  attributedBiases: [
    {
      biasType: "framing_bias",
      description: "GPT-5.2 consistently frames the question in US regulatory terms.",
      modelsImplicated: ["chatgpt"] as any,
      evidence: [{ modelId: "chatgpt" as any, excerpt: "Under US law..." } as any],
      likelyCauses: ["US-heavy training data"],
      impact: "May mislead non-US readers about applicable rules.",
      mitigationSteps: ["Ask explicitly for jurisdiction-neutral framing."],
    },
  ],
  biasEmptyReason: null,
  panelBlindSpots: [],
  sharedAssumptions: [],
  missingStakeholders: [],
  structuralDiagnostics: {
    citationCoverage: { modelsWithSources: 1, totalModels: 3, ratio: 0.33 },
    geographicBiasConcerns: ["Analysis is US-centric"],
    sourceConcentrationConcerns: [],
    evidenceTypeConcerns: [],
    homogeneityFlag: false,
  },
  followUpQuestions: [],
  sources: [],
  totalModels: 3,
};

/**
 * Raw per-model data — flat, matching each schema's OWN `fields: FieldSpec[]`
 * wire contract (rankedEnumerationFields/checklistTaxonomyFields/
 * evidenceReviewFields/biasBlindspotAuditFields in schemaRegistry.ts), never
 * the AGGREGATED *Result shape above.
 */
const rankedEnumerationRawModelData = {
  items: [
    { id: "python", label: "Python", rank: 1 },
    { id: "javascript", label: "JavaScript", rank: 2 },
  ],
};

const plainChecklistRawModelData = {
  summary: "Checklist for launching a SaaS product.",
  items: [{ id: "dpa", label: "Sign a data processing agreement", category: "Legal", critical: true }],
  notes: ["This list is not exhaustive."],
};

const riskShapedRawModelData = {
  summary: "Key risks of relying on AI-generated market research.",
  items: [
    {
      id: "hallucination",
      label: "Hallucinated data",
      category: "Data quality",
      severity: "high",
      likelihood: "medium",
      mitigation: "Cross-check figures against a primary source before use.",
    },
  ],
  notes: [],
};

const evidenceReviewRawModelData = {
  overallAssessment: "The study provides moderately strong evidence for its main claim.",
  dimensions: [{ id: "sample-size", dimension: "Sample size", assessment: "Large, well-powered sample.", strength: "strong" }],
  redFlags: ["No pre-registration found."],
  strengths: ["Peer-reviewed", "Large sample"],
  applicabilityCaveats: [],
  recommendedChecks: [],
  sources: [],
};

const biasBlindspotAuditRawModelData = {
  summary: "The panel's analysis shows a moderate US-centric framing.",
  omittedDimensions: [],
  sharedAssumptions: [],
  missingStakeholders: [],
  geographicBiases: ["Analysis is US-centric"],
  sourceConcentrationConcerns: [],
  evidenceTypeConcerns: [],
  followUpQuestions: [],
  sources: [],
};

interface Batch2Fixture {
  schemaId: QueryType;
  answerShape: string;
  resultField: "rankedEnumeration" | "checklistTaxonomy" | "evidenceReview" | "biasBlindspotAudit";
  result: unknown;
  rawModelData: Record<string, unknown>;
  primaryMarker: RegExp;
  disagreementMarker: RegExp;
  uncertaintyMarker: RegExp;
}

const BATCH_2: Batch2Fixture[] = [
  {
    schemaId: "ranked_enumeration",
    answerShape: "ranked_list",
    resultField: "rankedEnumeration",
    result: rankedEnumerationResult,
    rawModelData: rankedEnumerationRawModelData,
    primaryMarker: /Python/,
    disagreementMarker: /rank disputed/i,
    uncertaintyMarker: /informed estimate, not measured search or usage data/i,
  },
  {
    schemaId: "checklist_taxonomy",
    answerShape: "checklist_taxonomy_view",
    resultField: "checklistTaxonomy",
    result: plainChecklistResult,
    rawModelData: plainChecklistRawModelData,
    primaryMarker: /Sign a data processing agreement/,
    disagreementMarker: /Critical/,
    uncertaintyMarker: /not exhaustive/i,
  },
  {
    schemaId: "evidence_review",
    answerShape: "evidence_review_view",
    resultField: "evidenceReview",
    result: evidenceReviewResult,
    rawModelData: evidenceReviewRawModelData,
    primaryMarker: /moderately strong evidence/,
    disagreementMarker: /red flags/i,
    uncertaintyMarker: /no pre-registration found/i,
  },
  {
    schemaId: "bias_blindspot_audit",
    answerShape: "bias_blindspot_audit_view",
    resultField: "biasBlindspotAudit",
    result: biasBlindspotAuditResult,
    rawModelData: biasBlindspotAuditRawModelData,
    primaryMarker: /moderate US-centric framing/,
    disagreementMarker: /attributed model-specific bias/i,
    uncertaintyMarker: /US-heavy training data/i,
  },
];

describe("AdaptivePanelResponse — Phase 2B batch 2 renderer selection and content", () => {
  for (const fixture of BATCH_2) {
    describe(fixture.schemaId, () => {
      function renderLive(overrides: Record<string, unknown> = {}) {
        const schema = SCHEMA_REGISTRY[fixture.schemaId];
        const classification = baseClassification(fixture.schemaId);
        const results = [modelResult("chatgpt", fixture.schemaId, fixture.rawModelData)];
        return renderToStaticMarkup(
          createElement(AdaptivePanelResponse, {
            schema,
            classification,
            results,
            [fixture.resultField]: fixture.result,
            question: "A test question",
            ...overrides,
          })
        );
      }

      it("selects the dedicated primary view and shows the direct answer before any secondary section", () => {
        const html = renderLive();
        expect(html).toMatch(fixture.primaryMarker);
        const answerIndex = html.search(fixture.primaryMarker);
        const modelResponsesIndex = html.search(/model responses/i);
        expect(answerIndex).toBeGreaterThan(-1);
        expect(modelResponsesIndex).toBeGreaterThan(answerIndex);
      });

      it("keeps report-level consensus visible via TopSummaryBar", () => {
        const html = renderLive();
        expect(html).toMatch(/consensus/i);
      });

      it("surfaces material disagreement/uncertainty in the primary report, reusing already-computed data", () => {
        const html = renderLive();
        expect(html).toMatch(fixture.disagreementMarker);
        expect(html).toMatch(fixture.uncertaintyMarker);
      });

      it("exposes Model Responses, Panel Evidence, and Review & Governance, all collapsed by default", () => {
        const html = renderLive();
        expect(html).toMatch(/model responses/i);
        expect(html).toMatch(/panel evidence/i);
        expect(html).toMatch(/review.{0,10}governance/i);
        expect(html).not.toMatch(/<details[^>]*\bopen\b/);
      });

      it("never exposes the structured result as serialized JSON text, and never falls back to the legacy Unified Answer shell", () => {
        const html = renderLive();
        expect(html).not.toMatch(/\\"totalModels\\"/);
        expect(html).not.toMatch(/&quot;totalModels&quot;/);
        expect(html).not.toMatch(/list view|compare view/i);
        expect(html).not.toMatch(/unified answer/i);
      });

      it("live -> persist -> parse -> adapt -> render produces the SAME primary content a live run shows (live/history parity)", () => {
        const rawPersisted = roundTrip({
          version: 1,
          schemaId: fixture.schemaId,
          answerShape: fixture.answerShape,
          classification: baseClassification(fixture.schemaId),
          meta: { ...META, queryType: fixture.schemaId, answerShape: fixture.answerShape },
          generatedAt: "2026-08-14T00:00:00.000Z",
          result: fixture.result,
        });

        const parsed = parsePersistedAdaptiveOutput(rawPersisted);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;

        const payload = adaptPersistedOutputToPanelPayload(parsed.output);
        expect(payload.schemaId).toBe(fixture.schemaId);

        const schema = getResultSchema(payload.schemaId);
        const html = renderToStaticMarkup(
          createElement(AdaptivePanelResponse, {
            schema,
            classification: parsed.output.classification,
            results: payload.results,
            [fixture.resultField]: (payload as any)[fixture.resultField],
            generatedAt: payload.generatedAt,
            meta: payload.meta,
            persistenceStatus: payload.persistenceStatus,
            question: "A test question",
          })
        );

        expect(html).toMatch(fixture.primaryMarker);
        expect(html).not.toMatch(/\\"totalModels\\"/);
      });

      it("fails safely (parser rejects, never crashes) for malformed persisted data", () => {
        const malformed = roundTrip({
          version: 1,
          schemaId: fixture.schemaId,
          answerShape: fixture.answerShape,
          classification: baseClassification(fixture.schemaId),
          meta: META,
          generatedAt: "2026-08-14T00:00:00.000Z",
          result: { unexpected: "shape" },
        });
        const parsed = parsePersistedAdaptiveOutput(malformed);
        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.reason).toBe("malformed");
      });
    });
  }

  it("checklist_taxonomy: a risk-shaped result renders RiskAnalysisView (not ChecklistTaxonomyView), with secondary sections present on both paths", () => {
    const schema = SCHEMA_REGISTRY.checklist_taxonomy;
    const classification = baseClassification("checklist_taxonomy");
    const results = [modelResult("chatgpt", "checklist_taxonomy", riskShapedRawModelData)];

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        checklistTaxonomy: riskShapedResult,
        question: "What are the main risks of relying on AI-generated market research?",
      })
    );

    expect(html).toMatch(/executive risk conclusion/i);
    expect(html).toMatch(/risk register/i);
    expect(html).toMatch(/high severity/i);
    expect(html).not.toMatch(/no checklist items were returned/i);
    // Secondary sections still present for the risk-shaped path.
    expect(html).toMatch(/model responses/i);
    expect(html).toMatch(/panel evidence/i);
    expect(html).toMatch(/review.{0,10}governance/i);
  });

  it("checklist_taxonomy: the risk-shaped and plain-checklist renders remain visibly distinct, including inside Panel Evidence", () => {
    const schema = SCHEMA_REGISTRY.checklist_taxonomy;
    const classification = baseClassification("checklist_taxonomy");

    const plainHtml = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results: [modelResult("chatgpt", "checklist_taxonomy", plainChecklistRawModelData)],
        checklistTaxonomy: plainChecklistResult,
        question: "What should I check before launching a SaaS product?",
      })
    );
    const riskHtml = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results: [modelResult("chatgpt", "checklist_taxonomy", riskShapedRawModelData)],
        checklistTaxonomy: riskShapedResult,
        question: "What are the main risks of relying on AI-generated market research?",
      })
    );

    // Primary view distinction (already pinned elsewhere, re-confirmed here).
    expect(plainHtml).not.toMatch(/executive risk conclusion|risk register/i);
    expect(riskHtml).toMatch(/executive risk conclusion/i);

    // Panel Evidence tally distinction — plain uses coverage tier + critical count, risk uses severity + mitigation count.
    expect(plainHtml).toMatch(/flagged must-have\/blocking/i);
    expect(plainHtml).not.toMatch(/risk severity|stated mitigation/i);
    expect(riskHtml).toMatch(/risk severity/i);
    expect(riskHtml).toMatch(/stated mitigation/i);
    expect(riskHtml).not.toMatch(/flagged must-have\/blocking/i);
  });

  it("evidence_review: a high-consensus dimension with weak evidence strength is never visually promoted to strong", () => {
    const schema = SCHEMA_REGISTRY.evidence_review;
    const classification = baseClassification("evidence_review");
    const weakButUnanimous: EvidenceReviewResult = {
      ...evidenceReviewResult,
      dimensions: [
        {
          id: "peer-review",
          dimension: "Peer review status",
          assessment: "Not peer reviewed.",
          strength: "weak",
          coverageCount: 3,
          totalModels: 3,
          coverageRatio: 1,
          contributingModels: ["chatgpt", "claude", "grok"] as any,
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results: [modelResult("chatgpt", "evidence_review", evidenceReviewRawModelData)],
        evidenceReview: weakButUnanimous,
        question: "How strong is this evidence?",
      })
    );
    // Full 3-of-3 coverage must not surface as a "strong"-toned tally badge for this dimension.
    expect(html).toMatch(/dimension evidence strength/i);
    expect(html).toMatch(/Weak: 1/);
    expect(html).not.toMatch(/Strong: 1/);
  });

  it("bias_blindspot_audit: an empty Tier 1 is never presented as proof of neutrality, and Tier 3 concerns stay labeled speculative", () => {
    const schema = SCHEMA_REGISTRY.bias_blindspot_audit;
    const classification = baseClassification("bias_blindspot_audit");
    const noAttributedBias: BiasBlindspotAuditResult = {
      ...biasBlindspotAuditResult,
      attributedBiases: [],
      biasEmptyReason: "below_threshold",
    };
    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results: [modelResult("chatgpt", "bias_blindspot_audit", biasBlindspotAuditRawModelData)],
        biasBlindspotAudit: noAttributedBias,
        question: "Audit this panel for bias.",
      })
    );
    expect(html).toMatch(/does not mean the answer is unbiased/i);
    expect(html).toMatch(/not confirmed bias/i);
  });

  it("cross-schema: ranked_enumeration and evidence_review render materially different primary structure (never the same generic shell)", () => {
    const rankedHtml = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema: SCHEMA_REGISTRY.ranked_enumeration,
        classification: baseClassification("ranked_enumeration"),
        results: [modelResult("chatgpt", "ranked_enumeration", rankedEnumerationRawModelData)],
        rankedEnumeration: rankedEnumerationResult,
        question: "q",
      })
    );
    const evidenceHtml = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema: SCHEMA_REGISTRY.evidence_review,
        classification: baseClassification("evidence_review"),
        results: [modelResult("chatgpt", "evidence_review", evidenceReviewRawModelData)],
        evidenceReview: evidenceReviewResult,
        question: "q",
      })
    );

    expect(rankedHtml).toMatch(/ranked list/i);
    expect(evidenceHtml).not.toMatch(/ranked list/i);

    expect(evidenceHtml).toMatch(/quality dimensions/i);
    expect(rankedHtml).not.toMatch(/quality dimensions/i);

    expect(rankedHtml).not.toMatch(/list view|compare view/i);
    expect(evidenceHtml).not.toMatch(/list view|compare view/i);
  });

  it("does not regress renderer selection for already-shipped schemas (comparison_matrix/deep_research untouched)", () => {
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
      createElement(AdaptivePanelResponse, { schema, classification, results, comparisonMatrix, question: "q" })
    );
    expect(html).toMatch(/direct conclusion/i);
  });
});
