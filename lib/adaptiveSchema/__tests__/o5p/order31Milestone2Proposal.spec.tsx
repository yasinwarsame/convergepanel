/**
 * Order 31 R-2 / R-3 (owner-authorized controlled exception to dsProvenanceUiBoundaries, coordinator ruling): a
 * Milestone-2 report has no verification gate. Its summary level is labelled by panel slot (the Milestone-2 UI vocabulary)
 * when its run is not independent executing models, and is unavailable when no / one model answered — in the summary
 * bar, the PDF and the DOCX. Genuine runs keep "Strong consensus"; a legacy-family report keeps its legitimate gate.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TopSummaryBar from "@/components/adaptive/TopSummaryBar";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";
import { runModelProvenanceFromResultRow } from "@/lib/panel/runModelIdentity";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { extractDocxText } from "@/lib/docx/__tests__/testUtils";
import { htmlText } from "./htmlText";
import { NO_RESPONSES_RUN, SLOT_AGREEMENT_FIELD, SLOT_AGREEMENT_NO_RESPONSES_WORD, SLOT_AGREEMENT_NOTE, SLOT_AGREEMENT_TOO_FEW_WORD, SLOT_AGREEMENT_WORD, TOO_FEW_ANSWERS_RUN, slotAgreementWord } from "@/lib/adaptiveSchema/verdictIndependence";
import { exportMilestone2SummaryLevel } from "@/lib/adaptiveSchema/exportPositionView";

const FIVE = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const P: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" };
const answered = (m: string) => ({ modelId: m, provider: P[m], requestedModel: `${m}-1`, substituted: false, outcome: "answered", outcomeSource: "recorded" });
const timedOut = (m: string) => ({ modelId: m, requestedModel: `${m}-1`, substituted: false, outcome: "timeout", outcomeSource: "recorded" });
const prov = (n: number) => ({ provenanceVersion: 2, policyVersion: 3, models: FIVE.map((m, i) => (i < n ? answered(m) : timedOut(m))) });
function rec(runProvenance: unknown, schemaId = "comparison_matrix", level = "strong"): any {
  return { version: 1, exportId: "e", runId: "r", schemaId, schemaFamily: "milestone2", schemaVersion: 1, reportVersion: 1, createdAt: "2026-10-08T00:00:00.000Z", createdBy: "u", format: "pdf", artifactStatus: "ready", classification: "internal",
    governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
    reportSnapshot: { question: "Which?", models: FIVE.map((m) => ({ modelId: m })), reportTypeLabel: "Comparison Report", consensusLevel: level, sourceGroundingLevel: "strong", reportGeneratedAt: "2026-10-07T00:00:00.000Z", ...(runProvenance === undefined ? {} : { runProvenance }), milestone2: { schemaId, result: { subjects: [], attributes: [], cells: [] }, meta: {} } },
    exportMetadata: { exportId: "e", runId: "r", schemaVersion: 1, exportedSections: ["reportSnapshot.milestone2"], createdAt: "2026-10-08T00:00:00.000Z", requestingUser: "u", finalReportVersion: 1 } };
}
async function summaries(r: any): Promise<string[]> {
  const pt = extractPdfElementText(AdaptiveResearchDocument({ record: r }));
  const dt = await extractDocxText((await renderAdaptiveResearchDocxV1({ ...r, format: "docx" })).bytes);
  return [pt, dt].map((t) => { const i = t.indexOf("Report status summary"); return t.slice(i, i + 700).replace(/\s+/g, " "); });
}

describe("R-2: Milestone-2 exports never state a verification gate", () => {
  it.each([
    ["all timeout", prov(0), SLOT_AGREEMENT_NO_RESPONSES_WORD],
    ["one answer + 4 timeouts", prov(1), SLOT_AGREEMENT_TOO_FEW_WORD],
    ["pre-6.2b (no provenance)", undefined, "High (panel slots, not independent models)"],
  ])("%s → Agreement by panel slot: %s", async (_l, p, word) => {
    for (const s of await summaries(rec(p))) {
      expect(s).not.toMatch(/Verification gate|Strong consensus|\bPass\b|\bFail\b/i);
      expect(s.toLowerCase()).toContain(`agreement by panel slot ${word}`.toLowerCase());
      expect(s).toContain(SLOT_AGREEMENT_NOTE.replace(/\s+/g, " "));
    }
  });
  it.each([["genuine 5 answered", 5], ["genuine 2 answered + 3 timeouts", 2]])("%s keeps 'Consensus: Strong consensus'", async (_l, n) => {
    for (const s of await summaries(rec(prov(n as number)))) {
      expect(s.toLowerCase()).toContain("consensus strong consensus");
      expect(s.toLowerCase()).not.toContain("agreement by panel slot");
    }
  });
});

describe("R-3: the Milestone-2 summary bar", () => {
  const cm = { subjects: ["A", "B"], attributes: ["x", "y"], cells: [0, 1, 2, 3].map((i) => ({ subject: "A", attribute: "x" + i, agreement: "consensus", values: [] })) };
  const bar = (rows: any[]) => htmlText(renderToStaticMarkup(createElement(RunModelProvenanceContext.Provider, { value: rows.map((r) => runModelProvenanceFromResultRow(r)) }, createElement(TopSummaryBar as any, { schemaId: "comparison_matrix", results: rows, comparisonMatrix: cm, persistenceStatus: "saved" }))));
  it.each([
    ["all timeout", FIVE.map((m) => ({ modelId: m, status: "timeout" })), SLOT_AGREEMENT_NO_RESPONSES_WORD],
    ["1 ok + 4 timeouts", FIVE.map((m, i) => (i === 0 ? { modelId: m, status: "ok", provider: P[m], rawText: "x" } : { modelId: m, status: "timeout" })), SLOT_AGREEMENT_TOO_FEW_WORD],
  ])("%s → never 'Strong consensus'", (_l, rows, word) => {
    const t = bar(rows as any[]);
    expect(t).not.toContain("Strong consensus");
    expect(t).toContain(`Agreement by panel slot ${word}`);
  });
  it("genuine 5 → 'Consensus Strong consensus' (unchanged)", () => {
    expect(bar(FIVE.map((m) => ({ modelId: m, status: "ok", provider: P[m], rawText: "x" })))).toContain("Consensus Strong consensus");
  });
});

describe("R-2 boundaries: gate-absent vs gate-present, tiers, Decision Support", () => {
  it.each([
    ["weak tier, pre-6.2b", undefined, "weak", "Low (panel slots, not independent models)"],
    ["moderate tier, pre-6.2b", undefined, "moderate", "Moderate (panel slots, not independent models)"],
    ["weak tier, all timeout", prov(0), "weak", SLOT_AGREEMENT_NO_RESPONSES_WORD],
    ["moderate tier, one answer", prov(1), "moderate", SLOT_AGREEMENT_TOO_FEW_WORD],
  ])("%s → never 'Verification gate: Fail / Caution'", async (_l, p, level, word) => {
    expect(exportMilestone2SummaryLevel(rec(p, "comparison_matrix", level as string))).toEqual({ field: SLOT_AGREEMENT_FIELD, word, note: SLOT_AGREEMENT_NOTE });
    for (const s of await summaries(rec(p, "comparison_matrix", level as string))) {
      expect(s).not.toMatch(/Verification gate|\bFail\b|\bCaution\b/i);
      expect(s.toLowerCase()).toContain(`agreement by panel slot ${word}`.toLowerCase());
    }
  });
  it("'Split' / 'Not scored' tiers claim no agreement: unchanged 'Consensus' field", async () => {
    for (const level of ["split", "unscored"]) {
      expect(exportMilestone2SummaryLevel(rec(prov(0), "comparison_matrix", level))).toBeNull();
      for (const s of await summaries(rec(prov(0), "comparison_matrix", level))) expect(s.toLowerCase()).toMatch(/consensus (split|not scored)/);
    }
  });
  it("genuine independent runs, Decision Support and a legacy-family (gated) export → null", () => {
    expect(exportMilestone2SummaryLevel(rec(prov(5)))).toBeNull();
    expect(exportMilestone2SummaryLevel(rec(prov(2)))).toBeNull();
    const ds = rec(prov(0), "decision_support");
    expect(exportMilestone2SummaryLevel(ds)).toBeNull();
    const legacy = rec(prov(0));
    legacy.schemaFamily = "legacy";
    expect(exportMilestone2SummaryLevel(legacy)).toBeNull();
    const withSynthesis = rec(prov(0));
    withSynthesis.reportSnapshot.legacy = { synthesisReport: { gate: "pass" } };
    expect(exportMilestone2SummaryLevel(withSynthesis)).toBeNull();
  });
  it("slotAgreementWord: unavailable only for no / too few answers; otherwise the slot tier word", () => {
    expect(slotAgreementWord("strong", NO_RESPONSES_RUN)).toBe(SLOT_AGREEMENT_NO_RESPONSES_WORD);
    expect(slotAgreementWord("strong", TOO_FEW_ANSWERS_RUN)).toBe(SLOT_AGREEMENT_TOO_FEW_WORD);
    expect(slotAgreementWord("strong", { kind: "unverified", scope: "run" })).toBe(SLOT_AGREEMENT_WORD.strong);
    expect(slotAgreementWord("weak", { kind: "unverified", scope: "run", basis: "failed_supporters" })).toBe(SLOT_AGREEMENT_WORD.weak);
    expect(slotAgreementWord("moderate", null)).toBe(SLOT_AGREEMENT_WORD.moderate);
    expect(SLOT_AGREEMENT_NO_RESPONSES_WORD).toBe("Unavailable (no successful model responses)");
    expect(SLOT_AGREEMENT_TOO_FEW_WORD).toBe("Unavailable (fewer than two independent models responded)");
  });
});

describe("R-3 boundaries: the summary bar", () => {
  const cmOf = (agreement: string) => ({ subjects: ["A", "B"], attributes: ["x", "y"], cells: [0, 1, 2, 3].map((i) => ({ subject: "A", attribute: "x" + i, agreement, values: [] })) });
  const bar = (rows: any[], cm: any) => htmlText(renderToStaticMarkup(createElement(RunModelProvenanceContext.Provider, { value: rows.map((r) => runModelProvenanceFromResultRow(r)) }, createElement(TopSummaryBar as any, { schemaId: "comparison_matrix", results: rows, comparisonMatrix: cm, persistenceStatus: "saved" }))));
  const allTimeout = FIVE.map((m) => ({ modelId: m, status: "timeout" }));
  it("an unscored result (no cells) over an all-timeout run keeps 'Consensus Not scored' (claims no agreement; not relabelled)", () => {
    const t = bar(allTimeout, { subjects: [], attributes: [], cells: [] });
    expect(t).toContain("Consensus Not scored");
    expect(t).not.toContain("Agreement by panel slot");
  });
  it("a weak-tier result (split cells) over an all-timeout run is unavailable, never 'Weak consensus'", () => {
    const t = bar(allTimeout, cmOf("split"));
    expect(t).toContain(`Agreement by panel slot ${SLOT_AGREEMENT_NO_RESPONSES_WORD}`);
    expect(t).not.toMatch(/Weak consensus|Strong consensus/);
  });
  it("two genuine answers + three timeouts keep 'Consensus Strong consensus'", () => {
    const rows = FIVE.map((m, i) => (i < 2 ? { modelId: m, status: "ok", provider: P[m], rawText: "x" } : { modelId: m, status: "timeout" }));
    expect(bar(rows, cmOf("consensus"))).toContain("Consensus Strong consensus");
  });
  it("one substitute model in every answering slot (no failures): the slot tier word as before", () => {
    const rows = FIVE.map((m) => ({ modelId: m, status: "substituted", provider: "deepseek", requestedModel: "deepseek-chat", substitutedFrom: `${P[m]}:${m}-1`, rawText: "x" }));
    expect(bar(rows, cmOf("consensus"))).toContain("Agreement by panel slot High (panel slots, not independent models)");
  });
});
