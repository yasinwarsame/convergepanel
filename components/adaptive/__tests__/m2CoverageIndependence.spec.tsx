/**
 * C-a milestone-2 rows B01–B11: `formatSlotCoverage` at exactly the 10 non-DS call sites, the family-specific
 * qualifiers (B02 rank dispute, B03 one-model / split cells, B05 / B08 contested / disagreement / coverage note,
 * B10 homogeneity message, B11 citations). Real views and real result builders, rendered under the run's contexts.
 * Negatives: BI35 (IND identical to the view without identity), MU-ds (Decision Support keeps `formatModelCoverage`
 * byte-identically under any identity), the B01 site-count assertion, N-D4′ on UV.
 */
import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import RankedListView from "@/components/adaptive/RankedListView";
import ComparisonMatrixView from "@/components/adaptive/ComparisonMatrixView";
import DefinitionExplanationView from "@/components/adaptive/DefinitionExplanationView";
import CausalExplanationView from "@/components/adaptive/CausalExplanationView";
import ChecklistTaxonomyView from "@/components/adaptive/ChecklistTaxonomyView";
import RiskAnalysisView from "@/components/adaptive/RiskAnalysisView";
import DeepResearchView from "@/components/adaptive/DeepResearchView";
import EvidenceReviewView from "@/components/adaptive/EvidenceReviewView";
import BiasBlindspotAuditView from "@/components/adaptive/BiasBlindspotAuditView";
import DecisionSupportView from "@/components/adaptive/DecisionSupportView";
import { formatModelCoverage } from "@/components/adaptive/shared";
import { buildRankedEnumerationResult } from "@/lib/adaptiveSchema/enumAlignment";
import { buildComparisonMatrixResult } from "@/lib/adaptiveSchema/comparisonAlignment";
import { buildDefinitionExplanationResult } from "@/lib/adaptiveSchema/definitionAlignment";
import { buildCausalExplanationResult } from "@/lib/adaptiveSchema/causalAlignment";
import { buildChecklistTaxonomyResult } from "@/lib/adaptiveSchema/checklistAlignment";
import { buildDeepResearchResult } from "@/lib/adaptiveSchema/deepResearchAlignment";
import { buildEvidenceReviewResult } from "@/lib/adaptiveSchema/evidenceReviewAlignment";
import { buildBiasBlindspotAuditResult } from "@/lib/adaptiveSchema/biasBlindspotAlignment";
import { buildDecisionSupportResult } from "@/lib/adaptiveSchema/decisionSupportAlignment";
import { renderUnderRun, textOf } from "./caIdentityRender";
import { DIGIT_NEXT_TO_INDEPENDENT, ok, sub } from "@/lib/panel/__tests__/executionIdentityScenarios";
import type { ModelResult } from "@/lib/types";

const SLOTS = ["chatgpt", "claude", "grok", "perplexity"] as const;
const RUNS: Record<"FC" | "PC" | "UV" | "IND", ModelResult[]> = {
  FC: SLOTS.map((m) => sub(m)),
  PC: [sub("chatgpt"), sub("claude"), ok("grok"), ok("perplexity")],
  UV: SLOTS.map((m) => ok(m, null)),
  IND: SLOTS.map((m) => ok(m)),
};
const per = <F,>(f: (m: string, i: number) => F) => SLOTS.map((m, i) => ({ modelId: m as any, ...f(m, i) }));

beforeEach(() => {
  mockedCallGemini.mockImplementation(async (_q: any, _c: any, _k: any, opts: any) => {
    const prompt = opts?.systemPromptOverride || "";
    if (prompt.includes("biases and blind spots")) return { modelId: "gemini", status: "ok", rawText: JSON.stringify({ biasAndBlindSpots: [] }), latencyMs: 1 } as any;
    return { modelId: "gemini", status: "ok", rawText: JSON.stringify({ gaps: [] }), latencyMs: 1 } as any;
  });
});

