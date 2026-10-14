/**
 * Adaptive Research Export — PDF layout regression fixtures.
 *
 * Synthetic, deterministic export records sized to exercise pagination:
 * model cards and section bodies taller than one A4 page (the shape that
 * produced overlapping, unreadable cards in Production exports), plus
 * ordinary-size controls; single text units taller than a page; and heading
 * boundary sweeps that put every heading kind at or near a page bottom.
 * Every rendered text unit carries unique markers `#Xnnn#` so the rendered
 * check (scripts/verify-pdf-layout.mjs, renderedLayout.spec.ts) can prove
 * nothing was lost, duplicated or reordered when content paginates.
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

// ─── Single text units taller than a page (R1 MAJOR 2) ───────────────────

/** ONE string carrying many markers: rendered as a single Text unit, so a non-breaking Text would visibly lose its middle. */
function longSingleText(segments: number, wordsPerSegment: number, m: { next: () => string }): string {
  return Array.from({ length: segments }, () => prose(wordsPerSegment, m.next())).join(" ");
}

function legacySynthesis(unifiedAnswer: string, m: { next: () => string }) {
  return {
    unifiedAnswer,
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
      topConsensus: prose(10, m.next()),
      consensusModelCount: 3,
      keyDisagreement: prose(10, m.next()),
      disagreementDetail: prose(10, m.next()),
      disagreementModelCount: 2,
      caveat: prose(8, m.next()),
      recommendedNextSteps: [],
    },
    degraded: false,
  };
}

/** Legacy family: a page-long synthesis answer, a page-long string field, and one object whose single value is page-long. */
function singleTextOverPageLegacy(): PdfLayoutFixture {
  const m = markerFactory("T");
  const unified = longSingleText(24, 45, m);
  const synthesis = legacySynthesis(unified, m);
  const summary = longSingleText(24, 45, m);
  const hugeClaim = { id: "one", claim: longSingleText(24, 45, m), stance: "asserts", confidence: "contested", evidenceType: "theoretical" };
  return {
    name: "single-text-over-page-legacy",
    minPages: 5,
    markers: m.all,
    record: baseRecord({
      schemaId: "contested_empirical",
      schemaFamily: "legacy",
      reportSnapshot: {
        question: "Single text units taller than a page (legacy)",
        models: [{ modelId: "claude", ok: true }],
        reportTypeLabel: "Consensus Analysis",
        consensusLevel: "weak",
        sourceGroundingLevel: "moderate",
        reportGeneratedAt: "2026-10-14T11:00:00.000Z",
        legacy: {
          schemaId: "contested_empirical",
          alignedClaims: [],
          synthesisReport: synthesis,
          modelResponses: [{ modelId: "claude", schemaId: "contested_empirical", ok: true, data: { summary, disputedClaims: [hugeClaim] } }],
        },
      } as never,
    }),
  };
}

/** Milestone-2: a page-long receipt conclusion and a single page-long bullet. */
function singleTextOverPageMilestone2(): PdfLayoutFixture {
  const m = markerFactory("U");
  const conclusion = longSingleText(24, 45, m);
  const bullet = longSingleText(24, 45, m);
  return {
    name: "single-text-over-page-milestone2",
    minPages: 4,
    markers: m.all,
    record: baseRecord({
      schemaId: "comparison_matrix",
      schemaFamily: "milestone2",
      governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false } as never,
      reportSnapshot: {
        question: "Single text units taller than a page (milestone-2)",
        models: MODELS.map((modelId) => ({ modelId, ok: true })),
        reportTypeLabel: "Comparison Report",
        consensusLevel: "moderate",
        sourceGroundingLevel: "strong",
        reportGeneratedAt: "2026-10-14T11:00:00.000Z",
        milestone2: {
          schemaId: "comparison_matrix",
          result: { tradeoffs: [prose(8, m.next())], bestUseRecommendations: [prose(8, m.next())] },
          meta: {} as never,
          decisionReceipt: { conclusion, basis: [bullet], assumptions: [prose(8, m.next())], uncertainties: [], limitations: [], sources: [] },
        },
      } as never,
    }),
  };
}

// ─── Heading boundary sweeps (R1 MAJOR 1) ────────────────────────────────

