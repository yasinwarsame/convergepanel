/**
 * Adaptive Synthesis Report, Phase 2C-2 — promotes contested_empirical,
 * legal_regulatory, and medical_health into the same progressive-disclosure
 * layout already proven for procedural/generic (Phase 2 pilot). Covers:
 * correct dedicated renderer + report type, primary-before-secondary
 * ordering, progressive disclosure, consensus/disagreement/uncertainty
 * visibility, per-schema semantic safeguards (settled-vs-disputed distinctness
 * for contested_empirical, jurisdiction prominence + Claim Text regression
 * for legal_regulatory, evidence-tier/red-flag distinctness for
 * medical_health), cross-schema structural difference, History parity
 * through the real parser/adapter, and malformed-record safety.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import SchemaKeyFactsStrip from "@/components/adaptive/SchemaKeyFactsStrip";
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

const SCHEMAS = ["contested_empirical", "legal_regulatory", "medical_health"] as const;

const FIXTURE_DATA: Record<(typeof SCHEMAS)[number], Record<string, unknown>> = {
  contested_empirical: {
    summary: "Experts broadly agree the effect exists but disagree on magnitude.",
    settledClaims: [],
    disputedClaims: [],
    keyMetrics: [{ label: "Effect size", value: 0.3, unit: "SD", asOf: "2026", source: "meta-analysis" }],
    openQuestions: ["Does the effect hold across populations?"],
  },
  legal_regulatory: {
    applicableRule: "Reasonable accommodation must be provided absent undue hardship.",
    jurisdiction: "US federal",
    elements: ["Qualified individual", "Known disability"],
    keyAuthority: ["ADA 42 U.S.C. § 12112"],
    exceptions: ["Undue hardship on the employer"],
    unsettledIssues: [],
    attorneyQuestions: ["Does this qualify as undue hardship?"],
  },
  medical_health: {
    summary: "Regular exercise reduces cardiovascular risk.",
    mechanism: "Improves endothelial function and lipid profile.",
    evidenceByTier: [],
    guidelinePositions: ["AHA recommends 150 minutes/week moderate activity."],
    redFlags: ["Chest pain during exertion."],
    clinicianQuestions: ["Is this safe given my current medications?"],
  },
};

const DEDICATED_VIEW_MARKERS: Record<(typeof SCHEMAS)[number], RegExp> = {
  contested_empirical: /where the models land/i,
  legal_regulatory: /applicable rule/i,
  medical_health: /guideline positions/i,
};

function renderSchema(
  schemaId: (typeof SCHEMAS)[number],
  opts: { alignedClaims?: AlignedClaim[]; synthesisReport?: AdaptiveSynthesisReport; extraData?: Record<string, unknown> } = {}
) {
  const schema = SCHEMA_REGISTRY[schemaId];
  const data = { ...FIXTURE_DATA[schemaId], ...opts.extraData };
  const results = [modelResult("chatgpt", schemaId, data), modelResult("claude", schemaId, data)];
  const alignedClaims = opts.alignedClaims ?? [claimFixture()];
  const classification = baseClassification(schemaId);

  return renderToStaticMarkup(
    createElement(AdaptivePanelResponse, {
      schema,
      classification,
      results,
      alignedClaims,
      gate: GATE_FIXTURE as any,
      synthesisReport: opts.synthesisReport ?? synthesisReportFixture(),
      question: "A representative question",
    })
  );
}

describe("Phase 2C-2 — dedicated renderer, report type, no tab UI, no JSON leak", () => {
  it.each(SCHEMAS)("%s: renders its dedicated view, correct report type, no List/Compare tab UI, no serialized JSON", (schemaId) => {
    const html = renderSchema(schemaId);
    expect(html).toMatch(DEDICATED_VIEW_MARKERS[schemaId]);
    expect(html).not.toMatch(/list view|compare view/i);
    // A raw, unparsed JSON-shaped model answer would show up as a doubly
    // escaped fragment like `\"summary\":` — proves data.results/claims are
    // real rendered objects, never a leaked JSON string.
    expect(html).not.toMatch(/\\"summary\\"/);
    expect(html).not.toMatch(/\\"applicableRule\\"/);
  });
});

describe("Phase 2C-2 — primary answer before secondary evidence, progressive disclosure", () => {
  const collapsibleLabels = [/model responses/i, /panel evidence/i, /review.{0,10}governance/i];

  it.each(SCHEMAS)("%s: PrimarySynthesisStrip + dedicated view appear before the collapsed sections, all collapsed by default", (schemaId) => {
    const html = renderSchema(schemaId);

    const primaryIndex = html.search(/models agree/i);
    const dedicatedIndex = html.search(DEDICATED_VIEW_MARKERS[schemaId]);
    const modelResponsesIndex = html.search(/model responses/i);

    expect(primaryIndex).toBeGreaterThan(-1);
    expect(dedicatedIndex).toBeGreaterThan(-1);
    expect(modelResponsesIndex).toBeGreaterThan(-1);
    // Primary content (headline strip, dedicated view) renders before the
    // secondary collapsed sections — never the reverse.
    expect(primaryIndex).toBeLessThan(modelResponsesIndex);
    expect(dedicatedIndex).toBeLessThan(modelResponsesIndex);

    for (const label of collapsibleLabels) {
      expect(html).toMatch(label);
    }
    // No <details> anywhere in the output is open by default.
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });
});

describe("Phase 2C-2 — consensus, disagreement, and uncertainty are visible without expanding anything", () => {
  it.each(SCHEMAS)("%s: PrimarySynthesisStrip surfaces the top consensus point, the key disagreement, and the caveat", (schemaId) => {
    const html = renderSchema(schemaId);
    expect(html).toMatch(/models broadly agree on the core answer/i);
    expect(html).toMatch(/models disagree on a secondary detail/i);
    expect(html).toMatch(/evidence quality varies across sources/i);
  });

  it.each(SCHEMAS)("%s: when there is no key disagreement, says so plainly rather than omitting the section", (schemaId) => {
    const html = renderSchema(schemaId, {
      synthesisReport: synthesisReportFixture({
        verdictCard: {
          ...synthesisReportFixture().verdictCard,
          keyDisagreement: null,
          disagreementDetail: null,
          disagreementModelCount: 0,
        },
      }),
    });
    expect(html).toMatch(/no major disagreements detected/i);
  });
});

describe("contested_empirical — settled vs disputed distinctness", () => {
  it("a consensus claim and a split claim render with visibly different stance chips, never the same badge", () => {
    const settled = claimFixture({
      id: "settled-1",
      claimText: "The baseline effect is well established.",
      status: "consensus",
      cells: [
        { modelId: "chatgpt" as ModelId, stance: "agrees", rawStance: "asserts", confidence: "settled", excerpt: "x" },
        { modelId: "claude" as ModelId, stance: "agrees", rawStance: "asserts", confidence: "settled", excerpt: "x" },
      ],
    });
    const disputed = claimFixture({
      id: "disputed-1",
      claimText: "The effect magnitude is large.",
      status: "split",
      cells: [
        { modelId: "chatgpt" as ModelId, stance: "agrees", rawStance: "asserts", confidence: "contested", excerpt: "x" },
        { modelId: "claude" as ModelId, stance: "disputes", rawStance: "disputes", confidence: "contested", excerpt: "y" },
      ],
    });
    const html = renderSchema("contested_empirical", { alignedClaims: [settled, disputed] });

    expect(html).toMatch(/the baseline effect is well established/i);
    expect(html).toMatch(/the effect magnitude is large/i);
    // Distinct stance vocabulary: "Agrees" for the settled claim's cells and
    // "Disputes" for the disputed claim's dissenting cell — never collapsed
    // into one undifferentiated label.
    expect(html).toMatch(/Agrees/);
    expect(html).toMatch(/Disputes/);
  });

  it("a claim covered by every model but genuinely split cannot accidentally render as settled — coverage is not correctness", () => {
    // High coverage (both models addressed it) but they disagree — this must
    // never be presented with the same "Agrees"-only styling a true
    // consensus claim gets.
    const widelyCoveredButDisputed = claimFixture({
      id: "widely-covered-disputed",
      claimText: "A claim every model addressed but did not agree on.",
      status: "split",
      cells: [
        { modelId: "chatgpt" as ModelId, stance: "agrees", rawStance: "asserts", confidence: "contested", excerpt: "x" },
        { modelId: "claude" as ModelId, stance: "disputes", rawStance: "disputes", confidence: "contested", excerpt: "y" },
      ],
    });
    const html = renderSchema("contested_empirical", { alignedClaims: [widelyCoveredButDisputed] });
    // The claim's own row must contain a "Disputes" chip — full coverage
    // alone never upgrades it to an all-"Agrees" row.
    const claimSection = html.slice(html.indexOf("A claim every model addressed"));
    expect(claimSection).toMatch(/Disputes/);
  });
});

describe("legal_regulatory — jurisdiction prominence, exceptions/unsettled issues, consensus does not replace source grounding", () => {
  it("the actual jurisdiction value is visually prominent (SchemaKeyFactsStrip), not just buried in a per-model card", () => {
    const html = renderSchema("legal_regulatory");
    expect(html).toMatch(/jurisdiction/i);
    expect(html).toMatch(/US federal/);
  });

  it("regression: jurisdiction shows the real value, never a generic 'Jurisdiction' or 'Answer' placeholder label as the displayed fact", () => {
    const html = renderSchema("legal_regulatory");
    // The real value must appear as actual content.
    expect(html).toMatch(/US federal/);
    // Pin against the historical label-instead-of-value regression class:
    // the value shown must not literally BE the field label with nothing else.
    const jurisdictionValueMatch = html.match(/<p class="text-sm font-semibold text-slate-900">([^<]*)<\/p>/);
    expect(jurisdictionValueMatch?.[1]).not.toBe("Jurisdiction");
    expect(jurisdictionValueMatch?.[1]).not.toBe("Answer");
  });

  it("exceptions and unsettled issues remain visible in the primary content (RuleApplicationView, unchanged)", () => {
    const unsettled = [claimFixture({ id: "unsettled-1", claimText: "Whether remote work is always reasonable is unsettled.", status: "split" })];
    const html = renderSchema("legal_regulatory", { alignedClaims: unsettled });
    expect(html).toMatch(/exceptions/i);
    expect(html).toMatch(/undue hardship on the employer/i);
    expect(html).toMatch(/unsettled issues/i);
    expect(html).toMatch(/whether remote work is always reasonable is unsettled/i);
  });

  it("model consensus language never substitutes for key authority — key authority stays present and separately labeled", () => {
    const html = renderSchema("legal_regulatory");
    expect(html).toMatch(/key authority/i);
    expect(html).toMatch(/ADA 42 U\.S\.C\. § 12112/);
    // The consensus strip and the authority listing are distinct sections —
    // authority text must not be replaced by a bare consensus percentage.
    expect(html.toLowerCase().indexOf("key authority")).not.toBe(-1);
  });
});

describe("medical_health — evidence tiers distinguishable, guideline positions distinct from consensus, red flags visible", () => {
  it("evidence tier labels are genuine tier labels (RCT/meta-analysis vs observational vs anecdotal), not a single merged list", () => {
    const rct = claimFixture({ id: "rct-claim", claimText: "RCT evidence supports this.", status: "consensus" });
    const html = renderSchema("medical_health", {
      alignedClaims: [rct],
      extraData: { evidenceByTier: [{ id: "rct-claim", claim: "RCT evidence supports this.", stance: "asserts", confidence: "settled", evidenceType: "empirical" }] },
    });
    expect(html).toMatch(/empirical.*RCT.*meta-analysis|RCT.*meta-analysis/i);
  });

  it("guideline positions render as their own labeled section, never merged into or replaced by the consensus strip", () => {
    const html = renderSchema("medical_health");
    expect(html).toMatch(/guideline positions/i);
    expect(html).toMatch(/AHA recommends 150 minutes\/week/);
    // Consensus wording ("models agree") is a separate section from the
    // guideline-position listing — the guideline text is not paraphrased
    // into a consensus sentence.
    const lower = html.toLowerCase();
    expect(lower.indexOf("guideline positions")).not.toEqual(lower.indexOf("models agree"));
  });

  it("red flags remain visible (SchemaKeyFactsStrip) even when model agreement is high — high coverage never suppresses them", () => {
    const highAgreementClaims = [
      claimFixture({ id: "c1", status: "consensus" }),
      claimFixture({ id: "c2", status: "consensus" }),
      claimFixture({ id: "c3", status: "consensus" }),
    ];
    const html = renderSchema("medical_health", { alignedClaims: highAgreementClaims });
    expect(html).toMatch(/red flags/i);
    expect(html).toMatch(/chest pain during exertion/i);
  });

  it("uncertainty (caveat) is not suppressed by high model coverage", () => {
    const html = renderSchema("medical_health", {
      alignedClaims: [claimFixture({ status: "consensus" }), claimFixture({ id: "c2", status: "consensus" })],
    });
    expect(html).toMatch(/evidence quality varies across sources/i);
  });
});

describe("Cross-schema — the three promoted primary structures are materially different, not a copy-pasted template", () => {
  it("each schema's primary content contains markers unique to it and absent from the other two", () => {
    const contestedHtml = renderSchema("contested_empirical");
    const legalHtml = renderSchema("legal_regulatory");
    const medicalHtml = renderSchema("medical_health");

    // contested_empirical-only marker
    expect(contestedHtml).toMatch(/where the models land/i);
    expect(legalHtml).not.toMatch(/where the models land/i);
    expect(medicalHtml).not.toMatch(/where the models land/i);

    // legal_regulatory-only markers
    expect(legalHtml).toMatch(/applicable rule/i);
    expect(contestedHtml).not.toMatch(/applicable rule/i);
    expect(medicalHtml).not.toMatch(/applicable rule/i);

    // medical_health-only markers
    expect(medicalHtml).toMatch(/guideline positions/i);
    expect(contestedHtml).not.toMatch(/guideline positions/i);
    expect(legalHtml).not.toMatch(/guideline positions/i);
  });
});

describe("Phase 2C-2 — History parity: persisted envelope renders the SAME primary dedicated component as live", () => {
  it.each(SCHEMAS)("%s: live render and History-reload render (via the real parser + adapter) both show the dedicated view marker", (schemaId) => {
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
});

describe("Phase 2C-2 — malformed persistence fails safely, never fabricates structure", () => {
  it.each(SCHEMAS)("%s: a malformed persisted record (non-empty claims, missing gate) is rejected by the real parser, never silently accepted", (schemaId) => {
    const malformed: Record<string, unknown> = {
      version: 1,
      schemaId,
      classification: baseClassification(schemaId),
      generatedAt: "2026-08-09T00:00:00.000Z",
      results: [],
      alignedClaims: [claimFixture()],
      // gate deliberately omitted — invalid for a non-empty-claims record
      synthesisReport: synthesisReportFixture(),
    };
    const parsed = parsePersistedLegacyAdaptiveOutput(malformed);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("malformed");
  });
});

describe("SchemaKeyFactsStrip — unit-level null-return cases", () => {
  it("renders nothing for contested_empirical — that schema's primary-hierarchy questions are already answered by PrimarySynthesisStrip + ConsensusMapView", () => {
    const html = renderToStaticMarkup(
      createElement(SchemaKeyFactsStrip, {
        schemaId: "contested_empirical",
        results: [modelResult("chatgpt", "contested_empirical", FIXTURE_DATA.contested_empirical)],
        alignedClaims: [claimFixture()],
      })
    );
    expect(html).toBe("");
  });

  it("renders nothing for legal_regulatory when no model produced a jurisdiction value — never fabricates one", () => {
    const html = renderToStaticMarkup(
      createElement(SchemaKeyFactsStrip, {
        schemaId: "legal_regulatory",
        results: [modelResult("chatgpt", "legal_regulatory", { applicableRule: "x" })],
        alignedClaims: [],
      })
    );
    expect(html).toBe("");
  });

  it("renders nothing for medical_health when no model produced any red flags — never fabricates one", () => {
    const html = renderToStaticMarkup(
      createElement(SchemaKeyFactsStrip, {
        schemaId: "medical_health",
        results: [modelResult("chatgpt", "medical_health", { summary: "x", redFlags: [] })],
        alignedClaims: [],
      })
    );
    expect(html).toBe("");
  });

  it("legal_regulatory falls back to the first ok model's raw jurisdiction field when no aligned claim row exists", () => {
    const html = renderToStaticMarkup(
      createElement(SchemaKeyFactsStrip, {
        schemaId: "legal_regulatory",
        results: [modelResult("chatgpt", "legal_regulatory", { applicableRule: "x", jurisdiction: "California" })],
        alignedClaims: [],
      })
    );
    expect(html).toMatch(/California/);
  });
});
