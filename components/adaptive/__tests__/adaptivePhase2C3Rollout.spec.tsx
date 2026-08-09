/**
 * Adaptive Synthesis Report, Phase 2C-3 — promotes financial_valuation,
 * forecast_speculative, and creative_generative into the same
 * progressive-disclosure layout already proven for the 5 schemas promoted
 * in Phase 2 pilot / 2C-2, completing all 8 legacy-active schemas 2C-1's
 * persistence foundation covers.
 *
 * creative_generative is structurally different from every other member of
 * this family: it never produces alignedClaims/gate/synthesisReport (no
 * claim/metric/scenario fields), so this file also covers the
 * absent-gate/synthesisReport rendering path specifically, and proves the
 * PHASE2_PILOT_SCHEMAS check now runs BEFORE the generic
 * `!gate || !synthesisReport` fallback so creative_generative actually
 * reaches its promoted layout instead of falling through to the tri-tab
 * shell.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { parsePersistedLegacyAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { adaptPersistedLegacyOutputToPanelPayload } from "@/lib/user/adaptivePersistedOutputAdapter";
import { AdaptiveModelResult, AdaptiveSynthesisReport, AlignedClaim, QueryClassification, QueryType } from "@/lib/adaptiveSchema/types";
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

function synthesisReportFixture(overrides: Partial<AdaptiveSynthesisReport> = {}): AdaptiveSynthesisReport {
  return {
    unifiedAnswer: "Panel-derived conclusion for this question.",
    panelVerdict: "Panel converges with caveats.",
    gate: "caution",
    runCertainty: 0.65,
    whereModelsAgree: [],
    whereModelsDisagree: [],
    certaintyAssessment: "Run certainty 65%.",
    narrativeSections: [],
    executiveSummary: "Summary.",
    disagreements: [],
    biasAndBlindSpots: [],
    biasEmptyReason: "insufficient_models",
    panelCoverageGaps: [],
    diagnostics: {
      citedClaimCount: 0,
      totalClaimCount: 0,
      evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 },
      homogeneityFlag: false,
      meanAgreement: 0.6,
    },
    verdictCard: {
      question: "A question",
      topConsensus: "Models broadly agree on the core answer.",
      consensusModelCount: 2,
      keyDisagreement: "Models disagree on a secondary detail.",
      disagreementDetail: "One model qualifies the answer differently.",
      disagreementModelCount: 1,
      caveat: "Evidence quality varies across sources.",
      recommendedNextSteps: [],
    },
    degraded: false,
    ...overrides,
  };
}

const GATE_FIXTURE = { status: "caution" as const, runCertainty: 0.65, loadBearingSplitCount: 1, loadBearingClaims: [] };

function claimFixture(overrides: Partial<AlignedClaim> = {}): AlignedClaim {
  return {
    id: "c1",
    claimText: "A claim.",
    cells: [{ modelId: "chatgpt" as ModelId, stance: "agrees", rawStance: "asserts", confidence: "majority_view", excerpt: "x" }],
    agreementScore: 1,
    certaintyScore: 0.9,
    status: "consensus",
    ...overrides,
  } as AlignedClaim;
}

const CLAIMS_MATRIX_SCHEMAS = ["financial_valuation", "forecast_speculative"] as const;
const ALL_2C3_SCHEMAS = ["financial_valuation", "forecast_speculative", "creative_generative"] as const;

const FIXTURE_DATA: Record<(typeof ALL_2C3_SCHEMAS)[number], Record<string, unknown>> = {
  financial_valuation: {
    thesis: "The company is undervalued relative to growth.",
    metrics: [
      { label: "P/E", value: 18, unit: "x", asOf: "2026-Q2", source: "10-Q" },
      { label: "P/E", value: 22, unit: "x", asOf: "2026-Q2", source: "10-Q" },
    ],
    bullCase: "Margin expansion continues.",
    bearCase: "Growth decelerates faster than priced in.",
    keyAssumptions: ["Revenue growth stays above 10%.", "Discount rate of 9%."],
    riskFactors: ["Macro slowdown."],
  },
  forecast_speculative: {
    scenarios: [
      { label: "Baseline", probability: 0.6, narrative: "Trends continue.", leadingIndicators: ["Stable growth"] },
      { label: "Upside", probability: 0.4, narrative: "Acceleration.", leadingIndicators: ["Demand surge"] },
    ],
    baseRates: ["Historically this occurs ~40% of the time."],
    keyUncertainties: ["Policy response."],
  },
  creative_generative: {
    output: "A short poem about autumn leaves falling gently to the ground.",
    styleNotes: ["Free verse", "Nature imagery"],
  },
};

const DEDICATED_VIEW_MARKERS: Record<(typeof ALL_2C3_SCHEMAS)[number], RegExp> = {
  financial_valuation: /bull case/i,
  forecast_speculative: /base rates/i,
  creative_generative: /autumn leaves falling gently/i,
};

function renderSchema(
  schemaId: (typeof ALL_2C3_SCHEMAS)[number],
  opts: { alignedClaims?: AlignedClaim[]; synthesisReport?: AdaptiveSynthesisReport; withVerification?: boolean; extraData?: Record<string, unknown> } = {}
) {
  const schema = SCHEMA_REGISTRY[schemaId];
  const data = { ...FIXTURE_DATA[schemaId], ...opts.extraData };
  const results = [modelResult("chatgpt", schemaId, data), modelResult("claude", schemaId, data)];
  const classification = baseClassification(schemaId);
  const withVerification = opts.withVerification ?? schemaId !== "creative_generative";

  const props: Record<string, unknown> = {
    schema,
    classification,
    results,
    question: "A representative question",
  };
  if (withVerification) {
    props.alignedClaims = opts.alignedClaims ?? [claimFixture()];
    props.gate = GATE_FIXTURE;
    props.synthesisReport = opts.synthesisReport ?? synthesisReportFixture();
  }

  return renderToStaticMarkup(createElement(AdaptivePanelResponse, props as any));
}

describe("Phase 2C-3 — dedicated renderer, report type, no tab UI, no JSON leak", () => {
  it.each(ALL_2C3_SCHEMAS)("%s: renders its dedicated view, no List/Compare tab UI, no serialized JSON", (schemaId) => {
    const html = renderSchema(schemaId);
    expect(html).toMatch(DEDICATED_VIEW_MARKERS[schemaId]);
    expect(html).not.toMatch(/list view|compare view/i);
    expect(html).not.toMatch(/\\"thesis\\"/);
    expect(html).not.toMatch(/\\"output\\"/);
  });
});

describe("Phase 2C-3 — primary answer before secondary evidence, progressive disclosure", () => {
  const collapsibleLabels = [/model responses/i, /panel evidence|review.{0,10}governance/i];

  it.each(ALL_2C3_SCHEMAS)("%s: dedicated view appears before the collapsed sections, all collapsed by default", (schemaId) => {
    const html = renderSchema(schemaId);
    const dedicatedIndex = html.search(DEDICATED_VIEW_MARKERS[schemaId]);
    const modelResponsesIndex = html.search(/model responses/i);

    expect(dedicatedIndex).toBeGreaterThan(-1);
    expect(modelResponsesIndex).toBeGreaterThan(-1);
    expect(dedicatedIndex).toBeLessThan(modelResponsesIndex);

    for (const label of collapsibleLabels) {
      expect(html).toMatch(label);
    }
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it.each(CLAIMS_MATRIX_SCHEMAS)("%s: PrimarySynthesisStrip's consensus/disagreement headline appears before secondary sections", (schemaId) => {
    const html = renderSchema(schemaId);
    const primaryIndex = html.search(/models agree/i);
    const modelResponsesIndex = html.search(/model responses/i);
    expect(primaryIndex).toBeGreaterThan(-1);
    expect(primaryIndex).toBeLessThan(modelResponsesIndex);
  });
});

describe("financial_valuation — range/assumption/sensitivity semantics", () => {
  it("preserves each model's own metric value/unit side by side — never collapses to a single averaged number", () => {
    const html = renderSchema("financial_valuation");
    // Both models' distinct P/E values must survive, not a computed midpoint.
    expect(html).toMatch(/18/);
    expect(html).toMatch(/22/);
    expect(html).not.toMatch(/\b20\b\s*x/); // the naive average — must never appear as if it were a real reported value
  });

  it("key assumptions remain visible in primary content, distinct from the valuation itself", () => {
    const html = renderSchema("financial_valuation");
    expect(html).toMatch(/key assumptions/i);
    expect(html).toMatch(/revenue growth stays above 10%/i);
    expect(html).toMatch(/discount rate of 9%/i);
  });

  it("risk factors (sensitivity-relevant) remain visible and distinct from bull/bear case narrative", () => {
    const html = renderSchema("financial_valuation");
    expect(html).toMatch(/risk factors/i);
    expect(html).toMatch(/macro slowdown/i);
    const lower = html.toLowerCase();
    expect(lower.indexOf("risk factors")).not.toEqual(lower.indexOf("bull case"));
  });

  it("units (e.g. 'x' multiple) remain attached to their values, never stripped", () => {
    const html = renderSchema("financial_valuation");
    expect(html).toMatch(/18\s*x|18<\/td>\s*x/i);
  });

  it("model agreement (PrimarySynthesisStrip) does not replace or substitute for the metrics table — both are present, separately", () => {
    const html = renderSchema("financial_valuation");
    expect(html).toMatch(/models agree/i);
    expect(html).toMatch(/metrics/i);
    const lower = html.toLowerCase();
    expect(lower.indexOf("models agree")).not.toEqual(lower.indexOf("metrics"));
  });
});

describe("forecast_speculative — scenario/probability semantics", () => {
  it("scenarios remain labeled scenarios, each with its own probability — never presented as a single expected outcome", () => {
    const html = renderSchema("forecast_speculative");
    expect(html).toMatch(/scenarios/i);
    expect(html).toMatch(/baseline/i);
    expect(html).toMatch(/upside/i);
    expect(html).toMatch(/60%/);
    expect(html).toMatch(/40%/);
  });

  it("a scenario without a numeric probability in the source data never receives a fabricated percentage", () => {
    const html = renderSchema("forecast_speculative", {
      extraData: {
        scenarios: [{ label: "Baseline", probability: 0.6, narrative: "Trends continue.", leadingIndicators: [] }],
      },
    });
    // Scope the check to the Scenarios card itself — the rest of the page
    // (TopSummaryBar/PrimarySynthesisStrip) legitimately shows unrelated
    // percentages (run certainty, etc.) that must not be mistaken for a
    // second, fabricated scenario probability.
    const scenariosStart = html.search(/Scenarios/i);
    const scenariosEnd = html.search(/Base rates/i);
    const scenariosSection = html.slice(scenariosStart, scenariosEnd === -1 ? undefined : scenariosEnd);
    const percentMatches = scenariosSection.match(/\d+%/g) || [];
    // Two models both reported the same single 60% scenario, so the real
    // figure may legitimately repeat (one bar per model) — the invariant is
    // that no OTHER percentage ever appears, never a fabricated one.
    expect(percentMatches.length).toBeGreaterThan(0);
    expect(new Set(percentMatches)).toEqual(new Set(["60%"]));
  });

  it("base rates (observed historical fact) remain a separate section from scenarios (speculative) and key uncertainties", () => {
    const html = renderSchema("forecast_speculative");
    expect(html).toMatch(/base rates/i);
    expect(html).toMatch(/key uncertainties/i);
    const lower = html.toLowerCase();
    expect(lower.indexOf("base rates")).not.toEqual(lower.indexOf("scenarios"));
    expect(lower.indexOf("key uncertainties")).not.toEqual(lower.indexOf("base rates"));
  });

  it("disagreement about the baseline outlook (PrimarySynthesisStrip) remains visible in primary content", () => {
    const html = renderSchema("forecast_speculative");
    expect(html).toMatch(/models disagree on a secondary detail/i);
  });

  it("uncertainty (caveat) is not suppressed by full model coverage", () => {
    const html = renderSchema("forecast_speculative", {
      alignedClaims: [claimFixture({ status: "consensus" }), claimFixture({ id: "c2", status: "consensus" })],
    });
    expect(html).toMatch(/evidence quality varies across sources/i);
  });
});

describe("creative_generative — empty-claims / absent-gate rendering, no fabricated consensus", () => {
  it("renders successfully with alignedClaims=[], gate absent, synthesisReport absent — the structurally-always-true state for this schema", () => {
    expect(() => renderSchema("creative_generative")).not.toThrow();
    const html = renderSchema("creative_generative");
    expect(html).toMatch(DEDICATED_VIEW_MARKERS.creative_generative);
  });

  it("never renders PrimarySynthesisStrip's 'Models agree'/'Models disagree' framing — there is no synthesisReport to drive it", () => {
    const html = renderSchema("creative_generative");
    expect(html).not.toMatch(/models agree/i);
    expect(html).not.toMatch(/models disagree/i);
  });

  it("never renders a claims matrix or agreement/disagreement map — there are no claims to compare", () => {
    const html = renderSchema("creative_generative");
    expect(html).not.toMatch(/cross-model comparison/i);
    expect(html).not.toMatch(/agreement.{0,5}disagreement/i);
  });

  it("does not crash or render a broken empty Panel Evidence section — it simply omits content it doesn't have, per the existing PanelEvidenceSection null-return", () => {
    const html = renderSchema("creative_generative");
    // No literal empty/broken matrix table markup.
    expect(html).not.toMatch(/no claims to compare/i);
  });

  it("Review & Governance still appears (status is independent of gate/synthesisReport) — absence of one signal doesn't hide the whole section", () => {
    const html = renderSchema("creative_generative");
    expect(html).toMatch(/review.{0,10}governance/i);
  });

  it("multiple models' creative alternatives remain distinguishable, each attributed to its own model", () => {
    const html = renderSchema("creative_generative", {
      extraData: undefined,
    });
    // Two different models' chips both present.
    expect(html.match(/GPT|Claude/gi)?.length).toBeGreaterThanOrEqual(2);
  });

  it("raw model responses remain accessible via Model Responses, even with listView omitted", () => {
    const html = renderSchema("creative_generative");
    expect(html).toMatch(/model responses/i);
    expect(html).toMatch(/raw model output/i);
  });

  it("TopSummaryBar renders 'Not scored' for consensus/source grounding rather than fabricating a score", () => {
    const html = renderSchema("creative_generative");
    expect(html).toMatch(/not scored/i);
  });

  it("TopSummaryBar still shows the correct report type ('Creative Output')", () => {
    const html = renderSchema("creative_generative");
    expect(html).toMatch(/creative output/i);
  });
});

describe("Cross-schema — the three Phase 2C-3 primary structures are materially different", () => {
  it("each schema's primary content contains markers unique to it and absent from the other two", () => {
    const financialHtml = renderSchema("financial_valuation");
    const forecastHtml = renderSchema("forecast_speculative");
    const creativeHtml = renderSchema("creative_generative");

    expect(financialHtml).toMatch(/bull case/i);
    expect(forecastHtml).not.toMatch(/bull case/i);
    expect(creativeHtml).not.toMatch(/bull case/i);

    expect(forecastHtml).toMatch(/base rates/i);
    expect(financialHtml).not.toMatch(/base rates/i);
    expect(creativeHtml).not.toMatch(/base rates/i);

    expect(creativeHtml).toMatch(/autumn leaves falling gently/i);
    expect(financialHtml).not.toMatch(/autumn leaves falling gently/i);
    expect(forecastHtml).not.toMatch(/autumn leaves falling gently/i);
  });
});

describe("Phase 2C-3 — History parity: persisted envelope renders the SAME primary dedicated component as live", () => {
  it.each(CLAIMS_MATRIX_SCHEMAS)("%s: live render and History-reload render (via the real parser + adapter) both show the dedicated view marker", (schemaId) => {
    const liveHtml = renderSchema(schemaId);
    expect(liveHtml).toMatch(DEDICATED_VIEW_MARKERS[schemaId]);

    const schema = SCHEMA_REGISTRY[schemaId];
    const data = FIXTURE_DATA[schemaId];
    const results = [modelResult("chatgpt", schemaId, data), modelResult("claude", schemaId, data)];
    const rawEnvelope = {
      version: 1,
      schemaId,
      classification: baseClassification(schemaId),
      generatedAt: "2026-08-09T00:00:00.000Z",
      results,
      alignedClaims: [claimFixture()],
      gate: GATE_FIXTURE,
      synthesisReport: synthesisReportFixture(),
      trustSummary: { perModel: [], overallTrust: 0.7 },
    };
    const roundTripped = JSON.parse(JSON.stringify(rawEnvelope));
    const parsed = parsePersistedLegacyAdaptiveOutput(roundTripped);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const payload = adaptPersistedLegacyOutputToPanelPayload(parsed.output);
    expect(payload.schemaId).toBe(schemaId);

    const historyHtml = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification: payload.classification,
        results: payload.results,
        alignedClaims: payload.alignedClaims,
        gate: payload.gate as any,
        synthesisReport: payload.synthesisReport,
        trustSummary: payload.trustSummary,
        question: "A representative question",
      })
    );

    expect(historyHtml).toMatch(DEDICATED_VIEW_MARKERS[schemaId]);
    expect(historyHtml).not.toMatch(/list view|compare view/i);
  });

  it("creative_generative: History reload with alignedClaims=[], gate absent, synthesisReport absent (the real persisted shape for this schema) renders the SAME dedicated view as live, no fallback", () => {
    const schemaId = "creative_generative" as const;
    const schema = SCHEMA_REGISTRY[schemaId];
    const data = FIXTURE_DATA[schemaId];
    const results = [modelResult("chatgpt", schemaId, data), modelResult("claude", schemaId, data)];

    // The real shape orchestrate.ts's empty-alignedClaims early-return
    // produces for creative_generative (see persistedOutput.ts's doc):
    // gate/synthesisReport/trustSummary genuinely absent, alignedClaims: [].
    const rawEnvelope = {
      version: 1,
      schemaId,
      classification: baseClassification(schemaId),
      generatedAt: "2026-08-09T00:00:00.000Z",
      results,
      alignedClaims: [],
    };
    const roundTripped = JSON.parse(JSON.stringify(rawEnvelope));
    const parsed = parsePersistedLegacyAdaptiveOutput(roundTripped);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.output.gate).toBeUndefined();
    expect(parsed.output.synthesisReport).toBeUndefined();

    const payload = adaptPersistedLegacyOutputToPanelPayload(parsed.output);
    expect(payload.schemaId).toBe(schemaId);
    expect(payload.gate).toBeUndefined();
    expect(payload.synthesisReport).toBeUndefined();

    const historyHtml = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification: payload.classification,
        results: payload.results,
        alignedClaims: payload.alignedClaims,
        gate: payload.gate as any,
        synthesisReport: payload.synthesisReport,
        trustSummary: payload.trustSummary,
        question: "A representative question",
      })
    );

    expect(historyHtml).toMatch(DEDICATED_VIEW_MARKERS.creative_generative);
    expect(historyHtml).not.toMatch(/list view|compare view/i);
    expect(historyHtml).not.toMatch(/models agree/i);
  });
});

describe("Phase 2C-3 — malformed persistence fails safely, never fabricates structure", () => {
  it.each(CLAIMS_MATRIX_SCHEMAS)("%s: a malformed persisted record (non-empty claims, missing gate) is rejected by the real parser, never silently accepted", (schemaId) => {
    const malformed: Record<string, unknown> = {
      version: 1,
      schemaId,
      classification: baseClassification(schemaId),
      generatedAt: "2026-08-09T00:00:00.000Z",
      results: [],
      alignedClaims: [claimFixture()],
      synthesisReport: synthesisReportFixture(),
      // gate deliberately omitted — invalid for a non-empty-claims record
    };
    const parsed = parsePersistedLegacyAdaptiveOutput(malformed);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("malformed");
  });
});
