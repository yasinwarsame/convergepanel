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
import { METRIC_ROW_MAX_VALUE_CHARS } from "@/lib/pdf/AdaptiveResearchDocument";
import r2ReproRecord from "./r2-repro-bull-case.json";
import r3BulletOrphan from "./r3-repro-bullet-orphan.json";
import r3MetricSplit from "./r3-repro-metric-split.json";
import r3CardStub from "./r3-repro-card-stub.json";

export interface PdfLayoutFixture {
  name: string;
  record: AdaptiveResearchExportV1;
  /** Every marker embedded in rendered content, each expected exactly once. */
  markers: string[];
  /** Minimum page count the content must occupy (a guard that the fixture really is long). */
  minPages: number;
  /** Marker pairs that must render on the same page (a metric's label and its value). */
  pairs?: Array<[string, string]>;
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

// ─── R2 corrections ──────────────────────────────────────────────────────

/** The independent R2 reviewer's reproduction (dd5dd913): "BULL CASE" ended page 1 with its 3-line value on page 2. */
function r2ReproBullCase(): PdfLayoutFixture {
  const record = r2ReproRecord as unknown as AdaptiveResearchExportV1;
  const markers = Array.from(new Set(JSON.stringify(record).match(/#[A-Z]+\d{3}#/g) ?? []));
  return { name: "r2-repro-bull-case", minPages: 2, markers, record };
}

/**
 * Field values of exactly-three-line length (react-pdf never splits a Text of
 * ≤ 3 lines) after a label that is not the card's first, on a 2-D grid of
 * preamble length × value length, so the label lands in the few-point window
 * where 2 lines of value would fit but 3 do not.
 */
export const THREE_LINE_GRID = { preamble: 12, value: 6 } as const;
function threeLineValueGrid(a: number, b: number): PdfLayoutFixture {
  const m = markerFactory("G");
  const synthesis = legacySynthesis(prose(20 + 4 * a, m.next()), m);
  const words = 26 + 2 * b;
  const modelResponses = MODELS.slice(0, 4).map((modelId, k) => ({
    modelId,
    schemaId: "financial_valuation",
    ok: true,
    data: {
      thesis: prose(words + k, m.next()),
      bullCase: prose(words + k + 1, m.next()),
      bearCase: prose(words + k + 2, m.next()),
      keyAssumptions: [prose(words, m.next())],
      riskFactors: [prose(words + 1, m.next()), prose(8, m.next())],
    },
  }));
  return {
    name: `three-line-values-${String(a).padStart(2, "0")}-${b}`,
    minPages: 2,
    markers: m.all,
    record: baseRecord({
      schemaId: "financial_valuation",
      schemaFamily: "legacy",
      reportSnapshot: {
        question: "Three-line field values",
        models: MODELS.slice(0, 4).map((modelId) => ({ modelId, ok: true })),
        reportTypeLabel: "Financial Analysis",
        consensusLevel: "moderate",
        sourceGroundingLevel: "strong",
        reportGeneratedAt: "2026-10-14T11:00:00.000Z",
        legacy: { schemaId: "financial_valuation", alignedClaims: [], synthesisReport: synthesis, modelResponses },
      } as never,
    }),
  };
}

/** "Disagreement" sub-label near page bottoms: question × panel-conclusion length grid; the disagreement text is 3 lines. */
export const DISAGREEMENT_GRID = { question: 3, answer: 25 } as const;
function disagreementGrid(a: number, b: number): PdfLayoutFixture {
  const m = markerFactory("D");
  const synthesis = legacySynthesis(prose(200 + 4 * b, m.next()), m);
  synthesis.verdictCard.keyDisagreement = prose(30, m.next());
  const record = baseRecord({
    schemaId: "contested_empirical",
    schemaFamily: "legacy",
    reportSnapshot: {
      question: prose(3 + 8 * a, "?"),
      models: [{ modelId: "chatgpt", ok: true }],
      reportTypeLabel: "Consensus Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-14T11:00:00.000Z",
      legacy: {
        schemaId: "contested_empirical",
        alignedClaims: [],
        synthesisReport: synthesis,
        modelResponses: [{ modelId: "chatgpt", schemaId: "contested_empirical", ok: true, data: { summary: prose(12, m.next()) } }],
      },
    } as never,
  });
  // The replaced default disagreement text's marker is not in the record.
  const used = new Set(JSON.stringify(record).match(/#[A-Z]+\d{3}#/g) ?? []);
  return { name: `disagreement-label-${a}-${String(b).padStart(2, "0")}`, minPages: 1, markers: m.all.filter((x) => used.has(x)), record };
}

/** Every verdict text (consensus, disagreement, detail, caveat) a single Text taller than a page. */
function pageLongVerdictTexts(): PdfLayoutFixture {
  const m = markerFactory("K");
  const synthesis = legacySynthesis(prose(20, m.next()), m);
  synthesis.verdictCard.topConsensus = longSingleText(24, 45, m);
  synthesis.verdictCard.keyDisagreement = longSingleText(24, 45, m);
  synthesis.verdictCard.disagreementDetail = longSingleText(24, 45, m);
  synthesis.verdictCard.caveat = longSingleText(24, 45, m);
  // Markers were minted out of render order above; the canonical order is derived from the record, so keep the set.
  const record = baseRecord({
    schemaId: "contested_empirical",
    schemaFamily: "legacy",
    reportSnapshot: {
      question: "Page-long verdict texts",
      models: [{ modelId: "claude", ok: true }],
      reportTypeLabel: "Consensus Analysis",
      consensusLevel: "weak",
      sourceGroundingLevel: "moderate",
      reportGeneratedAt: "2026-10-14T11:00:00.000Z",
      legacy: {
        schemaId: "contested_empirical",
        alignedClaims: [],
        synthesisReport: synthesis,
        modelResponses: [{ modelId: "claude", schemaId: "contested_empirical", ok: true, data: { summary: prose(12, m.next()) } }],
      },
    } as never,
  });
  const used = new Set(JSON.stringify(record).match(/#[A-Z]+\d{3}#/g) ?? []);
  return { name: "page-long-verdict-texts", minPages: 6, markers: m.all.filter((x) => used.has(x)), record };
}

// ─── R3 corrections ──────────────────────────────────────────────────────

const MARKER_RE = /#[A-Z]+\d{3}#/g;

/** Every metric whose label and value both carry a marker → that pair must render on one page. */
function metricPairs(record: unknown): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o.label === "string" && "value" in o) {
      const a = o.label.match(MARKER_RE)?.[0];
      const b = `${String(o.value ?? "")} ${String(o.unit ?? "")}`.match(MARKER_RE)?.[0];
      if (a && b) pairs.push([a, b]);
    }
    Object.values(o).forEach(visit);
  };
  visit(record);
  return pairs;
}

function fromRecordJson(name: string, json: unknown, minPages: number): PdfLayoutFixture {
  const record = json as AdaptiveResearchExportV1;
  const markers = Array.from(new Set(JSON.stringify(record).match(MARKER_RE) ?? []));
  return { name, minPages, markers, record, pairs: metricPairs(record) };
}

/** The independent R3 reviewer's reproductions (de38f10): a lone bullet mark, a metric label/value split, an empty card stub. */
function r3Repros(): PdfLayoutFixture[] {
  return [fromRecordJson("r3-repro-bullet-orphan", r3BulletOrphan, 2), fromRecordJson("r3-repro-metric-split", r3MetricSplit, 1), fromRecordJson("r3-repro-card-stub", r3CardStub, 2)];
}

/**
 * Bullets of 2–4 lines (react-pdf moves a ≤ 3-line text whole) after a
 * conclusion whose length steps through a page bottom, in every receipt list.
 */
export const BULLET_GRID = { conclusion: 16, bullet: 4 } as const;
function bulletGrid(a: number, b: number): PdfLayoutFixture {
  const m = markerFactory("B");
  const items = (n: number) => Array.from({ length: n }, (_, i) => prose(18 + b * 8 + (i % 3) * 4, m.next()));
  return {
    name: `bullet-grid-${String(a).padStart(2, "0")}-${b}`,
    minPages: 2,
    markers: m.all,
    record: baseRecord({
      schemaId: "comparison_matrix",
      schemaFamily: "milestone2",
      governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false } as never,
      reportSnapshot: {
        question: "Bullet integrity grid",
        models: MODELS.map((modelId) => ({ modelId, ok: true })),
        reportTypeLabel: "Comparison Report",
        consensusLevel: "moderate",
        sourceGroundingLevel: "strong",
        reportGeneratedAt: "2026-10-14T11:00:00.000Z",
        milestone2: {
          schemaId: "comparison_matrix",
          result: { tradeoffs: items(3), bestUseRecommendations: items(2) },
          meta: {} as never,
          decisionReceipt: { conclusion: prose(120 + a * 5, m.next()), basis: items(6), assumptions: items(4), uncertainties: items(3), limitations: items(2), sources: items(2) },
        },
      } as never,
    }),
  };
}

/** Metric labels of 1–3 lines at offsets that step through page bottoms; every label/value pair must stay on one page. */
export const METRIC_GRID = { offset: 16, label: 4 } as const;
function metricGrid(a: number, b: number): PdfLayoutFixture {
  const m = markerFactory("N");
  const synthesis = legacySynthesis(prose(20 + 5 * a, m.next()), m);
  const metric = (k: number) => {
    const label = `${m.next()} ${prose(6 + b * 9 + (k % 3) * 5, "").trim()}`;
    return { label, value: 1000 + k, unit: `USD ${m.next()}`, asOf: "2025", source: "Fixture" };
  };
  const modelResponses = MODELS.slice(0, 4).map((modelId, k) => ({
    modelId,
    schemaId: "financial_valuation",
    ok: true,
    data: { thesis: prose(14, m.next()), metrics: Array.from({ length: 5 }, (_, i) => metric(k * 5 + i)) },
  }));
  const record = baseRecord({
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    reportSnapshot: {
      question: "Metric pairing grid",
      models: MODELS.slice(0, 4).map((modelId) => ({ modelId, ok: true })),
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-14T11:00:00.000Z",
      legacy: { schemaId: "financial_valuation", alignedClaims: [], synthesisReport: synthesis, modelResponses },
    } as never,
  });
  return { name: `metric-grid-${String(a).padStart(2, "0")}-${b}`, minPages: 2, markers: m.all, record, pairs: metricPairs(record) };
}

/** A metric whose label alone is taller than a page: the paginating paragraph fallback (beyond the row bounds). */
function pageLongMetricLabel(): PdfLayoutFixture {
  const m = markerFactory("P");
  const label = longSingleText(18, 45, m);
  const record = baseRecord({
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    reportSnapshot: {
      question: "Page-long metric label",
      models: [{ modelId: "chatgpt", ok: true }],
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-14T11:00:00.000Z",
      legacy: {
        schemaId: "financial_valuation",
        alignedClaims: [],
        modelResponses: [{ modelId: "chatgpt", schemaId: "financial_valuation", ok: true, data: { thesis: prose(10, m.next()), metrics: [{ label, value: 5, unit: "pct", asOf: "2025", source: "x" }] } }],
      },
    } as never,
  });
  return { name: "page-long-metric-label", minPages: 2, markers: m.all, record };
}

/** `n` characters of the widest glyph, breakable every 9 (the tallest wrap a bounded metric row can produce). */
function widest(n: number, marker: string): string {
  const head = `${marker} `;
  let out = head;
  while (out.length < n) out += (out.length - head.length) % 10 === 9 ? " " : "W";
  return out.slice(0, n).trimEnd();
}

/**
 * Metric rows at their extremes, in the widest glyph: a label taller than a
 * page beside a value at the value bound (the value is non-breaking), then
 * long labels beside bound values.
 */
function metricRowExtremes(): PdfLayoutFixture {
  const m = markerFactory("W");
  const bound = () => widest(METRIC_ROW_MAX_VALUE_CHARS - 4, m.next());
  const metrics = [
    // One marker per label: a label's later lines read BELOW its value's line, so further markers would read after it.
    { label: widest(2400, m.next()), value: bound(), unit: "USD", asOf: "2025", source: "x" },
    ...Array.from({ length: 3 }, () => ({ label: widest(600, m.next()), value: bound(), unit: "USD", asOf: "2025", source: "x" })),
  ];
  const record = baseRecord({
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    reportSnapshot: {
      question: "Metric rows at their extremes",
      models: [{ modelId: "chatgpt", ok: true }],
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-14T11:00:00.000Z",
      legacy: {
        schemaId: "financial_valuation",
        alignedClaims: [],
        modelResponses: [{ modelId: "chatgpt", schemaId: "financial_valuation", ok: true, data: { thesis: prose(10, m.next()), metrics } }],
      },
    } as never,
  });
  return { name: "metric-row-extremes", minPages: 3, markers: m.all, record, pairs: metricPairs(record) };
}

/**
 * Cards whose FIRST field is a metric[] (the card and section headings keep
 * the longer metric distance): first rows with 1–3-line values (widest glyph)
 * beside 1–8-line labels, behind a question whose length steps through page
 * bottoms.
 */
export const METRIC_FIRST_GRID = { question: 14, row: 4 } as const;
function metricFirstGrid(a: number, b: number): PdfLayoutFixture {
  const m = markerFactory("F");
  const modelResponses = Array.from({ length: 6 }, (_, k) => ({
    modelId: MODELS[k % MODELS.length],
    schemaId: "financial_valuation",
    ok: true,
    data: {
      metrics: Array.from({ length: 1 + (k % 3) }, (_, i) => ({
        label: `${m.next()} ${prose(4 + ((b + k + i) % 4) * 22, "").trim()}`,
        value: widest(Math.min(METRIC_ROW_MAX_VALUE_CHARS - 4, 8 + ((b + k) % 3) * 10), m.next()),
        unit: "USD",
        asOf: "2025",
        source: "Fixture",
      })),
    },
  }));
  const record = baseRecord({
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    reportSnapshot: {
      question: prose(2 + 9 * a, "?"),
      models: MODELS.map((modelId) => ({ modelId, ok: true })),
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-14T11:00:00.000Z",
      legacy: { schemaId: "financial_valuation", alignedClaims: [], modelResponses },
    } as never,
  });
  return { name: `metric-first-${String(a).padStart(2, "0")}-${b}`, minPages: 2, markers: m.all, record, pairs: metricPairs(record) };
}

/**
 * Card and section headings in their critical window: many one-field cards
 * whose first value is 3 lines, behind a question whose length steps through
 * page bottoms (a card heading needs the first label + 3 lines + closing; the
 * "Model responses" label needs a whole card heading block plus that).
 */
export const CARD_PRESENCE_GRID = { question: 14, first: 6 } as const;
function cardPresenceGrid(a: number, b: number): PdfLayoutFixture {
  const m = markerFactory("C");
  const modelResponses = Array.from({ length: 10 }, (_, k) => ({
    modelId: MODELS[k % MODELS.length],
    schemaId: "financial_valuation",
    ok: true,
    // The first field is NOT the card's last (a closing text may split 1 + 2 lines): its 3-line value needs all 3 lines.
    data: { thesis: prose(k === 0 ? 8 + 28 * b : 34 + (k % 3) * 2, m.next()), bullCase: prose(8, m.next()) },
  }));
  const record = baseRecord({
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    reportSnapshot: {
      question: prose(2 + 9 * a, "?"),
      models: MODELS.map((modelId) => ({ modelId, ok: true })),
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-14T11:00:00.000Z",
      legacy: { schemaId: "financial_valuation", alignedClaims: [], modelResponses },
    } as never,
  });
  return { name: `card-presence-${String(a).padStart(2, "0")}-${b}`, minPages: 2, markers: m.all, record };
}


// ─── Pass-3 falsifier follow-up: fine-offset positions ──────────────────
/** Exactly `n` lines of body text (explicit line breaks), the marker on the first line. */
function lines(n: number, mark: string): string {
  return [`${mark} Line one`, ...Array.from({ length: n - 1 }, (_, i) => `Line ${i + 2}`)].join("\n");
}
/**
 * A lead card of `t` body lines (15 pt each) and `i` one-line bullets (17 pt
 * each) shifts everything after it by 15t + 17i (every residue mod 15 for
 * i = 0..14), so the later cards' metric rows and metric-first headings cross
 * page bottoms at 1 pt resolution. A dense sweep (t 0..49 × i 0..14, archived
 * with the PR evidence) found the positions below: each one detaches a metric
 * value from its label when the value's keep or its row anchor is removed, or
 * strands a metric-first card heading whose keep falls to 40 pt.
 */
export const FINE_OFFSET_CASES: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [14, 14], [20, 9], [27, 3], [36, 11], [46, 2],
  [4, 3], [5, 2], [41, 13], [49, 6],
];
function fineOffset(t: number, i: number): PdfLayoutFixture {
  const m = markerFactory("Q");
  const metric = (labelLines: number, valueChars: number) => {
    const label = lines(labelLines, m.next());
    const value = valueChars > 0 ? widest(valueChars, m.next()) : m.next();
    return { label, value, unit: "", asOf: "2025", source: "Fixture" };
  };
  const card1 = { thesis: lines(1 + t, m.next()), ...(i > 0 ? { keyAssumptions: Array.from({ length: i }, () => `Assumption ${m.next()}`) } : {}) };
  const card2 = { metrics: [metric(2, 28), metric(3, 0), metric(1, 0), metric(4, 18)], bullCase: lines(1, m.next()) };
  const card3 = { thesis: lines(1, m.next()), metrics: [metric(2, 28), metric(3, 0), metric(5, 0)], riskFactors: [lines(1, m.next()), lines(2, m.next()), lines(3, m.next())] };
  const card4 = { thesis: lines(2, m.next()), metrics: [metric(1, 28), metric(6, 0)] };
  const card5 = { metrics: [metric(3, 28), metric(2, 0)] };
  const modelResponses = [card1, card2, card3, card4, card5].map((data, k) => ({ modelId: MODELS[k], schemaId: "financial_valuation", ok: true, data }));
  const record = baseRecord({
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    reportSnapshot: {
      question: "Fine offset sweep",
      models: MODELS.map((modelId) => ({ modelId, ok: true })),
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-14T11:00:00.000Z",
      legacy: { schemaId: "financial_valuation", alignedClaims: [], modelResponses },
    } as never,
  });
  return { name: `fine-offset-${t}-${String(i).padStart(2, "0")}`, minPages: 2, markers: m.all, record, pairs: metricPairs(record) };
}
/**
 * The "Model responses" label before a metric-first card: the synthesis answer
 * (15 pt lines) and caveat (12.6 pt muted lines) step the label through page
 * bottoms at 0.6 pt resolution. From a dense sweep (j 0..49 × k 0..24): each
 * position strands the label when it keeps only the non-metric distance.
 */
export const FINE_SECTION_CASES: ReadonlyArray<readonly [number, number]> = [
  [5, 24], [9, 19], [13, 15], [17, 10], [21, 5], [25, 0],
];
function fineSection(j: number, k: number): PdfLayoutFixture {
  const m = markerFactory("U");
  const synthesis = legacySynthesis(lines(30 + j, m.next()), m);
  synthesis.verdictCard.caveat = [`${m.next()} Caveat`, ...Array.from({ length: k }, (_, x) => `Caveat ${x + 2}`)].join("\n");
  const label = lines(3, m.next());
  const value = widest(28, m.next());
  const record = baseRecord({
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    reportSnapshot: {
      question: "Fine section sweep",
      models: [{ modelId: "chatgpt", ok: true }],
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-14T11:00:00.000Z",
      legacy: {
        schemaId: "financial_valuation",
        alignedClaims: [],
        synthesisReport: synthesis,
        modelResponses: [{ modelId: "chatgpt", schemaId: "financial_valuation", ok: true, data: { metrics: [{ label, value, unit: "", asOf: "2025", source: "x" }], bullCase: lines(2, m.next()) } }],
      },
    } as never,
  });
  const used = new Set(JSON.stringify(record).match(/#[A-Z]+\d{3}#/g) ?? []);
  return { name: `fine-section-${j}-${k}`, minPages: 2, markers: m.all.filter((x) => used.has(x)), record, pairs: metricPairs(record) };
}

// ─── Pass 4 (R4): failed / field-less model cards, long metric values, closing metric rows ──
/**
 * A lead card of 1 + `t` body lines and `i` one-line bullets shifts every later
 * card through page bottoms at 1 pt resolution (as `fineOffset`). Positions
 * come from dense sweeps (t 0..49 × i 0..14, 750 documents each, archived with
 * the PR evidence):
 *  - "failed": failed models (`ok: false`, `data: null`) and a model with no
 *    shown field (`data: {}`): each card is its label alone. Before the
 *    correction such a card closed 4.6 pt under its label (all 2,250 cards of
 *    the sweep); the positions here end a page on such a card, three of them
 *    flush with the bottom padding;
 *  - "long-value": metric values over METRIC_ROW_MAX_VALUE_CHARS beside 2- to
 *    6-line labels. As one "label — value" paragraph the value split away from
 *    the start of its label (107 of 750 documents);
 *  - "first-closing" / "later-closing": a card whose only (closing) metric row
 *    holds a 4- to 6-line label beside a ≤ 32-character value, as the card's
 *    first field or after a text field. Each position strands the "Metrics"
 *    label when the metric-first card heading keeps only the ordinary card
 *    distance (82: 29 of 750) or the metric[] field label only the ordinary
 *    field distance (65: 50 of 750).
 */
export const PASS4_CASES: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>> = {
  failed: [[0, 7], [29, 14], [43, 12], [34, 7], [9, 0]],
  "long-value": [[5, 14], [11, 6], [13, 11], [16, 9], [19, 6], [22, 3]],
  "first-closing": [[0, 5], [4, 1], [33, 11], [38, 7], [40, 13], [42, 11]],
  "later-closing": [[0, 3], [18, 11], [29, 11], [34, 7], [39, 2], [42, 10]],
};
function pass4Boundary(kind: string, t: number, i: number): PdfLayoutFixture {
  const m = markerFactory("V");
  const metric = (labelLines: number, value: string) => ({ label: lines(labelLines, m.next()), value: `${m.next()} ${value}`, unit: "", asOf: "2025", source: "Fixture" });
  const bounded = (labelLines: number, chars: number) => ({ label: lines(labelLines, m.next()), value: widest(chars, m.next()), unit: "", asOf: "2025", source: "Fixture" });
  const long = (n: number) => "14.2x to 16.8x (median 15.1x; dispersion widened after the guidance cut and revised capital plan) ".repeat(3).slice(0, n);
  const lead = { thesis: lines(1 + t, m.next()), ...(i > 0 ? { keyAssumptions: Array.from({ length: i }, () => `Assumption ${m.next()}`) } : {}) };
  const cards: Array<Record<string, unknown> | null> =
    kind === "failed"
      ? [null, {}, { thesis: lines(1, m.next()) }, null, { thesis: lines(2, m.next()) }]
      : kind === "long-value"
        ? [
            { thesis: lines(1, m.next()), metrics: [metric(3, long(110))] },
            { metrics: [metric(4, long(60)), metric(2, long(40))] },
            { thesis: lines(1, m.next()), metrics: [metric(5, long(130)), metric(6, long(45))] },
          ]
        : kind === "first-closing"
          ? [{ metrics: [bounded(4, 28)] }, { metrics: [bounded(5, 30)] }, { metrics: [bounded(6, 24)] }]
          : [{ thesis: lines(1, m.next()), metrics: [bounded(4, 28)] }, { thesis: lines(1, m.next()), metrics: [bounded(5, 30)] }, { thesis: lines(1, m.next()), metrics: [bounded(6, 24)] }];
  const modelResponses = [lead, ...cards].map((data, k) => ({ modelId: MODELS[k % MODELS.length] + (k >= MODELS.length ? `-${k}` : ""), schemaId: "financial_valuation", ok: data !== null, data }));
  const record = baseRecord({
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    reportSnapshot: {
      question: "Pass 4 boundary",
      models: modelResponses.map((r) => ({ modelId: r.modelId, ok: r.ok })),
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-14T11:00:00.000Z",
      legacy: { schemaId: "financial_valuation", alignedClaims: [], modelResponses },
    } as never,
  });
  return { name: `${kind}-${t}-${String(i).padStart(2, "0")}`, minPages: 1, markers: m.all, record, pairs: metricPairs(record) };
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
    r2ReproBullCase(),
    ...Array.from({ length: THREE_LINE_GRID.preamble * THREE_LINE_GRID.value }, (_, i) => threeLineValueGrid(Math.floor(i / THREE_LINE_GRID.value), i % THREE_LINE_GRID.value)),
    ...Array.from({ length: DISAGREEMENT_GRID.question * DISAGREEMENT_GRID.answer }, (_, i) => disagreementGrid(Math.floor(i / DISAGREEMENT_GRID.answer), i % DISAGREEMENT_GRID.answer)),
    pageLongVerdictTexts(),
    ...r3Repros(),
    ...Array.from({ length: BULLET_GRID.conclusion * BULLET_GRID.bullet }, (_, i) => bulletGrid(Math.floor(i / BULLET_GRID.bullet), i % BULLET_GRID.bullet)),
    ...Array.from({ length: METRIC_GRID.offset * METRIC_GRID.label }, (_, i) => metricGrid(Math.floor(i / METRIC_GRID.label), i % METRIC_GRID.label)),
    pageLongMetricLabel(),
    metricRowExtremes(),
    ...Array.from({ length: METRIC_FIRST_GRID.question * METRIC_FIRST_GRID.row }, (_, i) => metricFirstGrid(Math.floor(i / METRIC_FIRST_GRID.row), i % METRIC_FIRST_GRID.row)),
    ...Array.from({ length: CARD_PRESENCE_GRID.question * CARD_PRESENCE_GRID.first }, (_, i) => cardPresenceGrid(Math.floor(i / CARD_PRESENCE_GRID.first), i % CARD_PRESENCE_GRID.first)),
    ...FINE_OFFSET_CASES.map(([t, i]) => fineOffset(t, i)),
    ...FINE_SECTION_CASES.map(([j, k]) => fineSection(j, k)),
    ...Object.entries(PASS4_CASES).flatMap(([kind, cases]) => cases.map(([t, i]) => pass4Boundary(kind, t, i))),
  ];
}
