/**
 * Adaptive Research Export — PDF layout regression fixtures.
 *
 * Synthetic, deterministic export records sized to exercise pagination:
 * model cards and section bodies taller than one A4 page (the shape that
 * produced overlapping, unreadable cards in Production exports), plus
 * ordinary-size controls. Every rendered text unit carries a unique marker
 * `#Mnnnn#` so the rendered-PDF check (scripts/verify-pdf-layout.mjs) can
 * prove nothing was lost or truncated when content paginates.
 *
 * Shared by the real-render script and the Jest element-tree specs.
 */

import type { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";

export interface PdfLayoutFixture {
  name: string;
  record: AdaptiveResearchExportV1;
  /** Every marker embedded in rendered content, each expected exactly once. */
  markers: string[];
  /** Minimum page count the content must occupy (a guard that the fixture really is long). */
  minPages: number;
}

function markerFactory(prefix: string) {
  let n = 0;
  const all: string[] = [];
  const next = () => {
    const m = `#${prefix}${String(++n).padStart(3, "0")}#`;
    all.push(m);
    return m;
  };
  return { next, all };
}

const SENTENCE =
  "Institutional resilience depends on norms, courts, elections and civil society continuing to constrain actors who would otherwise escalate partisan conflict";

function prose(words: number, mark: string): string {
  const base = SENTENCE.split(" ");
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(base[i % base.length]);
  return `${out.join(" ")} ${mark}`;
}

function baseRecord(overrides: Partial<AdaptiveResearchExportV1> & Pick<AdaptiveResearchExportV1, "schemaId" | "schemaFamily" | "reportSnapshot">): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-layout-fixture",
    runId: "run-layout-fixture",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-10-14T12:00:00.000Z",
    createdBy: "uid-layout-fixture",
    format: "pdf",
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "legacy", status: "needs_review" },
    exportMetadata: {
      exportId: "exp-layout-fixture",
      runId: "run-layout-fixture",
      schemaVersion: 1,
      exportedSections: ["reportSnapshot"],
      createdAt: "2026-10-14T12:00:00.000Z",
      requestingUser: "uid-layout-fixture",
      finalReportVersion: 1,
    },
    ...overrides,
  } as AdaptiveResearchExportV1;
}

const MODELS = ["chatgpt", "claude", "grok", "perplexity", "gemini"] as const;

/** contested_empirical, five models, each card far taller than one page — the Production incident shape. */
function legacyLongCards(): PdfLayoutFixture {
  const m = markerFactory("L");
  const claim = (i: number) => ({
    id: `claim-${i}`,
    claim: prose(28, m.next()),
    stance: "asserts",
    confidence: "contested",
    evidenceType: "theoretical",
    camps: [
      { label: "Erosion camp", position: prose(22, m.next()) },
      { label: "Resilience camp", position: prose(22, m.next()) },
    ],
  });
  const modelResponses = MODELS.map((modelId, k) => ({
    modelId,
    schemaId: "contested_empirical",
    ok: true,
    data: {
      summary: prose(90, m.next()),
      settledClaims: [0, 1, 2].map((i) => ({ id: `settled-${k}-${i}`, claim: prose(28, m.next()), stance: "asserts", confidence: "settled", evidenceType: "empirical" })),
      disputedClaims: [3, 4, 5, 6, 7, 8].map((i) => claim(k * 100 + i)),
      keyMetrics: [0, 1, 2, 3].map((i) => ({ label: `Metric ${k}-${i} ${m.next()}`, value: 1234567 + i, unit: "people", asOf: "2025-12-01", source: "Fixture source" })),
      openQuestions: [0, 1, 2, 3].map(() => prose(18, m.next())),
    },
  }));
  return {
    name: "legacy-contested-long-cards",
    minPages: 12,
    markers: m.all,
    record: baseRecord({
      schemaId: "contested_empirical",
      schemaFamily: "legacy",
      reportSnapshot: {
        question: "Is the panel layout robust to very long model responses?",
        models: MODELS.map((modelId) => ({ modelId, ok: true })),
        reportTypeLabel: "Consensus Analysis",
        consensusLevel: "moderate",
        sourceGroundingLevel: "strong",
        reportGeneratedAt: "2026-10-14T11:00:00.000Z",
        legacy: {
          schemaId: "contested_empirical",
          alignedClaims: [],
          synthesisReport: {
            unifiedAnswer: prose(260, m.next()),
            panelVerdict: "caution",
            gate: "caution",
            runCertainty: 0.57,
            whereModelsAgree: [],
            whereModelsDisagree: [],
            certaintyAssessment: "x",
            narrativeSections: [],
            executiveSummary: "x",
            disagreements: [],
            biasAndBlindSpots: [],
            biasEmptyReason: "insufficient_models",
            panelCoverageGaps: [],
            diagnostics: { citedClaimCount: 0, totalClaimCount: 0, evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 }, homogeneityFlag: false, meanAgreement: 0.5 },
            verdictCard: {
              question: "q",
              topConsensus: prose(40, m.next()),
              consensusModelCount: 5,
              keyDisagreement: prose(40, m.next()),
              disagreementDetail: prose(60, m.next()),
              disagreementModelCount: 2,
              caveat: prose(30, m.next()),
              recommendedNextSteps: [],
            },
            degraded: false,
          },
          modelResponses,
        },
      } as never,
    }),
  };
}

