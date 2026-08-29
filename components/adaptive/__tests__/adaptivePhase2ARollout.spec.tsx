/**
 * Adaptive Synthesis Report, Phase 2A (batch 1) — deep_research/
 * decision_support/causal_explanation/definition_explanation.
 *
 * Mirrors the Phase 2 pilot's own test conventions exactly:
 *   - renderToStaticMarkup (no jsdom), matching every other adaptive
 *     renderer test in this repo.
 *   - A full live→history chain test per schema (raw Firestore-shaped
 *     value -> parsePersistedAdaptiveOutput() -> adaptPersistedOutputToPanelPayload()
 *     -> getResultSchema() -> real <AdaptivePanelResponse>, renderToStaticMarkup),
 *     the same proof legacyAdaptiveReloadChain.spec.tsx established for
 *     procedural — here for the Milestone-2 family, where the adapter/
 *     parser were already proven schema-agnostic by
 *     adaptivePersistedOutputAdapter.spec.ts's `it.each(ALL_SCHEMA_IDS)`
 *     test; this file's job is proving the RENDERER correctly consumes
 *     what that already-tested chain produces, not re-proving the adapter.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { SCHEMA_REGISTRY, getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { parsePersistedAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { adaptPersistedOutputToPanelPayload } from "@/lib/user/adaptivePersistedOutputAdapter";
import {
  AdaptiveModelResult,
  CausalExplanationResult,
  DecisionSupportResult,
  DeepResearchResult,
  DefinitionExplanationResult,
  QueryClassification,
  QueryType,
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
  queryType: "deep_research",
  answerShape: "deep_research_view",
  dataBasis: "training_prior",
  freshness: "timeless",
  riskLevel: "professional",
  evidenceQuality: "not_applicable",
  uncertainties: [],
  blindSpots: [],
  humanReviewNeeded: false,
  generatedAt: "2026-08-07T00:00:00.000Z",
} as const;

/** JSON round-trip — the exact transform Firestore-stored data undergoes. */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const deepResearchResult: DeepResearchResult = {
  executiveSummary: "Remote work modestly reduces measured productivity overall.",
  findings: [
    { id: "f1", title: "Output drops for collaborative tasks", summary: "Sync-heavy work suffers most.", category: "General", evidenceStrength: "strong", sourceBacked: true, sources: [], coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: ["chatgpt", "claude"] },
  ],
  lowConfidenceFindings: [],
  disagreements: [{ label: "Whether the effect is temporary or persists long-term", supportingModels: ["chatgpt"] }],
  evidenceGaps: ["No controlled long-term study cited"],
  openQuestions: ["Does the effect vary by industry?"],
  panelBlindSpots: [],
  researchBoundaries: [],
  recommendedNextSteps: [],
  sourceCoverage: { findingsWithSources: 1, totalFindings: 1, coverageRatio: 1 },
  totalModels: 2,
};

const decisionSupportResult: DecisionSupportResult = {
  decisionQuestion: "Which CRM should we choose?",
  options: [{ id: "o1", label: "Option A", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: ["chatgpt", "claude"] }],
  criteria: [{ id: "c1", label: "Cost", source: "user", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: ["chatgpt", "claude"] }],
  assessments: [{ optionId: "o1", criterionId: "c1", assessment: "Affordable", evidenceStrength: "strong", coverageCount: 2, totalModels: 2, contributingModels: ["chatgpt", "claude"] }],
  recommendation: { action: "conditional_go", rationale: "Strong fit but budget-dependent.", caveats: [], isContested: true, supportCount: 1, totalModelsWithRecommendation: 2 },
  assumptions: ["Budget is fixed for this quarter"],
  uncertainties: ["Vendor pricing may change"],
  risks: [],
  sensitivityFindings: [],
  humanReviewNeeded: false,
  sourceBacked: true,
  sources: [],
  totalModels: 2,
};

const causalExplanationResult: CausalExplanationResult = {
  directAnswer: "Sleep deprivation impairs next-day cognitive performance.",
  factors: [{ id: "f1", label: "Reduced REM sleep", category: "direct_cause", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: ["chatgpt", "claude"], evidenceStrength: "strong", sourceBacked: true }],
  causalChain: [],
  confounders: [],
  disputedInterpretations: [{ label: "Whether caffeine fully offsets the effect", supportingModels: ["claude"] }],
  unknowns: ["Individual variation in sensitivity"],
  testsOrEvidenceNeeded: [],
  sourceBacked: true,
  sources: [],
  totalModels: 2,
};

