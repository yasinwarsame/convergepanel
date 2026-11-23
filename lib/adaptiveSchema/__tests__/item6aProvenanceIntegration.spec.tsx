/**
 * Item 6A — end-to-end provenance contract through the REAL pipeline: finalizeAdaptiveRun (incl. the corrective retry)
 * → DecisionSupportResult → CommonResponseMeta limitations → Decision Receipt → governance record (frozen Receipt) →
 * export snapshot → dashboard (DecisionSupportView) and the frozen-Receipt surfaces. Asserts:
 *  - provenance comes only from the user's ORIGINAL request (never a model flag, never the model-written
 *    decisionQuestion), and the displayed cluster label is what is matched;
 *  - one stored value: dashboard, Receipt, frozen Receipt, export Receipt and limitations agree for new results;
 *  - legacy (unmarked) results show model-reported "user" criteria as unverified and disclose it; frozen pre-6A Receipts
 *    are rendered exactly as recorded plus a read-only notice;
 *  - nothing else (recommendation, options, assessments, risks, review flags, sources, Receipt conclusion /
 *    uncertainties / assumptions, automated governance, Team routing) depends on the request text.
 */
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const connectorMap: Record<string, jest.Mock> = {};
jest.mock("@/lib/connectors", () => ({ CONNECTOR_MAP: connectorMap }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { finalizeAdaptiveRun, AdaptiveRetryContext } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { AdaptiveRetryUsageSink } from "@/lib/adaptiveSchema/retryCorrection";
import { buildAdaptiveDecisionReceipt } from "@/lib/adaptiveSchema/decisionReceiptBuilder";
import { getAdaptiveLimitations } from "@/lib/adaptiveSchema/commonResponseMeta";
import { buildAdaptiveGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordBuilder";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { evaluateAdaptiveGovernance } from "@/lib/governance/evaluateAdaptiveGovernance";
import { routeAdaptiveTeamReview } from "@/lib/governance/adaptiveTeamReview";
import { LEGACY_FROZEN_RECEIPT_NOTICE, LEGACY_INFERRED_CRITERIA_LIMITATION, LEGACY_PROVENANCE_LIMITATION, LEGACY_RESULT_NOTICE, readCriterionProvenance, UNESTABLISHED_CRITERIA_LIMITATION } from "@/lib/adaptiveSchema/criterionProvenance";
import DecisionSupportView from "@/components/adaptive/DecisionSupportView";
import DecisionReceiptSection from "@/components/workspace/DecisionReceiptSection";
import LegacyReceiptProvenanceNotice from "@/components/adaptive/LegacyReceiptProvenanceNotice";
import { PersonalReviewReceiptSection } from "@/components/personalReview/PersonalReviewDetail";
import { TeamReviewReceiptSection } from "@/components/teamGovernance/AdaptiveReviewDetail";
import type { DecisionSupportResult } from "@/lib/adaptiveSchema/types";
import type { ModelId, ModelResult } from "@/lib/types";

const SCHEMA = SCHEMA_REGISTRY.decision_support;
const INFERRED_LIMITATION = "The recommendation depends on inferred rather than user-provided criteria.";
const NOW = "2026-11-22T12:00:00.000Z";

function dsJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    decisionQuestion: "Which CRM gives the lowest total cost and vendor lock-in risk?",
    options: ["HubSpot", "Salesforce"],
    criteria: ["Total cost", "Vendor lock-in"],
    userProvidedCriteria: ["Total cost", "Vendor lock-in"],
    assessments: [
      { id: "a1", optionLabel: "HubSpot", criterionLabel: "Total cost", assessment: "Cheaper for a small team." },
      { id: "a2", optionLabel: "Salesforce", criterionLabel: "Vendor lock-in", assessment: "Harder to leave." },
    ],
    recommendationAction: "choose_option",
    recommendedOption: "HubSpot",
    recommendationRationale: "Lower cost fits the budget.",
    recommendationCaveats: ["Pricing may change."],
    assumptions: ["Team stays under 20 seats."],
    uncertainties: ["Migration effort unknown."],
    risks: [{ id: "r1", label: "Price increase at renewal", likelihood: "medium", impact: "medium", mitigation: "Negotiate a cap" }],
    sensitivityFindings: [],
    reversibleNextStep: "Run a 30-day pilot.",
    sources: ["https://example.test/pricing"],
    ...overrides,
  });
}
const CLASSIFICATION: any = {
  queryType: "decision_support", domain: "test", answerShape: "decision_support_view", quantExpected: false, timeSensitivity: "low",
  userIntent: "decide", confidence: 0.9, riskLevel: "professional", evidenceRequirement: "medium", freshness: "timeless",
  inputType: "text", verificationMethod: "cross_model_consistency", requestedCount: 3, requiresClarification: false, rationale: "test",
};
const slot = (modelId: string, rawText: string | null): ModelResult => ({ modelId: modelId as ModelId, status: rawText === null ? "error" : "ok", rawText, latencyMs: 5 });
const run = (question: string | undefined, raws: (string | null)[] = [dsJson(), dsJson()], retry?: AdaptiveRetryContext) =>
  finalizeAdaptiveRun(SCHEMA, raws.map((r, i) => slot(["chatgpt", "claude", "perplexity"][i], r)), question, retry, CLASSIFICATION);