/** One claim item alone taller than a page (a single generic-object block that cannot fit on one page). */
function legacyHugeSingleItem(): PdfLayoutFixture {
  const m = markerFactory("H");
  const huge = {
    id: "huge",
    claim: prose(40, m.next()),
    stance: "asserts",
    confidence: "contested",
    evidenceType: "theoretical",
    camps: Array.from({ length: 14 }, (_, i) => ({ label: `Camp ${i}`, position: prose(60, m.next()) })),
  };
  return {
    name: "legacy-huge-single-item",
    minPages: 3,
    markers: m.all,
    record: baseRecord({
      schemaId: "contested_empirical",
      schemaFamily: "legacy",
      reportSnapshot: {
        question: "Does a single over-tall item paginate without loss?",
        models: [{ modelId: "claude", ok: true }],
        reportTypeLabel: "Consensus Analysis",
        consensusLevel: "weak",
        sourceGroundingLevel: "moderate",
        reportGeneratedAt: "2026-10-14T11:00:00.000Z",
        legacy: {
          schemaId: "contested_empirical",
          alignedClaims: [],
          modelResponses: [{ modelId: "claude", schemaId: "contested_empirical", ok: true, data: { summary: prose(20, m.next()), disputedClaims: [huge] } }],
        },
      } as never,
    }),
  };
}

/** Milestone-2 Decision Receipt whose Basis section alone is taller than a page. */
function milestone2LongReceipt(): PdfLayoutFixture {
  const m = markerFactory("R");
  const bullets = (n: number, words: number) => Array.from({ length: n }, () => prose(words, m.next()));
  return {
    name: "milestone2-long-receipt",
    minPages: 6,
    markers: m.all,
    record: baseRecord({
      schemaId: "comparison_matrix",
      schemaFamily: "milestone2",
      governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false } as never,
      reportSnapshot: {
        question: "Does a long decision receipt paginate?",
        models: MODELS.map((modelId) => ({ modelId, ok: true })),
        reportTypeLabel: "Comparison Report",
        consensusLevel: "moderate",
        sourceGroundingLevel: "strong",
        reportGeneratedAt: "2026-10-14T11:00:00.000Z",
        milestone2: {
          schemaId: "comparison_matrix",
          result: { tradeoffs: bullets(20, 25), bestUseRecommendations: bullets(6, 20) },
          meta: {} as never,
          decisionReceipt: {
            conclusion: prose(160, m.next()),
            basis: bullets(45, 30),
            assumptions: bullets(8, 20),
            uncertainties: bullets(8, 20),
            limitations: bullets(8, 20),
            sources: bullets(10, 8),
          },
        },
      } as never,
    }),
  };
}

/** Ordinary-size control: must stay a compact, collision-free document. */
function legacyShortControl(): PdfLayoutFixture {
  const m = markerFactory("S");
  const record = baseRecord({
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    reportSnapshot: {
      question: "Short control report",
      models: [{ modelId: "chatgpt", ok: true }, { modelId: "claude", ok: true }],
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-14T11:00:00.000Z",
      legacy: {
        schemaId: "financial_valuation",
        alignedClaims: [],
        modelResponses: [
          { modelId: "chatgpt", schemaId: "financial_valuation", ok: true, data: { thesis: `Short thesis A ${m.next()}`, metrics: [{ label: `P/E ${m.next()}`, value: 18, unit: "x", asOf: "2026", source: "10-K" }] } },
          { modelId: "claude", schemaId: "financial_valuation", ok: true, data: { thesis: `Short thesis B ${m.next()}`, metrics: [{ label: `P/E ${m.next()}`, value: 22, unit: "x", asOf: "2026", source: "10-K" }] } },
        ],
      },
    } as never,
  });
  return { name: "legacy-short-control", minPages: 1, markers: m.all, record };
}

export function pdfLayoutFixtures(): PdfLayoutFixture[] {
  return [legacyLongCards(), legacyHugeSingleItem(), milestone2LongReceipt(), legacyShortControl()];
}