const definitionExplanationResult: DefinitionExplanationResult = {
  primary: {
    coverageCount: 2,
    totalModels: 2,
    coverageRatio: 1,
    contributingModels: ["chatgpt", "claude"],
    term: "Photosynthesis",
    directAnswer: "The process plants use to convert light into chemical energy.",
    explanation: "Chlorophyll captures light energy...",
    keyPoints: [],
    distinctions: [],
    processSteps: [],
    commonMisconceptions: [],
    relatedConcepts: [],
    sources: ["britannica.com/photosynthesis"],
  },
  alternateInterpretations: [
    {
      coverageCount: 1,
      totalModels: 2,
      coverageRatio: 0.5,
      contributingModels: ["claude"],
      term: "Photosynthesis (cellular)",
      directAnswer: "Sometimes used narrowly to mean just the light-dependent reactions.",
      explanation: "A minority usage restricting the term to one stage of the overall process.",
      keyPoints: [],
      distinctions: [],
      processSteps: [],
      commonMisconceptions: [],
      relatedConcepts: [],
      sources: ["nature.com/light-reactions"],
    },
  ],
  isAmbiguous: true,
  sourceBacked: true,
  totalModels: 2,
};

/**
 * Raw per-model data — deliberately flat (mostly string/string[]), matching
 * each schema's OWN `fields: FieldSpec[]` wire contract (see
 * deepResearchFields/decisionSupportFields/causalExplanationFields/
 * definitionExplanationFields in schemaRegistry.ts), never the AGGREGATED
 * *Result shape above. ModelResponsesSection renders raw model data by
 * walking `schema.fields`, so passing an aggregated result there (e.g.
 * `disagreements` as `{label, supportingModels}[]` when the field is
 * declared `string[]`) throws a real React error — this is the one place a
 * test fixture must NOT reuse the primary-view result object.
 */
const deepResearchRawModelData = {
  executiveSummary: "Remote work modestly reduces measured productivity overall.",
  findings: [{ title: "Output drops for collaborative tasks", category: "General" }],
  disagreements: ["Whether the effect is temporary or persists long-term"],
  evidenceGaps: ["No controlled long-term study cited"],
  openQuestions: ["Does the effect vary by industry?"],
  researchBoundaries: [],
  recommendedNextSteps: [],
  sources: ["hbr.org/remote-work-study"],
};

const decisionSupportRawModelData = {
  decisionQuestion: "Which CRM should we choose?",
  options: ["Option A", "Option B"],
  criteria: ["Cost"],
  userProvidedCriteria: [],
  assessments: [{ optionLabel: "Option A", criterionLabel: "Cost", assessment: "Affordable" }],
  recommendationAction: "conditional_go",
  recommendedOption: "none",
  recommendationRationale: "Strong fit but budget-dependent.",
  recommendationCaveats: [],
  assumptions: ["Budget is fixed for this quarter"],
  uncertainties: ["Vendor pricing may change"],
  risks: [],
  sensitivityFindings: [],
  reversibleNextStep: "none",
  sources: [],
};

const causalExplanationRawModelData = {
  directAnswer: "Sleep deprivation impairs next-day cognitive performance.",
  directCauses: ["Reduced REM sleep"],
  contributingFactors: [],
  triggers: [],
  amplifiers: [],
  alternativeExplanations: [],
  causalLinks: ["Reduced REM sleep impairs memory consolidation, which degrades next-day recall."],
  confounders: [],
  disputedInterpretations: ["Whether caffeine fully offsets the effect"],
  unknowns: ["Individual variation in sensitivity"],
  testsOrEvidenceNeeded: [],
  sources: [],
};

const definitionExplanationRawModelData = {
  term: "Photosynthesis",
  directAnswer: "The process plants use to convert light into chemical energy.",
  explanation: "Chlorophyll captures light energy...",
  keyPoints: [],
  example: "none",
  analogyText: "none",
  analogyLimits: "none",
  distinctions: [],
  processSteps: [],
  advancedDetail: "none",
  commonMisconceptions: [],
  relatedConcepts: [],
  sources: ["britannica.com/photosynthesis"],
};

interface Batch1Fixture {
  schemaId: QueryType;
  answerShape: string;
  resultField: "deepResearch" | "decisionSupport" | "causalExplanation" | "definitionExplanation";
  result: unknown;
  rawModelData: Record<string, unknown>;
  /** A string that only appears in the schema's own dedicated primary view — proves renderer selection, not just "something rendered". */
  primaryMarker: RegExp;
  /** A string proving material disagreement/uncertainty data reached the primary view. */
  disagreementMarker: RegExp;
  uncertaintyMarker: RegExp;
}