function surfaces(out: any) {
  const ds: DecisionSupportResult = out.decisionSupport;
  const po = out.persistedOutput;
  const receipt = buildAdaptiveDecisionReceipt(po);
  const gov: any = buildAdaptiveGovernanceRecord({ runId: "run-6a", adaptiveOutput: po, now: NOW });
  const exported = buildExportSnapshot({ question: "q", selectedModels: [], runDocument: undefined, milestone2: { output: po, governanceRecord: gov.record } } as any).reportSnapshot as any;
  const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: ds }));
  return { ds, po, receipt, gov, exported, html };
}
// N1 / Option A: a criterion line is 'Criterion: "<label>"' or 'Criterion (<trusted tag>): "<label>"' (label escaped, quoted).
const criterionLines = (basis: string[]) => basis.filter((l) => /^Criterion(?: \((?:stated in request|provenance unverified)\))?: "/.test(l));

beforeEach(() => {
  for (const k of Object.keys(connectorMap)) delete connectorMap[k];
});

describe("Item 6A fail-closed fallback (owner decision 2026-11-23) — new results attribute no criterion to the user", () => {
  const POSITIVE = /your criterion|stated in request|user-provided/i;
  /** Every surface of a new result: dashboard, Receipt, frozen governance Receipt, export snapshot, limitations. */
  function expectNoPositiveAttribution(s: ReturnType<typeof surfaces>) {
    expect(s.ds.criteriaProvenance).toBe("request_text_v1");
    expect(s.ds.criteria.every((c) => c.source === "model")).toBe(true);
    expect(s.ds.criteria.every((c) => readCriterionProvenance(s.ds, c) === "model")).toBe(true);
    expect(s.html).not.toMatch(POSITIVE);
    expect(s.html).not.toContain("provenance unverified");
    for (const r of [s.receipt, s.gov.record.decisionReceipt, s.exported.milestone2.decisionReceipt]) {
      expect(r.basis.some((l: string) => POSITIVE.test(l) && l.startsWith("Criterion ("))).toBe(false);
      expect(r.basis.filter((l: string) => l.startsWith("Criterion ("))).toEqual([]);
    }
    expect(s.gov.record.decisionReceipt).toEqual(s.receipt);
    expect(s.exported.milestone2.decisionReceipt).toEqual(s.receipt);
    expect(s.exported.milestone2.result.criteria).toEqual(s.ds.criteria);
    // Neutral limitation; never the earlier origin claim, never the legacy line.
    expect(s.po.meta.limitations).toContain(UNESTABLISHED_CRITERIA_LIMITATION);
    expect(s.receipt.limitations).toContain(UNESTABLISHED_CRITERIA_LIMITATION);
    expect(s.po.meta.limitations).not.toContain(LEGACY_INFERRED_CRITERIA_LIMITATION);
    expect(s.receipt.limitations).not.toContain(LEGACY_INFERRED_CRITERIA_LIMITATION);
    expect(s.receipt.limitations).not.toContain(LEGACY_PROVENANCE_LIMITATION);
  }

  it.each([
    ["A: the request states neither criterion", "Which CRM should a 10-person team choose?"],
    ["A: the request states one criterion verbatim", "Which CRM has the lowest total cost?"],
    ["A: the request states both criteria verbatim", "Weigh total cost against vendor lock-in."],
    ["A: case and spacing variants of a stated criterion", "Which CRM has the lowest TOTAL COST for us?"],
  ])("%s", async (_l, question) => expectNoPositiveAttribution(surfaces(await run(question))));

  it("A: every model self-reports both criteria as user-provided and the request states them — still no attribution", async () => {
    const raws = [dsJson({ userProvidedCriteria: ["Total cost", "Vendor lock-in"] }), dsJson({ userProvidedCriteria: ["Total cost", "Vendor lock-in"] })];
    expectNoPositiveAttribution(surfaces(await run("Weigh total cost against vendor lock-in.", raws)));
  });

  it("C: the reproduced R4 and R3 numeric / compound examples never produce an attribution", async () => {
    const cases: [string, string][] = [
      ["5 years", "Should we pick a warranty from 3 years up to 5 years?"],
      ["5 years", "anywhere from 3 years to maybe 5 years"],
      ["5 stars", "rated 4 out of a possible 5 stars"],
      ["f\u00fcnf Jahre", "drei bis f\u00fcnf Jahre"],
      ["Refundable", "Should I book a non refundable fare?"],
      ["5 years", "\u00b15 years"],
      ["Cost", "the better cost\u2013benefit ratio?"],
    ];
    for (const [label, question] of cases) {
      const raws = [dsJson({ criteria: [label], assessments: [] }), dsJson({ criteria: [label], assessments: [] })];
      const s = surfaces(await run(question, raws));
      expect([label, question, s.ds.criteria.map((c) => c.source)]).toEqual([label, question, ["model"]]);
      expectNoPositiveAttribution(s);
    }
  });

  it("the shared accessor is the boundary: a marked result with a stored 'user' value still reads as unattributed on every surface", async () => {
    const out: any = await run("Which CRM has the lowest total cost?");
    const forged: DecisionSupportResult = { ...out.decisionSupport, criteria: out.decisionSupport.criteria.map((c: any) => ({ ...c, source: "user" })) };
    expect(forged.criteria.every((c) => readCriterionProvenance(forged, c) === "model")).toBe(true);
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: forged }));
    expect(html).not.toMatch(POSITIVE);
    const receipt = buildAdaptiveDecisionReceipt({ ...out.persistedOutput, result: forged } as any);
    expect(receipt.basis.filter((l: string) => l.startsWith("Criterion ("))).toEqual([]);
    expect(receipt.limitations).toContain(UNESTABLISHED_CRITERIA_LIMITATION);
    // The limitations are computed through the same accessor (getAdaptiveLimitations), never the raw stored value.
    expect(getAdaptiveLimitations("decision_support", forged)).toContain(UNESTABLISHED_CRITERIA_LIMITATION);
    const legacyForged = { ...forged } as any;
    delete legacyForged.criteriaProvenance;
    expect(getAdaptiveLimitations("decision_support", legacyForged)).not.toContain(UNESTABLISHED_CRITERIA_LIMITATION);
  });

  it("H: ordinary criteria stay visible and useful: labels, quoted Receipt lines and assessments", async () => {
    const s = surfaces(await run("Which CRM has the lowest total cost?"));
    expect(s.ds.criteria.map((c) => c.label)).toEqual(["Total cost", "Vendor lock-in"]);
    expect(criterionLines(s.receipt.basis)).toEqual(['Criterion: "Total cost"', 'Criterion: "Vendor lock-in"']);
    expect(s.receipt.basis.filter((l: string) => l.includes(" × "))).toEqual(['"HubSpot" × "Total cost": Cheaper for a small team.', '"Salesforce" × "Vendor lock-in": Harder to leave.']);
    expect(s.html).toContain('<bdi data-testid="ds-criterion-label">Total cost</bdi>');
    expect(s.html).toContain('<bdi data-testid="ds-criterion-label">Vendor lock-in</bdi>');
  });

  it("the model-written decisionQuestion and self-report flags change nothing", async () => {
    const q = "Compare total cost.";
    const flagsDiffer = surfaces(await run(q, [dsJson({ userProvidedCriteria: ["Vendor lock-in"] }), dsJson({ userProvidedCriteria: [] }), dsJson({ userProvidedCriteria: ["Total cost", "Vendor lock-in"] })]));
    const noFlags = surfaces(await run(q, [dsJson({ userProvidedCriteria: [] }), dsJson({ userProvidedCriteria: [] }), dsJson({ userProvidedCriteria: [] })]));
    expect(flagsDiffer.ds.criteria).toEqual(noFlags.ds.criteria);
    expect(flagsDiffer.receipt).toEqual(noFlags.receipt);
    expect(surfaces(await run("Help me pick a CRM")).ds.decisionQuestion).toContain("total cost");
  });

  it("a missing original request still stamps the marker; the corrective retry re-sends the question unchanged", async () => {
    const s = surfaces(await run(undefined));
    expect(s.ds.criteriaProvenance).toBe("request_text_v1");
    expect(s.ds.criteria.every((c) => c.source === "model")).toBe(true);
    expect(surfaces(await run(undefined, [null, "not json"])).ds.criteriaProvenance).toBe("request_text_v1");
    const conn = (connectorMap.chatgpt = jest.fn(async () => ({ modelId: "chatgpt", status: "ok", rawText: dsJson(), latencyMs: 9 })));
    const retry: AdaptiveRetryContext = { apiKeys: {}, promptOverrides: { chatgpt: "BASE" } as any, context: null, budget: { startedAtMonoMs: 0, budgetMs: 300_000 }, usageSink: new AdaptiveRetryUsageSink(), now: () => 1_000 };
    const question = "Which CRM minimizes vendor lock-in?";
    const out: any = await finalizeAdaptiveRun(SCHEMA, [slot("chatgpt", "{not json")], question, retry, CLASSIFICATION);
    expect(conn).toHaveBeenCalledTimes(1);
    expect((conn.mock.calls[0] as unknown[])[0]).toBe(question);
    expect(out.decisionSupport.criteria.map((c: any) => [c.label, c.source])).toEqual([["Total cost", "model"], ["Vendor lock-in", "model"]]);
  });
});