/**
 * Many short headed blocks after a preamble whose length steps by about one
 * line per variant, so every heading kind (section, model card, field) lands
 * at or near a page bottom in some variant. A stranded heading in ANY
 * variant fails the rendered check.
 */
export const HEADING_SWEEP_STEPS = 16;
const SWEEP_WORDS_PER_STEP = 12;

function legacyHeadingSweep(step: number): PdfLayoutFixture {
  const m = markerFactory("W");
  const synthesis = legacySynthesis(prose(30 + step * SWEEP_WORDS_PER_STEP, m.next()), m);
  const modelResponses = MODELS.map((modelId) => ({
    modelId,
    schemaId: "contested_empirical",
    ok: true,
    data: {
      summary: prose(14, m.next()),
      settledClaims: [{ id: `s-${modelId}`, claim: prose(10, m.next()), stance: "asserts", confidence: "settled", evidenceType: "empirical" }],
      disputedClaims: [{ id: `d-${modelId}`, claim: prose(10, m.next()), stance: "asserts", confidence: "contested", evidenceType: "theoretical" }],
      keyMetrics: [{ label: `Metric ${m.next()}`, value: 42, unit: "pct", asOf: "2025", source: "Fixture" }],
      openQuestions: [prose(8, m.next()), prose(8, m.next())],
    },
  }));
  return {
    name: `heading-sweep-legacy-${String(step).padStart(2, "0")}`,
    minPages: 2,
    markers: m.all,
    record: baseRecord({
      schemaId: "contested_empirical",
      schemaFamily: "legacy",
      reportSnapshot: {
        question: "Heading boundary sweep (legacy)",
        models: MODELS.map((modelId) => ({ modelId, ok: true })),
        reportTypeLabel: "Consensus Analysis",
        consensusLevel: "moderate",
        sourceGroundingLevel: "strong",
        reportGeneratedAt: "2026-10-14T11:00:00.000Z",
        legacy: { schemaId: "contested_empirical", alignedClaims: [], synthesisReport: synthesis, modelResponses },
      } as never,
    }),
  };
}

function milestone2HeadingSweep(step: number): PdfLayoutFixture {
  const m = markerFactory("V");
  const two = () => [prose(10, m.next()), prose(10, m.next())];
  return {
    name: `heading-sweep-milestone2-${String(step).padStart(2, "0")}`,
    minPages: 2,
    markers: m.all,
    record: baseRecord({
      schemaId: "comparison_matrix",
      schemaFamily: "milestone2",
      governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false } as never,
      reportSnapshot: {
        question: "Heading boundary sweep (milestone-2)",
        models: MODELS.map((modelId) => ({ modelId, ok: true })),
        reportTypeLabel: "Comparison Report",
        consensusLevel: "moderate",
        sourceGroundingLevel: "strong",
        reportGeneratedAt: "2026-10-14T11:00:00.000Z",
        milestone2: {
          schemaId: "comparison_matrix",
          result: { tradeoffs: two(), bestUseRecommendations: two() },
          meta: {} as never,
          decisionReceipt: {
            conclusion: prose(150 + step * SWEEP_WORDS_PER_STEP, m.next()),
            basis: two(),
            assumptions: two(),
            uncertainties: two(),
            limitations: two(),
            sources: two(),
          },
        },
      } as never,
    }),
  };
}

/** A second sweep whose step mixes metric rows (≈21 pt) with half-line preamble steps, so headings land at offsets the whole-line sweeps do not reach. */
export const HEADING_SWEEP_MIXED_STEPS = 10;
function legacyHeadingSweepMixed(step: number): PdfLayoutFixture {
  const fixture = legacyHeadingSweep(0);
  const m = markerFactory("X");
  const synthesis = legacySynthesis(prose(24 + step * 6, m.next()), m);
  const modelResponses = MODELS.slice(0, 3).map((modelId) => ({
    modelId,
    schemaId: "contested_empirical",
    ok: true,
    data: {
      summary: prose(16, m.next()),
      keyMetrics: Array.from({ length: 1 + (step % 5) }, () => ({ label: `Metric ${m.next()}`, value: 7, unit: "pct", asOf: "2025", source: "Fixture" })),
      disputedClaims: [{ id: `d-${modelId}`, claim: prose(12, m.next()), stance: "asserts", confidence: "contested", evidenceType: "theoretical" }],
      openQuestions: [prose(10, m.next())],
    },
  }));
  return {
    ...fixture,
    name: `heading-sweep-mixed-${String(step).padStart(2, "0")}`,
    minPages: 1,
    markers: m.all,
    record: { ...fixture.record, reportSnapshot: { ...fixture.record.reportSnapshot, models: MODELS.slice(0, 3).map((modelId) => ({ modelId, ok: true })), legacy: { schemaId: "contested_empirical", alignedClaims: [], synthesisReport: synthesis, modelResponses } } as never },
  };
}