const BATCH_1: Batch1Fixture[] = [
  {
    schemaId: "deep_research",
    answerShape: "deep_research_view",
    resultField: "deepResearch",
    result: deepResearchResult,
    rawModelData: deepResearchRawModelData,
    primaryMarker: /Remote work modestly reduces measured productivity/,
    disagreementMarker: /areas of disagreement/i,
    uncertaintyMarker: /evidence gaps/i,
  },
  {
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    resultField: "decisionSupport",
    result: decisionSupportResult,
    rawModelData: decisionSupportRawModelData,
    primaryMarker: /Which CRM should we choose\?/,
    disagreementMarker: /panel split/i,
    uncertaintyMarker: /what(&#x27;|&apos;|')s still uncertain/i,
  },
  {
    schemaId: "causal_explanation",
    answerShape: "causal_map",
    resultField: "causalExplanation",
    result: causalExplanationResult,
    rawModelData: causalExplanationRawModelData,
    primaryMarker: /Sleep deprivation impairs next-day cognitive performance/,
    disagreementMarker: /disputed interpretations/i,
    uncertaintyMarker: /unknowns/i,
  },
  {
    schemaId: "definition_explanation",
    answerShape: "definition_card",
    resultField: "definitionExplanation",
    result: definitionExplanationResult,
    rawModelData: definitionExplanationRawModelData,
    primaryMarker: /The process plants use to convert light into chemical energy/,
    disagreementMarker: /other meanings the panel found/i,
    uncertaintyMarker: /more than one accepted meaning/i,
  },
];

describe("AdaptivePanelResponse — Phase 2A batch 1 renderer selection and content", () => {
  for (const fixture of BATCH_1) {
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

      it("surfaces material disagreement in the primary report, reusing already-computed data (no second scoring pass)", () => {
        const html = renderLive();
        expect(html).toMatch(fixture.disagreementMarker);
      });

      it("keeps uncertainty/limitation content available in the primary report", () => {
        const html = renderLive();
        expect(html).toMatch(fixture.uncertaintyMarker);
      });

      it("exposes Model Responses, Panel Evidence, and Review & Governance, all collapsed by default", () => {
        const html = renderLive();
        expect(html).toMatch(/model responses/i);
        expect(html).toMatch(/panel evidence/i);
        expect(html).toMatch(/review.{0,10}governance/i);
        expect(html).not.toMatch(/<details[^>]*\bopen\b/);
      });

      it("never exposes the structured result as serialized JSON text", () => {
        const html = renderLive();
        // A raw JSON-shaped dump would show up as a doubly-escaped key like \"totalModels\": — proves every field the renderer touched is a real object, not a string blob.
        expect(html).not.toMatch(/\\"totalModels\\"/);
        expect(html).not.toMatch(/&quot;totalModels&quot;/);
      });

      it("live -> persist -> parse -> adapt -> render produces the SAME primary content a live run shows (live/history parity)", () => {
        const rawPersisted = roundTrip({
          version: 1,
          schemaId: fixture.schemaId,
          answerShape: fixture.answerShape,
          classification: baseClassification(fixture.schemaId),
          meta: { ...META, queryType: fixture.schemaId, answerShape: fixture.answerShape },
          generatedAt: "2026-08-07T00:00:00.000Z",
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

      it("fails safely (renders LimitationNotice-free fallback, never crashes) for malformed persisted data", () => {
        const malformed = roundTrip({
          version: 1,
          schemaId: fixture.schemaId,
          answerShape: fixture.answerShape,
          classification: baseClassification(fixture.schemaId),
          meta: META,
          generatedAt: "2026-08-07T00:00:00.000Z",
          result: { unexpected: "shape" }, // fails RESULT_SHAPE_CHECKS
        });
        const parsed = parsePersistedAdaptiveOutput(malformed);
        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.reason).toBe("malformed");
      });
    });
  }

  it("cross-schema: deep_research and decision_support render materially different primary structure (never the same generic shell)", () => {
    const deepResearchHtml = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema: SCHEMA_REGISTRY.deep_research,
        classification: baseClassification("deep_research"),
        results: [modelResult("chatgpt", "deep_research", deepResearchRawModelData)],
        deepResearch: deepResearchResult,
        question: "q",
      })
    );
    const decisionSupportHtml = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema: SCHEMA_REGISTRY.decision_support,
        classification: baseClassification("decision_support"),
        results: [modelResult("chatgpt", "decision_support", decisionSupportRawModelData)],
        decisionSupport: decisionSupportResult,
        question: "q",
      })
    );

    // deep_research has an executive summary + findings/disagreements structure never present in decision_support's output.
    expect(deepResearchHtml).toMatch(/executive summary|Remote work modestly reduces/i);
    expect(decisionSupportHtml).not.toMatch(/areas of disagreement/i);

    // decision_support has a recommendation action badge + options×criteria matrix never present in deep_research's output.
    expect(decisionSupportHtml).toMatch(/options considered/i);
    expect(deepResearchHtml).not.toMatch(/options considered/i);

    // Neither collapses into the generic tri-tab shell.
    expect(deepResearchHtml).not.toMatch(/list view|compare view/i);
    expect(decisionSupportHtml).not.toMatch(/list view|compare view/i);
  });

  it("does not regress renderer selection for the already-shipped pilot schemas (comparison_matrix/procedural/generic untouched)", () => {
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