describe("Item 6A — legacy results (no marker) and frozen pre-6A Receipts", () => {
  async function legacyOf(question: string, sources: ("user" | "model")[]) {
    const out: any = await run(question);
    const legacy: DecisionSupportResult = { ...out.decisionSupport, criteria: out.decisionSupport.criteria.map((c: any, i: number) => ({ ...c, source: sources[i] })) };
    delete (legacy as any).criteriaProvenance;
    return { out, legacy, po: { ...out.persistedOutput, result: legacy } };
  }

  it("model-reported 'user' criteria read as unverified on the dashboard, the rebuilt Receipt and the export", async () => {
    const { legacy, po } = await legacyOf("Which CRM has the lowest total cost?", ["user", "model"]);
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: legacy }));
    expect(html).not.toContain("your criterion");
    expect(html).toContain("provenance unverified");
    expect(html).toContain('data-testid="ds-legacy-provenance-note"');
    const receipt = buildAdaptiveDecisionReceipt(po as any);
    expect(criterionLines(receipt.basis)).toEqual(['Criterion (provenance unverified): "Total cost"', 'Criterion: "Vendor lock-in"']);
    expect(receipt.limitations).toContain(LEGACY_PROVENANCE_LIMITATION);
    const gov: any = buildAdaptiveGovernanceRecord({ runId: "run-legacy", adaptiveOutput: po as any, now: NOW });
    const exported: any = buildExportSnapshot({ question: "q", selectedModels: [], runDocument: undefined, milestone2: { output: po, governanceRecord: gov.record } } as any).reportSnapshot;
    expect(exported.milestone2.decisionReceipt).toEqual(receipt);
  });

  it("a legacy result with only 'model' criteria is presented exactly as before (no note, no limitation, no suffix)", async () => {
    const { legacy, po } = await legacyOf("Which CRM?", ["model", "model"]);
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: legacy }));
    expect(html).not.toContain("provenance unverified");
    expect(html).not.toContain("ds-legacy-provenance-note");
    const receipt = buildAdaptiveDecisionReceipt(po as any);
    expect(criterionLines(receipt.basis)).toEqual(['Criterion: "Total cost"', 'Criterion: "Vendor lock-in"']);
    expect(receipt.limitations).not.toContain(LEGACY_PROVENANCE_LIMITATION);
  });

  it("a frozen pre-6A Receipt is rendered exactly as recorded plus a read-only notice; the record object is not modified", async () => {
    const { receipt } = surfaces(await run("Which CRM?"));
    const frozen = { ...receipt, basis: ["Criterion: Total cost (user-provided)", "Criterion: Vendor lock-in", ...receipt.basis.slice(2)] };
    const before = JSON.stringify(frozen);
    const html = renderToStaticMarkup(createElement(DecisionReceiptSection, { receipt: { ...frozen, schemaId: "decision_support" }, reviewOverview: "" }));
    expect(html).toContain("Criterion: Total cost (user-provided)");
    expect(html).toContain('data-testid="receipt-legacy-provenance-notice"');
    expect(html).toContain(LEGACY_FROZEN_RECEIPT_NOTICE.replace(/"/g, "&quot;"));
    expect(JSON.stringify(frozen)).toBe(before);
    // A new Receipt never triggers the notice.
    const fresh = renderToStaticMarkup(createElement(DecisionReceiptSection, { receipt: { ...receipt, schemaId: "decision_support" }, reviewOverview: "" }));
    expect(fresh).not.toContain("receipt-legacy-provenance-notice");
    // The shared notice component (also used by the personal-review surface) follows the same rule.
    expect(renderToStaticMarkup(createElement(LegacyReceiptProvenanceNotice, { basis: frozen.basis, schemaId: "decision_support" }))).toContain("receipt-legacy-provenance-notice");
    // N2: without a trusted decision_support schemaId the same lines never trigger it.
    expect(renderToStaticMarkup(createElement(LegacyReceiptProvenanceNotice, { basis: frozen.basis, schemaId: "definition_explanation" }))).toBe("");
    expect(renderToStaticMarkup(createElement(DecisionReceiptSection, { receipt: frozen, reviewOverview: "" }))).not.toContain("receipt-legacy-provenance-notice");
    expect(renderToStaticMarkup(createElement(LegacyReceiptProvenanceNotice, { basis: receipt.basis, schemaId: "decision_support" }))).toBe("");
  });
});