async function surfaces(): Promise<Record<string, any>> {
  const ranked = buildRankedEnumerationResult(per((_m, i) => ({ items: [{ id: "a", label: "Alpha", rank: 1 }, { id: "b", label: "Beta", rank: i < 2 ? 2 : 5 }] })) as any, null);
  const matrix = buildComparisonMatrixResult(per((_m, i) => ({ cells: [{ subject: "X", attribute: "Price", value: i < 2 ? "$1" : "$9" }, { subject: "X", attribute: "Size", value: "Big" }] })) as any);
  const defF = (o: any) => ({ term: "CAGR", directAnswer: "Growth rate.", explanation: "E.", keyPoints: [], example: "none", analogyText: "none", analogyLimits: "none", distinctions: [], processSteps: [], advancedDetail: "none", commonMisconceptions: [], relatedConcepts: [], sources: [], ...o });
  const definition = buildDefinitionExplanationResult(per(() => ({ fields: defF({}) })) as any, 4);
  const causalF = (o: any) => ({ directAnswer: "Demand.", directCauses: ["Rising demand"], contributingFactors: [], triggers: [], amplifiers: [], alternativeExplanations: [], causalLinks: [], confounders: [], disputedInterpretations: [], unknowns: [], testsOrEvidenceNeeded: [], sources: [], ...o });
  const causal = buildCausalExplanationResult(per(() => ({ fields: causalF({}) })) as any, 4);
  const checklist = buildChecklistTaxonomyResult(per(() => ({ fields: { summary: "S.", items: [{ id: "i", label: "Back up data", category: "Ops" }], notes: [] } })) as any);
  const risk = buildChecklistTaxonomyResult(per(() => ({ fields: { summary: "S.", items: [{ id: "r", label: "Vendor lock-in", category: "Risk", likelihood: "medium" }], notes: [] } })) as any);
  const drF = (o: any) => ({ executiveSummary: "Summary.", findings: [{ id: "f", title: "Productivity decline", summary: "Studies find a modest decline." }], disagreements: [], evidenceGaps: [], openQuestions: [], researchBoundaries: [], recommendedNextSteps: [], sources: [], ...o });
  const deep = await buildDeepResearchResult(per((_m, i) => ({ fields: drF(i === 0 ? { disagreements: ["Whether the effect is causal."] } : {}) })) as any);
  const evF = (o: any) => ({ overallAssessment: "Moderate.", dimensions: [{ id: "d", dimension: "Sample size", assessment: "Small.", strength: "weak" }], redFlags: [], strengths: [], applicabilityCaveats: [], recommendedChecks: [], sources: [], ...o });
  const evidence = buildEvidenceReviewResult(per(() => ({ fields: evF({}) })) as any);
  const bF = (o: any) => ({ summary: "", omittedDimensions: [], sharedAssumptions: [], missingStakeholders: [], geographicBiases: [], sourceConcentrationConcerns: [], evidenceTypeConcerns: [], followUpQuestions: [], sources: ["https://a.example/x"], ...o });
  const bias = await buildBiasBlindspotAuditResult(per(() => ({ fields: bF({}) })) as any, 4, "q", SLOTS.map((m) => ({ modelId: m, status: "ok", rawText: "raw", latencyMs: 1 })) as any);
  return {
    ranked: createElement(RankedListView, { rankedEnumeration: ranked }),
    matrix: createElement(ComparisonMatrixView, { comparisonMatrix: matrix }),
    definition: createElement(DefinitionExplanationView, { definitionExplanation: definition }),
    causal: createElement(CausalExplanationView, { causalExplanation: causal }),
    checklist: createElement(ChecklistTaxonomyView, { checklistTaxonomy: checklist }),
    risk: createElement(RiskAnalysisView, { checklistTaxonomy: risk }),
    deep: createElement(DeepResearchView, { deepResearch: deep }),
    evidence: createElement(EvidenceReviewView, { evidenceReview: evidence }),
    bias: createElement(BiasBlindspotAuditView, { biasBlindspotAudit: { ...bias, structuralDiagnostics: { ...bias.structuralDiagnostics, homogeneityFlag: true, homogeneityMessage: "All 4 models agree closely — unusually uniform agreement." } } as any }),
  };
}

describe("B01: coverage counts stated as panel slots at the 10 non-DS sites", () => {
  it.each(["ranked", "matrix", "definition", "causal", "checklist", "risk", "deep", "evidence"])("%s: FC / PC / UV slot wording; IND byte-identical", async (key) => {
    const el = (await surfaces())[key];
    const fc = textOf(renderUnderRun(el, RUNS.FC));
    expect(fc).toMatch(key === "matrix" ? /\d of 4 panel slots: recorded values \(one executing model\)/ : /\d of 4 panel slots [a-z ]+ \(1 independent model\)/);
    expect(fc).not.toMatch(/\d of 4 models (covered|agreed|assessed)/);
    expect(textOf(renderUnderRun(el, RUNS.PC))).toMatch(/of 4 panel slots [a-z ]+ \(3 independent models\)/);
    const uv = textOf(renderUnderRun(el, RUNS.UV));
    expect(uv).toMatch(/of 4 panel slots [a-z ]+ \(model independence unverified\)/);
    expect(uv).not.toMatch(DIGIT_NEXT_TO_INDEPENDENT);
    expect(renderUnderRun(el, RUNS.IND)).toBe(renderUnderRun(el, RUNS.IND, "none"));
  });

  it("site count: formatSlotCoverage at exactly 10 call sites in 8 non-DS files; formatModelCoverage only in DecisionSupportView (2) and its one delegate", () => {
    const dir = join(process.cwd(), "components", "adaptive");
    const files = ["RankedListView", "ComparisonMatrixView", "DefinitionExplanationView", "CausalExplanationView", "ChecklistTaxonomyView", "RiskAnalysisView", "DeepResearchView", "EvidenceReviewView", "DecisionSupportView", "shared"];
    const count = (src: string, fn: string) => (src.match(new RegExp(`${fn}\\(\\{`, "g")) ?? []).length;
    const slot: Record<string, number> = {};
    const model: Record<string, number> = {};
    for (const f of files) {
      const src = readFileSync(join(dir, `${f}.tsx`), "utf8");
      slot[f] = count(src, "formatSlotCoverage");
      model[f] = count(src, "formatModelCoverage");
    }
    expect(slot).toEqual({ RankedListView: 1, ComparisonMatrixView: 3, DefinitionExplanationView: 1, CausalExplanationView: 1, ChecklistTaxonomyView: 1, RiskAnalysisView: 1, DeepResearchView: 1, EvidenceReviewView: 1, DecisionSupportView: 0, shared: 0 });
    expect(model).toEqual({ RankedListView: 0, ComparisonMatrixView: 0, DefinitionExplanationView: 0, CausalExplanationView: 0, ChecklistTaxonomyView: 0, RiskAnalysisView: 0, DeepResearchView: 0, EvidenceReviewView: 0, DecisionSupportView: 2, shared: 1 });
    expect(formatModelCoverage({ covered: 3, total: 5, mode: "covered" })).toBe("3 of 5 models covered this");
  });
});

