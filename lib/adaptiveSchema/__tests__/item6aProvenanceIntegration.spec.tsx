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
import { buildAdaptiveGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordBuilder";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { evaluateAdaptiveGovernance } from "@/lib/governance/evaluateAdaptiveGovernance";
import { routeAdaptiveTeamReview } from "@/lib/governance/adaptiveTeamReview";
import { LEGACY_FROZEN_RECEIPT_NOTICE, LEGACY_PROVENANCE_LIMITATION, LEGACY_RESULT_NOTICE } from "@/lib/adaptiveSchema/criterionProvenance";
import DecisionSupportView from "@/components/adaptive/DecisionSupportView";
import DecisionReceiptSection from "@/components/workspace/DecisionReceiptSection";
import LegacyReceiptProvenanceNotice from "@/components/adaptive/LegacyReceiptProvenanceNotice";
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
const criterionLines = (basis: string[]) => basis.filter((l) => l.startsWith("Criterion: "));

beforeEach(() => {
  for (const k of Object.keys(connectorMap)) delete connectorMap[k];
});

describe("Item 6A — authority of the original request", () => {
  it("a model cannot self-promote: every model flags both criteria, the request states neither", async () => {
    const s = surfaces(await run("Which CRM should a 10-person team choose?"));
    expect(s.ds.criteriaProvenance).toBe("request_text_v1");
    expect(s.ds.criteria.map((c) => [c.label, c.source])).toEqual([["Total cost", "model"], ["Vendor lock-in", "model"]]);
    expect(s.html).not.toContain("your criterion");
    expect(criterionLines(s.receipt.basis)).toEqual(["Criterion: Total cost", "Criterion: Vendor lock-in"]);
    expect(s.po.meta.limitations).toContain(INFERRED_LIMITATION);
  });

  it("the model-written decisionQuestion is never an authority (it names both criteria; the request does not)", async () => {
    const s = surfaces(await run("Help me pick a CRM"));
    expect(s.ds.decisionQuestion).toContain("total cost");
    expect(s.ds.criteria.every((c) => c.source === "model")).toBe(true);
  });

  it("recognizes only the criterion the request states, as a whole-token phrase", async () => {
    const s = surfaces(await run("Which CRM has the lowest TOTAL-COST for us?"));
    expect(s.ds.criteria.map((c) => [c.label, c.source])).toEqual([["Total cost", "user"], ["Vendor lock-in", "model"]]);
  });

  it("disagreement among models about provenance changes nothing", async () => {
    const q = "Compare total cost.";
    const flagsDiffer = surfaces(await run(q, [dsJson({ userProvidedCriteria: ["Vendor lock-in"] }), dsJson({ userProvidedCriteria: [] }), dsJson({ userProvidedCriteria: ["Total cost", "Vendor lock-in"] })]));
    const noFlags = surfaces(await run(q, [dsJson({ userProvidedCriteria: [] }), dsJson({ userProvidedCriteria: [] }), dsJson({ userProvidedCriteria: [] })]));
    expect(flagsDiffer.ds.criteria).toEqual(noFlags.ds.criteria);
    expect(flagsDiffer.receipt).toEqual(noFlags.receipt);
    expect(noFlags.ds.criteria.map((c) => c.source)).toEqual(["user", "model"]);
  });

  it("the DISPLAYED cluster label is what is matched; a matching underlying entry does not validate a different label", async () => {
    // Two models say "Ease of integrations", one says "Ease of integration": one cluster, displayed label = the mode.
    const raws = [
      dsJson({ criteria: ["Ease of integrations"], assessments: [] }),
      dsJson({ criteria: ["Ease of integrations"], assessments: [] }),
      dsJson({ criteria: ["Ease of integration"], assessments: [] }),
    ];
    const s = surfaces(await run("We care about ease of integration", raws));
    expect(s.ds.criteria.map((c) => c.label)).toEqual(["Ease of integrations"]);
    expect(s.ds.criteria[0].source).toBe("model");
    const s2 = surfaces(await run("We care about ease of integrations", raws));
    expect(s2.ds.criteria[0].source).toBe("user");
  });

  it("a missing original request fails closed but still stamps the marker", async () => {
    const s = surfaces(await run(undefined));
    expect(s.ds.criteriaProvenance).toBe("request_text_v1");
    expect(s.ds.criteria.every((c) => c.source === "model")).toBe(true);
    const empty = surfaces(await run(undefined, [null, "not json"]));
    expect(empty.ds.criteriaProvenance).toBe("request_text_v1");
  });

  it("the corrective retry path classifies against the original request, which it also re-sends unchanged", async () => {
    const conn = (connectorMap.chatgpt = jest.fn(async () => ({ modelId: "chatgpt", status: "ok", rawText: dsJson(), latencyMs: 9 })));
    const retry: AdaptiveRetryContext = {
      apiKeys: {},
      promptOverrides: { chatgpt: "BASE" } as any,
      context: null,
      budget: { startedAtMonoMs: 0, budgetMs: 300_000 },
      usageSink: new AdaptiveRetryUsageSink(),
      now: () => 1_000,
    };
    const question = "Which CRM minimizes vendor lock-in?";
    const out: any = await finalizeAdaptiveRun(SCHEMA, [slot("chatgpt", "{not json")], question, retry, CLASSIFICATION);
    expect(conn).toHaveBeenCalledTimes(1);
    expect((conn.mock.calls[0] as unknown[])[0]).toBe(question);
    expect(out.decisionSupport.criteria.map((c: any) => [c.label, c.source])).toEqual([["Total cost", "model"], ["Vendor lock-in", "user"]]);
  });
});

describe("Item 6A — one stored value, every surface agrees (new results)", () => {
  it.each([
    ["no stated criterion", "Which CRM should we choose?", [] as string[]],
    ["one stated criterion", "Which CRM has the lowest total cost?", ["Total cost"]],
    ["both stated", "Weigh total cost against vendor lock-in.", ["Total cost", "Vendor lock-in"]],
  ])("%s", async (_label, question, expectedUser) => {
    const s = surfaces(await run(question));
    const userLabels = s.ds.criteria.filter((c) => c.source === "user").map((c) => c.label);
    expect(userLabels).toEqual(expectedUser);
    // Dashboard: one "your criterion" tag per user criterion, never "unverified".
    expect(s.html.split("your criterion").length - 1).toBe(expectedUser.length);
    expect(s.html).not.toContain("provenance unverified");
    // Receipt, frozen Receipt (governance record) and export Receipt: identical, suffix exactly on the user criteria.
    const expectedLines = s.ds.criteria.map((c) => `Criterion: ${c.label}${c.source === "user" ? " (stated in request)" : ""}`);
    expect(criterionLines(s.receipt.basis)).toEqual(expectedLines);
    expect(s.gov.ok).toBe(true);
    expect(s.gov.record.decisionReceipt).toEqual(s.receipt);
    expect(s.exported.milestone2.decisionReceipt).toEqual(s.receipt);
    expect(s.exported.milestone2.result.criteria).toEqual(s.ds.criteria);
    expect(s.receipt.basis.some((l: string) => l.endsWith("(user-provided)"))).toBe(false);
    // Limitations: the inferred-criteria line iff no criterion is user; never the legacy line.
    expect(s.po.meta.limitations.includes(INFERRED_LIMITATION)).toBe(expectedUser.length === 0);
    expect(s.receipt.limitations.includes(INFERRED_LIMITATION)).toBe(expectedUser.length === 0);
    expect(s.receipt.limitations).not.toContain(LEGACY_PROVENANCE_LIMITATION);
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
    expect(criterionLines(receipt.basis)).toEqual(["Criterion: Total cost (provenance unverified)", "Criterion: Vendor lock-in"]);
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
    expect(criterionLines(receipt.basis)).toEqual(["Criterion: Total cost", "Criterion: Vendor lock-in"]);
    expect(receipt.limitations).not.toContain(LEGACY_PROVENANCE_LIMITATION);
  });

  it("a frozen pre-6A Receipt is rendered exactly as recorded plus a read-only notice; the record object is not modified", async () => {
    const { receipt } = surfaces(await run("Which CRM?"));
    const frozen = { ...receipt, basis: ["Criterion: Total cost (user-provided)", "Criterion: Vendor lock-in", ...receipt.basis.slice(2)] };
    const before = JSON.stringify(frozen);
    const html = renderToStaticMarkup(createElement(DecisionReceiptSection, { receipt: frozen, reviewOverview: "" }));
    expect(html).toContain("Criterion: Total cost (user-provided)");
    expect(html).toContain('data-testid="receipt-legacy-provenance-notice"');
    expect(html).toContain(LEGACY_FROZEN_RECEIPT_NOTICE.replace(/"/g, "&quot;"));
    expect(JSON.stringify(frozen)).toBe(before);
    // A new Receipt never triggers the notice.
    const fresh = renderToStaticMarkup(createElement(DecisionReceiptSection, { receipt, reviewOverview: "" }));
    expect(fresh).not.toContain("receipt-legacy-provenance-notice");
    // The shared notice component (also used by the personal-review surface) follows the same rule.
    expect(renderToStaticMarkup(createElement(LegacyReceiptProvenanceNotice, { basis: frozen.basis }))).toContain("receipt-legacy-provenance-notice");
    expect(renderToStaticMarkup(createElement(LegacyReceiptProvenanceNotice, { basis: receipt.basis }))).toBe("");
  });
});

describe("Item 6A correction round — F3 spoofing, F7 wording, F8 question-only authority", () => {
  it("F3: a model label imitating the verified suffix is shown without it, and never as 'your criterion'", async () => {
    const raws = [dsJson({ criteria: ["Vendor lock-in (stated in request)"], assessments: [] }), dsJson({ criteria: ["Vendor lock-in (stated in request)"], assessments: [] })];
    const s = surfaces(await run("Which CRM is cheapest?", raws));
    expect(s.ds.criteria[0].source).toBe("model");
    expect(criterionLines(s.receipt.basis)).toEqual(["Criterion: Vendor lock-in"]);
    expect(s.html).not.toContain("(stated in request)");
    expect(s.html).not.toContain("your criterion");
  });
  it("F3: a model label imitating the retired suffix cannot trigger the frozen-Receipt notice on a new Receipt", async () => {
    const raws = [dsJson({ criteria: ["Budget (user-provided)"], assessments: [] }), dsJson({ criteria: ["Budget (user-provided)"], assessments: [] })];
    const s = surfaces(await run("Which CRM?", raws));
    expect(criterionLines(s.receipt.basis)).toEqual(["Criterion: Budget"]);
    expect(renderToStaticMarkup(createElement(DecisionReceiptSection, { receipt: s.receipt, reviewOverview: "" }))).not.toContain("receipt-legacy-provenance-notice");
  });
  it("F3: a genuinely stated criterion keeps exactly one trusted suffix even if the model also wrote one", async () => {
    const raws = [dsJson({ criteria: ["Total cost (stated in request)"], assessments: [] }), dsJson({ criteria: ["Total cost (stated in request)"], assessments: [] })];
    const s = surfaces(await run("Which CRM has the lowest total cost?", raws));
    expect(criterionLines(s.receipt.basis)).toEqual(["Criterion: Total cost (stated in request)"]);
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
    const nonCriterion = (b: string[]) => b.filter((l) => !l.startsWith("Criterion: "));
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