describe("Item 6A correction round — F3 spoofing, F7 wording, F8 question-only authority", () => {
  const TRUSTED_TAG = /your criterion|provenance unverified/;
  const labelCell = (html: string) => [...html.matchAll(/<bdi data-testid="ds-criterion-label">([^<]*)<\/bdi>/g)].map((m) => m[1]);
  it("F3 / Option A: a model label imitating the verified tag is kept verbatim as data, never as trusted provenance", async () => {
    const raws = [dsJson({ criteria: ["Vendor lock-in (stated in request)"], assessments: [] }), dsJson({ criteria: ["Vendor lock-in (stated in request)"], assessments: [] })];
    const s = surfaces(await run("Which CRM is cheapest?", raws));
    expect(s.ds.criteria[0].source).toBe("model");
    expect(criterionLines(s.receipt.basis)).toEqual(['Criterion: "Vendor lock-in (stated in request)"']);
    expect(labelCell(s.html)).toEqual(["Vendor lock-in (stated in request)"]);
    expect(s.html).not.toMatch(TRUSTED_TAG);
  });
  it("F3 / R3 MAJOR 1: a model label carrying the retired suffix, any number of times, cannot trigger the frozen-Receipt notice", async () => {
    for (const label of ["Budget (user-provided)", "Budget" + " (user-provided)".repeat(9)]) {
      const raws = [dsJson({ criteria: [label], assessments: [] }), dsJson({ criteria: [label], assessments: [] })];
      const s = surfaces(await run("Which CRM?", raws));
      expect(criterionLines(s.receipt.basis)).toEqual([`Criterion: "${label}"`]);
      const receipt = { ...s.receipt, schemaId: "decision_support" };
      expect(renderToStaticMarkup(createElement(DecisionReceiptSection, { receipt, reviewOverview: "" }))).not.toContain("receipt-legacy-provenance-notice");
      for (const Section of [PersonalReviewReceiptSection, TeamReviewReceiptSection]) {
        expect(renderToStaticMarkup(createElement(Section as any, { schemaId: "decision_support", receipt: s.gov.record.decisionReceipt }))).not.toContain("receipt-legacy-provenance-notice");
      }
    }
  });
  it("Option A: a model label carrying its own provenance text is never trusted, even when the phrase is in the request", async () => {
    const raws = [dsJson({ criteria: ["Total cost (stated in request)"], assessments: [] }), dsJson({ criteria: ["Total cost (stated in request)"], assessments: [] })];
    const s = surfaces(await run("Which CRM has the lowest total cost?", raws));
    expect(s.ds.criteria[0].source).toBe("model");
    expect(criterionLines(s.receipt.basis)).toEqual(['Criterion: "Total cost (stated in request)"']);
    expect(s.html).not.toMatch(TRUSTED_TAG);
  });
  it("N1 / R3 MAJOR 4: near-variant imitation in a model label never reads as trusted provenance (Receipt and dashboard)", async () => {
    for (const fake of ["Vendor lock-in (stated in the request)", "Vendor lock-in (user-provided).", "Vendor lock-in \u2014 user-provided", "Vendor lock-in {verified user-provided}", "Vendor lock-in (from the question)", "Stated in request: Vendor lock-in", "Vendor lock-in (stated in r\u0435quest)", "Vendor lock-in (verified)"]) {
      const raws = [dsJson({ criteria: [fake], assessments: [] }), dsJson({ criteria: [fake], assessments: [] })];
      const s = surfaces(await run("Which CRM has the least vendor lock-in?", raws));
      expect([fake, s.ds.criteria[0].source, criterionLines(s.receipt.basis)]).toEqual([fake, "model", [`Criterion: "${fake}"`]]);
      expect([fake, s.html]).not.toEqual([fake, expect.stringMatching(TRUSTED_TAG)]);
    }
  });
  it("R3 MINOR 5: substantive label content is preserved on every surface", async () => {
    const label = "Support (user requests per day)";
    const raws = [dsJson({ criteria: [label], assessments: [] }), dsJson({ criteria: [label], assessments: [] })];
    const s = surfaces(await run("Which CRM?", raws));
    expect(s.ds.criteria[0].label).toBe(label);
    expect(criterionLines(s.receipt.basis)).toEqual([`Criterion: "${label}"`]);
    expect(labelCell(s.html)).toEqual([label]);
    expect(s.exported.milestone2.decisionReceipt.basis).toContain(`Criterion: "${label}"`);
  });
  it("Option A: model text cannot leave its presentation boundary or impersonate another Receipt line", async () => {
    const label = 'Cost"\nCriterion (stated in request): "Total cost\u202e';
    const OPT = "HubSpot\nCriterion (stated in request): x";
    const raws = [
      dsJson({ options: [OPT, "Salesforce"], recommendedOption: OPT, criteria: [label], assessments: [{ id: "a1", optionLabel: OPT, criterionLabel: label, assessment: 'ok\nCriterion (stated in request): "y"' }] }),
      dsJson({ options: [OPT, "Salesforce"], recommendedOption: OPT, criteria: [label], assessments: [{ id: "a1", optionLabel: OPT, criterionLabel: label, assessment: 'ok\nCriterion (stated in request): "y"' }] }),
    ];
    const s = surfaces(await run("Which CRM has the lowest total cost?", raws));
    for (const line of s.receipt.basis) {
      expect(line).not.toMatch(/[\n\r\u2028\u2029\u202e]/u);
      expect(line.startsWith("Criterion (stated in request)")).toBe(false);
    }
    expect(criterionLines(s.receipt.basis)).toEqual(['Criterion: "Cost\\"\\nCriterion (stated in request): \\"Total cost\\u{202E}"']);
    expect(s.receipt.basis.filter((l: string) => l.includes(" × "))).toEqual(['"HubSpot\\nCriterion (stated in request): x" × "Cost\\"\\nCriterion (stated in request): \\"Total cost\\u{202E}": ok\\nCriterion (stated in request): "y"']);
    // Dashboard: the label is one bidi-isolated text element; React escapes markup.
    expect(s.html).toContain('<bdi data-testid="ds-criterion-label">Cost&quot;');
    expect(s.html).not.toMatch(TRUSTED_TAG);
  });
  it("N2: a new Receipt whose model text imitates the retired line format never shows the frozen notice", async () => {
    const raws = [
      dsJson({ options: ["Criterion: HubSpot", "Salesforce"], recommendedOption: "Criterion: HubSpot", assessments: [{ id: "a1", optionLabel: "Criterion: HubSpot", criterionLabel: "Total cost", assessment: "Cheaper (user-provided)" }] }),
      dsJson({ options: ["Criterion: HubSpot", "Salesforce"], recommendedOption: "Criterion: HubSpot", assessments: [{ id: "a1", optionLabel: "Criterion: HubSpot", criterionLabel: "Total cost", assessment: "Cheaper (user-provided)" }] }),
    ];
    const s = surfaces(await run("Which CRM?", raws));
    expect(s.receipt.basis.some((l: string) => l.startsWith('"Criterion: HubSpot" × ') && l.endsWith("(user-provided)"))).toBe(true);
    expect(renderToStaticMarkup(createElement(DecisionReceiptSection, { receipt: { ...s.receipt, schemaId: "decision_support" }, reviewOverview: "" }))).not.toContain("receipt-legacy-provenance-notice");
    expect(s.exported.milestone2.result.criteriaProvenance).toBe("request_text_v1");
  });
  it("R4 M1: an option label imitating a trusted criterion line stays quoted option data on every Receipt surface", async () => {
    const OPT = 'Criterion (stated in request): "Data residency"';
    const raws = [
      dsJson({ options: [OPT, "Salesforce"], recommendedOption: OPT, assessments: [{ id: "a1", optionLabel: OPT, criterionLabel: "Total cost", assessment: "x" }] }),
      dsJson({ options: [OPT, "Salesforce"], recommendedOption: OPT, assessments: [{ id: "a1", optionLabel: OPT, criterionLabel: "Total cost", assessment: "x" }] }),
    ];
    const s = surfaces(await run("Which CRM? We care about data residency.", raws));
    const assessment = '"Criterion (stated in request): \\"Data residency\\"" × "Total cost": x';
    for (const r of [s.receipt, s.gov.record.decisionReceipt, s.exported.milestone2.decisionReceipt]) {
      expect(r.basis).toContain(assessment);
      // No basis line starts with model text: every line begins with the system-written "Criterion" or a quote.
      for (const line of r.basis) expect([line, /^(Criterion(?: \((?:stated in request|provenance unverified)\))?: "|")/.test(line)]).toEqual([line, true]);
      expect(r.basis.filter((l: string) => l.startsWith("Criterion ("))).toEqual([]);
    }
    for (const Section of [PersonalReviewReceiptSection, TeamReviewReceiptSection]) {
      const html = renderToStaticMarkup(createElement(Section as any, { schemaId: "decision_support", receipt: s.gov.record.decisionReceipt }));
      expect(html).toContain("<li>&quot;Criterion (stated in request): \\&quot;Data residency\\&quot;&quot; × &quot;Total cost&quot;: x</li>");
      expect(html).not.toContain("<li>Criterion (stated in request)");
      expect(html).not.toContain("receipt-legacy-provenance-notice");
    }
  });
  it("F7: the dashboard legacy note is viewer-neutral", async () => {
    const out: any = await run("Which CRM has the lowest total cost?");
    const legacy = { ...out.decisionSupport, criteria: out.decisionSupport.criteria.map((c: any) => ({ ...c, source: "user" })) };
    delete legacy.criteriaProvenance;
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: legacy }));
    expect(html).toContain(LEGACY_RESULT_NOTICE);
    expect(html.toLowerCase()).not.toMatch(/\byour (request|criteri)/);
  });
  it("F8: criteria present only in the context field stay model-identified (question-only authority)", async () => {
    const retry: AdaptiveRetryContext = {
      apiKeys: {}, promptOverrides: {} as any, context: "Our must-haves: total cost and vendor lock-in.",
      budget: { startedAtMonoMs: 0, budgetMs: 300_000 }, usageSink: new AdaptiveRetryUsageSink(), now: () => 1_000,
    };
    const out: any = await run("Which CRM should we choose?", [dsJson(), dsJson()], retry);
    expect(out.decisionSupport.criteria.map((c: any) => c.source)).toEqual(["model", "model"]);
  });
});