/**
 * The FIRST heading of a content section is the first child of its wrapper —
 * the one position where only the zero-height anchor gives react-pdf a
 * previous sibling. A long question (cover subtitle) pushes that first
 * heading down to the bottom of page 1, step by step.
 */
export const HEADING_SWEEP_FIRST_STEPS = 22;
function firstHeadingSweep(step: number, family: "legacy" | "milestone2"): PdfLayoutFixture {
  const base = family === "legacy" ? legacyHeadingSweep(0) : milestone2HeadingSweep(0);
  const question = prose(340 + step * 5, "?");
  return {
    ...base,
    name: `heading-sweep-first-${family}-${String(step).padStart(2, "0")}`,
    record: { ...base.record, reportSnapshot: { ...base.record.reportSnapshot, question } as never },
  };
}

/**
 * Fields whose values are two to four lines tall at many offsets: a value
 * that fits on the page but whose trailing spacing does not would be moved
 * away from its label if that spacing were a margin.
 */
export const HEADING_SWEEP_FIELD_STEPS = 18;
function fieldValueSweep(step: number): PdfLayoutFixture {
  const fixture = legacyHeadingSweep(0);
  const m = markerFactory("F");
  const synthesis = legacySynthesis(prose(20 + step * 4, m.next()), m);
  const modelResponses = MODELS.slice(0, 4).map((modelId, k) => ({
    modelId,
    schemaId: "contested_empirical",
    ok: true,
    data: {
      summary: prose(22 + ((step + k) % 4) * 10, m.next()),
      settledClaims: [{ id: `s-${modelId}`, claim: prose(18 + ((step * 3 + k) % 4) * 8, m.next()), stance: "asserts", confidence: "settled", evidenceType: "empirical" }],
      disputedClaims: [{ id: `d-${modelId}`, claim: prose(20 + ((step + 2 * k) % 3) * 9, m.next()), stance: "asserts", confidence: "contested", evidenceType: "theoretical" }],
      openQuestions: [prose(16 + ((step + k) % 3) * 10, m.next())],
    },
  }));
  return {
    ...fixture,
    name: `heading-sweep-fields-${String(step).padStart(2, "0")}`,
    minPages: 2,
    markers: m.all,
    record: { ...fixture.record, reportSnapshot: { ...fixture.record.reportSnapshot, models: MODELS.slice(0, 4).map((modelId) => ({ modelId, ok: true })), legacy: { schemaId: "contested_empirical", alignedClaims: [], synthesisReport: synthesis, modelResponses } } as never },
  };
}

export function pdfLayoutFixtures(): PdfLayoutFixture[] {
  return [
    legacyLongCards(),
    legacyHugeSingleItem(),
    milestone2LongReceipt(),
    legacyShortControl(),
    singleTextOverPageLegacy(),
    singleTextOverPageMilestone2(),
    ...Array.from({ length: HEADING_SWEEP_STEPS }, (_, i) => legacyHeadingSweep(i)),
    ...Array.from({ length: HEADING_SWEEP_STEPS }, (_, i) => milestone2HeadingSweep(i)),
    ...Array.from({ length: HEADING_SWEEP_MIXED_STEPS }, (_, i) => legacyHeadingSweepMixed(i)),
    ...Array.from({ length: HEADING_SWEEP_FIRST_STEPS }, (_, i) => firstHeadingSweep(i, "legacy")),
    ...Array.from({ length: HEADING_SWEEP_FIRST_STEPS }, (_, i) => firstHeadingSweep(i, "milestone2")),
    ...Array.from({ length: HEADING_SWEEP_FIELD_STEPS }, (_, i) => fieldValueSweep(i)),
  ];
}
