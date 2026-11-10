/**
 * Order 31 / Order A (review of 87f4620, R-1 and n-E): stored counts are UNTRUSTED for independent-model presentation
 * unless the run's execution evidence corroborates them. When the run records a failed call and fewer than two
 * independent executing models answered, no UI / share / memo / PDF / DOCX surface states multi-model agreement — not
 * "Top consensus — agreed by 5 models", not "all 5 dispatched models support it", not a verdict-card or agree line —
 * whether the stored rows are joined or not, marked or not. Genuine runs with two or more answering independent verified
 * models keep their agreement wording (no false negatives). Stored records are never mutated.
 *
 * Every case renders the real components and builders (o5pRender.renderRecord) and the real PDF composer
 * (AdaptiveResearchDocument) and DOCX package (renderAdaptiveResearchDocxV1) over a persisted-shape export.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));

import { readFileSync } from "fs";
import { join } from "path";
import { renderRecord, exportRecord } from "./o5pRender";
import { htmlText } from "./htmlText";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { extractDocxText } from "@/lib/docx/__tests__/testUtils";
import { exportRunIndependence } from "@/lib/adaptiveSchema/exportPositionView";
import { presentPositionSafeReport, positionView } from "@/lib/adaptiveSchema/positionPresentation";
import { runModelProvenanceFromResultRow, type RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";
import {
  ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING,
  NO_SUCCESSFUL_MODEL_RESPONSES,
  TOO_FEW_ANSWERS_NAMES_SUFFIX,
  TOO_FEW_ANSWERS_ROW,
  TOO_FEW_ANSWERS_RUN,
  TOO_FEW_ANSWERS_STATEMENT,
  adaptiveTopIndependenceStatement,
  fewerThanTwoAnsweringModels,
  independenceQualification,
  qualifiedRowText,
  qualifiedStatusHeading,
  rowIndependence,
  rowSupportIndependence,
  slotAgreementLabel,
  storedSynthesisRunIndependence,
  unmarkedTopIndependence,
} from "@/lib/adaptiveSchema/verdictIndependence";

const records: Record<string, any> = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "baseline-2c17fee", "records.json"), "utf8"));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const FIVE = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const NAMES: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude", grok: "Grok", perplexity: "Perplexity", gemini: "Gemini" };
const PROVIDER: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" };
const ok = (m: string): any => ({ modelId: m, status: "ok", provider: PROVIDER[m], requestedModel: `${m}-model-1`, rawText: "{}", latencyMs: 1 });
const fl = (m: string, status = "timeout"): any => ({ modelId: m, status, provider: undefined, requestedModel: `${m}-model-1`, rawText: null, latencyMs: 1 });
const sub = (m: string): any => ({ modelId: m, status: "substituted", provider: "deepseek", requestedModel: "deepseek-chat", substitutedFrom: `${PROVIDER[m]}:${m}-model-1`, rawText: "{}", latencyMs: 1 });
const facts = (rows: any[]): RunModelProvenanceFacts[] => rows.map((r) => runModelProvenanceFromResultRow(r));

/** The reviewer's agreement-claim pattern (review-22a7520/zzReviewProbe.spec.tsx), unchanged. */
const AGREE = /Strong consensus|Moderate consensus|Top consensus(?! \()|agreed by \d|Models agree|\d+ independent models?\b(?! \()|consensus of \d|all \d+ dispatched models support it|\d+ of \d+ (models|panel slots) (agree|support)|\d+\/\d+ models|models converge|consensus on \d|support(s|ed)? it\b(?! \()/g;
const SURF = ["ui.synthesisView", "ui.panelResponse", "ui.listView", "ui.primaryStrip", "ui.panelEvidence", "ui.claimMatrix", "ui.governance", "text.markdown", "text.linkedin", "text.x", "text.memo"];
const textOf = (key: string, v: string) => (key.startsWith("ui.") ? htmlText(v) : v);

async function render(rec: any, rows: any[]): Promise<{ per: Record<string, string[]>; texts: Record<string, string>; exp: any }> {
  rec.results = rows;
  const out = await renderRecord(rec, rows);
  const per: Record<string, string[]> = {};
  const texts: Record<string, string> = {};
  for (const k of SURF) {
    const v = out[k];
    if (v == null) continue;
    texts[k] = textOf(k, v);
    per[k] = [...new Set(texts[k].match(AGREE) ?? [])];
  }
  const exp = exportRecord(rec, rows, "pdf");
  if (exp) {
    texts["export.pdf"] = extractPdfElementText(AdaptiveResearchDocument({ record: exp }));
    texts["export.docx"] = await extractDocxText((await renderAdaptiveResearchDocxV1({ ...exp, format: "docx" } as any)).bytes);
    per["export.pdf"] = [...new Set(texts["export.pdf"].match(AGREE) ?? [])];
    per["export.docx"] = [...new Set(texts["export.docx"].match(AGREE) ?? [])];
  }
  return { per, texts, exp };
}
const none = (per: Record<string, string[]>) => Object.fromEntries(Object.keys(per).map((k) => [k, []]));
const CONS = () => clone(records["generic-consensus"]);
const marked = (r: any) => {
  r.synthesisReport.presentation.disagreementPositionVersion = 1;
  return r;
};
/** The reviewer's G16–G18 records: each stored claim row positions only the answering slots, keeps status "consensus", and the stored verdict card and agree lines still say "agreed by 5" / "all 5 dispatched models support it". */
function consistent(answering: string[], joined = true): any {
  const r = CONS();
  for (const c of r.alignedClaims) c.cells = (c.cells || []).filter((x: any) => x && answering.includes(x.modelId));
  for (const c of r.synthesisReport.presentation.answer.claims) {
    c.result = `consensus: all ${answering.length} answering models support it`;
    c.supporters = answering.map((m) => NAMES[m]).join(", ");
  }
  if (!joined) r.alignedClaims = [];
  return r;
}
const oneAnswer = () => [ok("chatgpt"), ...FIVE.slice(1).map((m) => fl(m))];

describe("Order 31 R-1 — one successful response with a stored count of five: no multi-model agreement on any surface", () => {
  it.each([
    ["joined, rows position only the answering slot (review G18)", () => consistent(["chatgpt"])],
    ["joined, stored rows still name the four failed slots (C5)", () => CONS()],
    ["unjoined (no stored rows)", () => ({ ...CONS(), alignedClaims: [] })],
    ["marked (Contract P), joined, rows position only the answering slot", () => marked(consistent(["chatgpt"]))],
    ["legacy (no presentation), joined", () => { const c = CONS(); delete c.synthesisReport.presentation; return c; }],
  ])("%s", async (_label, make) => {
    const rec = make();
    // The stored record says five — and keeps saying it (never mutated).
    expect(rec.synthesisReport.verdictCard.consensusModelCount).toBe(5);
    const before = JSON.stringify(rec.synthesisReport);
    const { per, texts, exp } = await render(rec, oneAnswer());
    expect(JSON.stringify(rec.synthesisReport)).toBe(before);
    expect(per).toEqual(none(per));
    for (const k of ["ui.synthesisView", "ui.panelResponse", "ui.governance", "text.markdown", "text.memo", "export.pdf", "export.docx"]) {
      expect([k, texts[k].includes(TOO_FEW_ANSWERS_STATEMENT)]).toEqual([k, true]);
      expect([k, /agreed by \d/.test(texts[k])]).toEqual([k, false]);
      expect([k, texts[k].includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, false]);
    }
    expect(texts["ui.panelResponse"]).not.toMatch(/Consensus\s*Strong consensus/);
    expect(exportRunIndependence(exp)).toBe(TOO_FEW_ANSWERS_RUN);
    expect(texts["text.linkedin"]).not.toContain("multi-model AI panel");
  });

  it("the joined verdict card, agree lines and load-bearing line of the review's G18 record (exact text)", async () => {
    const { texts } = await render(consistent(["chatgpt"]), oneAnswer());
    const ui = texts["ui.synthesisView"];
    expect(ui).toContain(`Claim: “Raising the minimum wage reduces employment” Panel result: ${TOO_FEW_ANSWERS_STATEMENT} Supported by: ChatGPT ${TOO_FEW_ANSWERS_NAMES_SUFFIX}`);
    expect(ui).toContain(`Where models agree (model independence unverified) Claim: “Raising the minimum wage reduces employment” Panel result: ${TOO_FEW_ANSWERS_STATEMENT}`);
    expect(ui).toContain(`Panel result: Not an independent consensus (supported by ChatGPT, Claude, Grok, Perplexity, Gemini ${TOO_FEW_ANSWERS_NAMES_SUFFIX})`);
    expect(ui).not.toContain("consensus: all 5 dispatched models support it");
    expect(ui).not.toContain("consensus: all 1 answering models support it");
    expect(texts["export.pdf"]).toContain(`Where models agree / disagree (model independence unverified) ${ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING}`);
  });

  it("the marked (Contract P) view: top heading, joined row, panel statement", () => {
    const rec = marked(consistent(["chatgpt"]));
    const view = presentPositionSafeReport(rec.synthesisReport, { rows: rec.alignedClaims, roster: FIVE, provenance: facts(oneAnswer()) }) as any;
    expect(positionView(view)!.verdict.topHeading).toBe(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING);
    expect(positionView(view)!.verdict.topIndependence).toBe(TOO_FEW_ANSWERS_ROW);
    expect(view.verdictCard.topConsensusAgreement).toBe(TOO_FEW_ANSWERS_STATEMENT);
    expect(view.presentation.panelAgreement).toBe(TOO_FEW_ANSWERS_STATEMENT);
    expect(view.presentation.answer.claims.map((c: any) => c.result)).toEqual(view.presentation.answer.claims.map(() => TOO_FEW_ANSWERS_STATEMENT));
    expect(independenceQualification(view)!.run).toBe(TOO_FEW_ANSWERS_RUN);
    // control: five genuine answers — the marked view states the computed consensus as before
    const ctl = marked(CONS());
    const v5 = presentPositionSafeReport(ctl.synthesisReport, { rows: ctl.alignedClaims, roster: FIVE, provenance: facts(FIVE.map(ok)) }) as any;
    expect(positionView(v5)!.verdict.topHeading).toBe("Top consensus");
    expect(v5.verdictCard.topConsensusAgreement).toBe("consensus: all 5 dispatched models support it");
    expect(v5.presentation.panelAgreement).not.toBe(TOO_FEW_ANSWERS_STATEMENT);
  });
});

describe("Order 31 R-1 — zero answered (the standing default holds)", () => {
  it.each([
    ["all timeout", () => FIVE.map((m) => fl(m))],
    ["all failed", () => FIVE.map((m) => fl(m, "failed"))],
  ])("%s: the constant on UI, PDF and DOCX; no claim; never the too-few statement", async (_l, rows) => {
    const { per, texts, exp } = await render(CONS(), rows());
    expect(per).toEqual(none(per));
    for (const k of ["ui.panelResponse", "export.pdf", "export.docx"]) {
      expect([k, texts[k].includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, true]);
      expect([k, texts[k].includes(TOO_FEW_ANSWERS_STATEMENT)]).toEqual([k, false]);
    }
    expect(exportRunIndependence(exp)).toMatchObject({ basis: "no_responses" });
  });
});

describe("Order 31 R-1 — no false negatives: two or more answering independent verified models keep their agreement", () => {
  it.each([
    ["two genuine successes + 3 timeouts (G16)", () => consistent(["chatgpt", "claude"]), () => [ok("chatgpt"), ok("claude"), ...FIVE.slice(2).map((m) => fl(m))]],
    ["three genuine successes + 2 timeouts (G17)", () => consistent(["chatgpt", "claude", "grok"]), () => [ok("chatgpt"), ok("claude"), ok("grok"), fl("perplexity"), fl("gemini")]],
    ["five genuine successes", () => CONS(), () => FIVE.map(ok)],
  ])("%s", async (_l, make, rows) => {
    const { per, texts, exp } = await render(make(), rows());
    for (const k of ["ui.synthesisView", "ui.panelResponse", "ui.governance", "export.pdf", "export.docx"]) {
      expect([k, texts[k].includes(TOO_FEW_ANSWERS_STATEMENT)]).toEqual([k, false]);
      expect([k, texts[k].includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, false]);
    }
    expect(per["ui.synthesisView"]).toEqual(expect.arrayContaining(["Top consensus"]));
    expect(per["export.pdf"]).toEqual(expect.arrayContaining(["Strong consensus"]));
    expect(per["export.docx"]).toEqual(expect.arrayContaining(["Strong consensus"]));
    expect(exportRunIndependence(exp)).toBeNull();
  });

  it("mixed success and failure, the stored rows naming the failed slot (C10: 4 answered + 1 timeout): failed-supporter qualification as before, never the too-few statement", async () => {
    const { per, texts } = await render(CONS(), [...FIVE.slice(0, 4).map(ok), fl("gemini")]);
    for (const k of ["ui.synthesisView", "export.pdf", "export.docx"]) {
      expect([k, texts[k].includes(TOO_FEW_ANSWERS_STATEMENT)]).toEqual([k, false]);
      expect([k, texts[k].includes("panel slots recorded as supporting it returned no successful model response")]).toEqual([k, true]);
    }
    expect(per["export.pdf"]).toEqual([]);
  });
});

describe("Order 31 R-1 — substituted execution", () => {
  it("one executing model in two slots is counted once: 3 genuine + DeepSeek in 2 slots → 4 independent models, never 5", async () => {
    const { texts } = await render(CONS(), [ok("chatgpt"), ok("claude"), ok("grok"), sub("perplexity"), sub("gemini")]);
    for (const k of ["ui.synthesisView", "export.pdf", "export.docx"]) {
      expect([k, /\b4 independent models\b/.test(texts[k])]).toEqual([k, true]);
      expect([k, /\b5 independent models\b/.test(texts[k])]).toEqual([k, false]);
      expect([k, texts[k].includes(TOO_FEW_ANSWERS_STATEMENT)]).toEqual([k, false]);
    }
  });

  it("one substitute model answering the only two responding slots, 3 timeouts (G19): fewer than two answering models — no stored count, even 'counted by panel slot'", async () => {
    const rows = [sub("chatgpt"), sub("claude"), fl("grok"), fl("perplexity"), fl("gemini")];
    expect(storedSynthesisRunIndependence(facts(rows), true)).toBe(TOO_FEW_ANSWERS_RUN);
    const { texts, exp } = await render(consistent(["chatgpt", "claude"]), rows);
    for (const k of Object.keys(texts)) expect([k, texts[k].includes("all 5 dispatched models support it")]).toEqual([k, false]);
    expect(texts["ui.primaryStrip"]).toContain(TOO_FEW_ANSWERS_STATEMENT);
    // the joined rows keep naming the one executing model (not an independent consensus)
    expect(texts["ui.synthesisView"]).toContain("not an independent consensus: the 2 panel slots supporting it were all answered by one model, DeepSeek");
    expect(exportRunIndependence(exp)).toBe(TOO_FEW_ANSWERS_RUN);
  });
});

describe("Order 31 R-1 — historical unknown provenance", () => {
  it("rows with no recorded status (pre-status history) over a stored consensus: unverified, never the too-few statement or the constant", async () => {
    const { texts } = await render(CONS(), FIVE.map((m) => ({ ...fl(m), status: undefined })));
    for (const k of ["ui.synthesisView", "export.pdf"]) {
      expect([k, texts[k].includes(TOO_FEW_ANSWERS_STATEMENT)]).toEqual([k, false]);
      expect([k, texts[k].includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, false]);
      expect([k, /model independence unverified/i.test(texts[k])]).toEqual([k, true]);
    }
  });

  it("a version-1 frozen export over one answer + 4 timeouts: no recorded outcome → unverified, never the too-few statement", async () => {
    const rec = CONS();
    rec.results = oneAnswer();
    const exp = exportRecord(rec, oneAnswer(), "pdf")!;
    delete (exp.reportSnapshot.runProvenance as any).provenanceVersion;
    const pdf = extractPdfElementText(AdaptiveResearchDocument({ record: exp }));
    expect(exportRunIndependence(exp)).toMatchObject({ kind: "unverified" });
    expect(exportRunIndependence(exp)).not.toBe(TOO_FEW_ANSWERS_RUN);
    expect(pdf).not.toContain(TOO_FEW_ANSWERS_STATEMENT);
    expect(pdf).toMatch(/model independence unverified/i);
  });
});

describe("Order 31 — an adaptive report WITH a legitimate verification gate still shows its gate", () => {
  it("a marked report over five genuine answers: 'Verification gate · Pass' in the PDF and DOCX status summary", async () => {
    const { texts } = await render(marked(CONS()), FIVE.map(ok));
    for (const k of ["export.pdf", "export.docx"]) expect([k, /Report status summary[\s\S]{0,600}Verification gate[\s\S]{0,300}\bPass\b/.test(texts[k])]).toEqual([k, true]);
  });
});

describe("Order 31 R-1 — the predicates and wording, pinned", () => {
  it("fewerThanTwoAnsweringModels: needs a recorded failure, counts responding slots by executing model", () => {
    expect(fewerThanTwoAnsweringModels(facts(oneAnswer()))).toBe(true);
    expect(fewerThanTwoAnsweringModels(facts(FIVE.map((m) => fl(m))))).toBe(true);
    expect(fewerThanTwoAnsweringModels(facts([sub("chatgpt"), sub("claude"), fl("grok")]))).toBe(true);
    expect(fewerThanTwoAnsweringModels(facts([ok("chatgpt"), ok("claude"), fl("grok")]))).toBe(false);
    expect(fewerThanTwoAnsweringModels(facts([ok("chatgpt"), sub("claude"), fl("grok")]))).toBe(false);
    expect(fewerThanTwoAnsweringModels(facts([ok("chatgpt")]))).toBe(false);
    expect(fewerThanTwoAnsweringModels(facts([ok("chatgpt"), { ...ok("claude"), status: "pending" }]))).toBe(false);
    expect(fewerThanTwoAnsweringModels([...facts([ok("chatgpt"), fl("grok")]), { modelId: "claude", status: "ok", provider: "anthropic", invalidProviderOutput: true } as any])).toBe(true);
    expect(fewerThanTwoAnsweringModels(null)).toBe(false);
    expect(fewerThanTwoAnsweringModels([])).toBe(false);
  });

  it("rowIndependence: a consensus / majority row over such a run → TOO_FEW_ANSWERS_ROW; split and other statuses, and 2+ answering runs → as before", () => {
    const p = facts(oneAnswer());
    const row = (status: string, cells: [string, string][]) => ({ claimText: "c", status, cells: cells.map(([modelId, stance]) => ({ modelId, stance })) });
    expect(rowIndependence(row("consensus", [["chatgpt", "agrees"]]), p)!.t).toBe(TOO_FEW_ANSWERS_ROW);
    expect(rowIndependence(row("majority", [["chatgpt", "agrees"]]), p)!.support).toBe(TOO_FEW_ANSWERS_ROW);
    expect(rowIndependence(row("consensus", [["chatgpt", "agrees"], ["claude", "agrees"]]), p)!.t).toBe(TOO_FEW_ANSWERS_ROW);
    expect(rowIndependence(row("single_source", [["chatgpt", "agrees"]]), p)).toBeNull();
    expect(rowIndependence(row("limited_coverage", [["chatgpt", "agrees"]]), p)).toBeNull();
    expect(rowIndependence(row("consensus", [["claude", "agrees"], ["grok", "agrees"]]), p)!.t).toMatchObject({ basis: "no_responses" });
    const two = facts([ok("chatgpt"), ok("claude"), fl("grok")]);
    expect(rowIndependence(row("consensus", [["chatgpt", "agrees"], ["claude", "agrees"]]), two)).toBeNull();
    expect(rowIndependence(row("consensus", [["chatgpt", "agrees"]]), two)).toBeNull();
    expect(rowSupportIndependence(row("consensus", [["chatgpt", "agrees"]]), p)).toBe(TOO_FEW_ANSWERS_ROW);
    expect(rowSupportIndependence(row("consensus", [["chatgpt", "agrees"]]), two)).toBeNull();
    // a repeated substitute row keeps its own wording (it already states one executing model)
    const g19 = facts([sub("chatgpt"), sub("claude"), fl("grok")]);
    expect(rowIndependence(row("consensus", [["chatgpt", "agrees"], ["claude", "agrees"]]), g19)!.t).toMatchObject({ kind: "repeated_substitute" });
  });

  it("the top claim of an unmarked report handed without its view (unmarkedTopIndependence)", () => {
    const rec = consistent(["chatgpt"]);
    expect(unmarkedTopIndependence(rec.synthesisReport.verdictCard, rec.alignedClaims, facts(oneAnswer()))).toBe(TOO_FEW_ANSWERS_ROW);
    expect(unmarkedTopIndependence(rec.synthesisReport.verdictCard, null, facts(oneAnswer()))).toBe(TOO_FEW_ANSWERS_RUN);
    expect(unmarkedTopIndependence(rec.synthesisReport.verdictCard, rec.alignedClaims, facts([ok("chatgpt"), ok("claude"), fl("grok")]))).toBeNull();
  });

  it("wording: statement, heading, row text, side clause, map label", () => {
    expect(adaptiveTopIndependenceStatement(TOO_FEW_ANSWERS_ROW, 5)).toBe(TOO_FEW_ANSWERS_STATEMENT);
    expect(adaptiveTopIndependenceStatement(TOO_FEW_ANSWERS_RUN, 5)).toBe(TOO_FEW_ANSWERS_STATEMENT);
    expect(qualifiedStatusHeading("consensus", TOO_FEW_ANSWERS_ROW)).toBe("Not an independent consensus");
    expect(qualifiedStatusHeading("majority", TOO_FEW_ANSWERS_ROW)).toBe("Not an independent majority");
    const p = facts(oneAnswer());
    const r1 = { claimText: "c", status: "consensus", cells: [{ modelId: "chatgpt", stance: "agrees" }] };
    expect(qualifiedRowText(r1, rowIndependence(r1, p)!)).toBe(TOO_FEW_ANSWERS_STATEMENT);
    // a disputing side that recorded a failed call: each side stated, no count on the supporting side
    const r2 = { claimText: "c", status: "majority", cells: [{ modelId: "chatgpt", stance: "agrees" }, { modelId: "grok", stance: "disputes" }] };
    expect(qualifiedRowText(r2, rowIndependence(r2, p)!)).toBe(
      "recorded as majority support: panel slots are recorded as supporting it, but fewer than two independent models returned a successful response in this run (no count stated); no successful model response disputes it"
    );
    expect(slotAgreementLabel(1, 0, 4, 5, rowIndependence(r1, p))).toBe(TOO_FEW_ANSWERS_STATEMENT);
    expect(TOO_FEW_ANSWERS_NAMES_SUFFIX).toBe("(panel slots; fewer than two independent models returned a successful response in this run)");
  });

  it("the stored-synthesis run rule judges too few answers before the run's own kind, only for a stored synthesis that states agreement", () => {
    const g19 = facts([sub("chatgpt"), sub("claude"), fl("grok")]);
    expect(storedSynthesisRunIndependence(g19, true)).toBe(TOO_FEW_ANSWERS_RUN);
    expect(storedSynthesisRunIndependence(g19, false)).toMatchObject({ kind: "repeated_substitute" });
    expect(storedSynthesisRunIndependence(facts([ok("chatgpt"), ok("claude"), fl("grok")]), true)).toBeNull();
  });
});