describe("Item 6A — nothing but provenance depends on the request text", () => {
  it("recommendation, options, assessments, risks, review flags, sources, Receipt conclusion/uncertainties/assumptions, governance and routing are identical", async () => {
    const raws = [dsJson(), dsJson({ recommendedOption: "Salesforce" }), dsJson()];
    const stated = surfaces(await run("Weigh total cost against vendor lock-in.", raws));
    const unstated = surfaces(await run("Which CRM?", raws));
    const strip = (ds: DecisionSupportResult) => ({ ...ds, criteria: ds.criteria.map(({ source, ...rest }) => rest) });
    expect(strip(stated.ds)).toEqual(strip(unstated.ds));
    expect(stated.ds.recommendation.isContested).toBe(true); // a real split stays a conservative fallback
    for (const k of ["conclusion", "assumptions", "uncertainties", "sources", "sourceBacked", "humanReviewNeeded"] as const) {
      expect(stated.receipt[k]).toEqual(unstated.receipt[k]);
    }
    const nonCriterion = (b: string[]) => b.filter((l) => !criterionLines([l]).length);
    expect(nonCriterion(stated.receipt.basis)).toEqual(nonCriterion(unstated.receipt.basis));
    const withoutInferred = (l: string[]) => l.filter((x) => x !== INFERRED_LIMITATION);
    expect(withoutInferred(stated.receipt.limitations)).toEqual(withoutInferred(unstated.receipt.limitations));
    const policy = { policyVersion: 1, blockIfSourceBackedMissingSources: true, reviewIfAnyModelFailed: true } as any;
    const govEval = (s: any) => evaluateAdaptiveGovernance({ governanceRecord: s.gov.record, policy, modelFailureCount: 0, successfulModelCount: 3, evaluatedAt: NOW });
    expect(govEval(stated)).toEqual(govEval(unstated));
    for (const mode of ["all", "flagged_only", "human_review_needed"]) {
      const route = (s: any) => routeAdaptiveTeamReview({ humanReviewNeeded: s.gov.record.decisionReceipt.humanReviewNeeded, automatedGovernanceStatus: govEval(s).status, settings: { enabled: true, mode } as any });
      expect(route(stated)).toEqual(route(unstated));
    }
  });
});