describe("B02 / B03 / B05 / B08 / B10 / B11 family qualifiers", () => {
  it("B02: 'Rank disputed' / 'Rank agreement' across panel slots when not IND", async () => {
    const out = textOf(renderUnderRun((await surfaces()).ranked, RUNS.PC));
    if (/Rank disputed/.test(out)) expect(out).toContain("Rank disputed across panel slots");
    if (/Rank agreement/.test(out)) expect(out).toMatch(/Rank agreement across panel slots: /);
    expect(out).not.toContain("Rank agreement across models");
  });
  it("B03: FC cells are 'recorded values (one executing model)'; a PC split is 'Values differ across panel slots'", async () => {
    const s = await surfaces();
    const fc = textOf(renderUnderRun(s.matrix, RUNS.FC));
    expect(fc).toContain("recorded values (one executing model)");
    expect(fc).not.toContain("Models disagree");
    const pc = textOf(renderUnderRun(s.matrix, RUNS.PC));
    expect(pc).toContain("Values differ across panel slots");
    expect(pc).not.toContain("Models disagree");
  });
  it("B05 / B08: contested / disagreement / coverage note across panel slots; FC disagreement heading is a recorded difference", async () => {
    const s = await surfaces();
    const causal = textOf(renderUnderRun(s.causal, RUNS.PC));
    expect(causal).toContain("Coverage badges above count panel slots (3 independent executing models answered 4 panel slots)");
    const deepFc = textOf(renderUnderRun(s.deep, RUNS.FC));
    expect(deepFc).toContain("Recorded differences (one executing model answered every slot)");
    expect(deepFc).not.toContain("Areas of disagreement");
    expect(textOf(renderUnderRun(s.deep, RUNS.UV))).toContain("Areas of disagreement across panel slots");
  });
  it("B10: the stored homogeneity message is shown verbatim only for IND; otherwise the slot statement", async () => {
    const s = await surfaces();
    expect(textOf(renderUnderRun(s.bias, RUNS.IND))).toContain("unusually uniform agreement");
    const fc = textOf(renderUnderRun(s.bias, RUNS.FC));
    expect(fc).not.toContain("All 4 models agree closely");
    expect(fc).toContain("Unusually uniform responses across panel slots, not independent agreement: 1 independent executing model answered 4 panel slots.");
  });
  it("B11: 'N of M panel slots cite a source (K independent models)'; UV without a count", async () => {
    const s = await surfaces();
    expect(textOf(renderUnderRun(s.bias, RUNS.PC))).toMatch(/Citations: \d of 4 panel slots cite a source \(3 independent models\)/);
    const uv = textOf(renderUnderRun(s.bias, RUNS.UV));
    expect(uv).toMatch(/Citations: \d of 4 panel slots cite a source \(model independence unverified\)/);
    expect(renderUnderRun(s.bias, RUNS.IND)).toBe(renderUnderRun(s.bias, RUNS.IND, "none"));
  });
});

describe("MU-ds: Decision Support markup is unchanged under every identity", () => {
  it("DecisionSupportView renders byte-identically with FC / PC / UV identity and without (its counts stay 'models')", () => {
    const f = (o: any) => ({ decisionQuestion: "Which CRM?", options: ["A", "B"], criteria: ["Cost"], userProvidedCriteria: [], assessments: [{ id: "x", optionLabel: "A", criterionLabel: "Cost", assessment: "Cheap." }], recommendationAction: "go", recommendedOption: "A", recommendationRationale: "Fit.", recommendationCaveats: [], assumptions: [], uncertainties: [], risks: [], sensitivityFindings: [], reversibleNextStep: "", sources: [], ...o });
    const ds = buildDecisionSupportResult(SLOTS.map((m) => ({ modelId: m as any, fields: f({}) })) as any);
    const el = createElement(DecisionSupportView as any, { decisionSupport: ds });
    const base = renderUnderRun(el, RUNS.IND, "none");
    expect(base).toMatch(/of 4 models/);
    // The identity context changes nothing in the DS view (its attribution chips come from the provenance facts, as before).
    for (const k of ["FC", "PC", "UV"] as const) expect(renderUnderRun(el, RUNS[k])).toBe(renderUnderRun(el, RUNS[k], "none"));
    expect(renderUnderRun(el, RUNS.FC)).toMatch(/4 of 4 models assessed this/);
  });
});
