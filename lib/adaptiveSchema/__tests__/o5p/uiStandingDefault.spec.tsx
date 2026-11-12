/**
 * Order 30 round 2 (review of 22a7520, m-A / m-B): the standing attribution default on every UI, share and memo surface
 * (the real components and builders, o5pRender.renderRecord) and the PDF / DOCX. With a stored synthesis over a run with
 * zero answered verified slots — joined and unjoined — and over a run with one answering model, no surface makes an
 * agreement / consensus / support-count claim. Genuine independent agreement still renders as before.
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
import { NO_RESPONSES_RUN, NO_SUCCESSFUL_MODEL_RESPONSES, TOO_FEW_ANSWERS_RUN, TOO_FEW_ANSWERS_STATEMENT, independenceQualification } from "@/lib/adaptiveSchema/verdictIndependence";
import { presentPositionSafeReport } from "@/lib/adaptiveSchema/positionPresentation";
import { runModelProvenanceFromResultRow } from "@/lib/panel/runModelIdentity";

const records: Record<string, any> = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "baseline-2c17fee", "records.json"), "utf8"));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const FIVE = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const PROVIDER: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" };
const ok = (m: string): any => ({ modelId: m, status: "ok", provider: PROVIDER[m], requestedModel: `${m}-model-1`, rawText: "{}", latencyMs: 1 });
const fl = (m: string, status = "timeout"): any => ({ modelId: m, status, provider: undefined, requestedModel: `${m}-model-1`, rawText: null, latencyMs: 1 });
/** The reviewer's agreement-claim pattern (review-22a7520/zzReviewProbe.spec.tsx). */
const AGREE = /Strong consensus|Moderate consensus|Top consensus(?! \()|agreed by \d|Models agree|\d+ independent models?\b(?! \()|consensus of \d|all \d+ dispatched models support it|\d+ of \d+ (models|panel slots) (agree|support)|\d+\/\d+ models|models converge|consensus on \d|support(s|ed)? it\b(?! \()/g;
const SURF = ["ui.synthesisView", "ui.panelResponse", "ui.listView", "ui.primaryStrip", "ui.panelEvidence", "ui.claimMatrix", "ui.governance", "text.markdown", "text.linkedin", "text.x", "text.memo"];
const textOf = (key: string, v: string) => (key.startsWith("ui.") ? htmlText(v) : v);

async function claims(rec: any, rows: any[], surfaces = SURF): Promise<{ per: Record<string, string[]>; texts: Record<string, string> }> {
  rec.results = rows;
  const out = await renderRecord(rec, rows);
  const per: Record<string, string[]> = {};
  const texts: Record<string, string> = {};
  for (const k of surfaces) {
    const v = out[k];
    if (v == null) continue;
    texts[k] = textOf(k, v);
    per[k] = [...new Set(texts[k].match(AGREE) ?? [])];
  }
  const pdf = exportRecord(rec, rows, "pdf");
  if (!pdf) return { per, texts };
  texts["export.pdf"] = extractPdfElementText(AdaptiveResearchDocument({ record: pdf }));
  texts["export.docx"] = await extractDocxText((await renderAdaptiveResearchDocxV1({ ...pdf, format: "docx" } as any)).bytes);
  per["export.pdf"] = [...new Set(texts["export.pdf"].match(AGREE) ?? [])];
  per["export.docx"] = [...new Set(texts["export.docx"].match(AGREE) ?? [])];
  return { per, texts };
}
const none = (per: Record<string, string[]>) => Object.fromEntries(Object.keys(per).map((k) => [k, []]));
const CONS = () => clone(records["generic-consensus"]);

describe("Order 30 round 2 m-A: zero answered slots + a stored synthesis → no agreement claim on any surface", () => {
  it.each([
    ["all timeout, joined rows", () => CONS(), () => FIVE.map((m) => fl(m))],
    ["all timeout, no joined rows", () => ({ ...CONS(), alignedClaims: [] }), () => FIVE.map((m) => fl(m))],
    ["all 'failed', joined", () => CONS(), () => FIVE.map((m) => fl(m, "failed"))],
    ["mixed failure statuses, joined", () => CONS(), () => [fl("chatgpt", "failed"), fl("claude", "error"), fl("grok"), fl("perplexity", "refused"), fl("gemini", "rate_limited")]],
    ["marked report, all timeout", () => { const c = CONS(); c.synthesisReport.presentation.disagreementPositionVersion = 1; return c; }, () => FIVE.map((m) => fl(m))],
    ["legacy (no presentation), joined", () => { const c = CONS(); delete c.synthesisReport.presentation; return c; }, () => FIVE.map((m) => fl(m))],
    ["legacy (no presentation), unjoined", () => { const c = { ...CONS(), alignedClaims: [] }; delete c.synthesisReport.presentation; return c; }, () => FIVE.map((m) => fl(m))],
  ])("%s", async (_label, rec, rows) => {
    const { per, texts } = await claims(rec(), rows());
    expect(per).toEqual(none(per));
    expect(texts["ui.panelResponse"]).toContain(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(texts["ui.panelResponse"]).not.toMatch(/Consensus\s*Strong consensus/);
    expect(texts["export.pdf"]).toContain(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(texts["export.docx"]).toContain(NO_SUCCESSFUL_MODEL_RESPONSES);
  });

  it("control: the real all-failed record (no stored synthesis) renders as before (Order 29 option (b) — the oracle holds)", async () => {
    const { texts } = await claims(clone(records["generic-all-failed"]), FIVE.map((m) => fl(m)));
    expect(texts["ui.panelResponse"]).toBeDefined();
    expect(texts["ui.panelResponse"]).not.toContain(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(texts["ui.panelResponse"]).toMatch(/Consensus\s*Not scored/);
  });
});

describe("Order 30 round 2 m-B: one answering model + a stored consensus with no joined rows", () => {
  it("no 'all 5 dispatched models support it', no 'Strong consensus', on any surface; the too-few statement is shown", async () => {
    const { per, texts } = await claims({ ...CONS(), alignedClaims: [] }, [ok("chatgpt"), ...FIVE.slice(1).map((m) => fl(m))]);
    expect(per).toEqual(none(per));
    for (const k of ["ui.panelResponse", "export.pdf", "export.docx"]) expect([k, texts[k].includes(TOO_FEW_ANSWERS_STATEMENT)]).toEqual([k, true]);
  });

  it("control: genuine 5-model independent agreement keeps every stored agreement statement", async () => {
    const { per } = await claims(CONS(), FIVE.map(ok));
    expect(per["ui.panelResponse"]).toEqual(expect.arrayContaining(["Strong consensus", "all 5 dispatched models support it"]));
    expect(per["export.pdf"]).toEqual(expect.arrayContaining(["Strong consensus", "all 5 dispatched models support it"]));
  });
});

describe("Order 30 round 2 — run-level surfaces of a stored synthesis (marked view, diagnostics badge, share phrase)", () => {
  it("a marked view carries the stored-synthesis run judgement (no responses / too few answers), and the share introduces no multi-model panel", async () => {
    const marked = () => { const c = CONS(); c.synthesisReport.presentation.disagreementPositionVersion = 1; return c; };
    const zero = marked();
    const facts = (rows: any[]) => rows.map((r) => runModelProvenanceFromResultRow(r));
    const v0 = presentPositionSafeReport(zero.synthesisReport, { rows: zero.alignedClaims, roster: FIVE, provenance: facts(FIVE.map((m) => fl(m))) });
    expect(independenceQualification(v0)!.run).toBe(NO_RESPONSES_RUN);
    const one = marked();
    const v1 = presentPositionSafeReport(one.synthesisReport, { rows: one.alignedClaims, roster: FIVE, provenance: facts([ok("chatgpt"), ...FIVE.slice(1).map((m) => fl(m))]) });
    expect(independenceQualification(v1)!.run).toBe(TOO_FEW_ANSWERS_RUN);
    const { texts } = await claims(marked(), [ok("chatgpt"), ...FIVE.slice(1).map((m) => fl(m))], ["text.linkedin"]);
    expect(texts["text.linkedin"]).toContain("an AI panel (model independence unverified: panel slots of this run returned no successful model response)");
    expect(texts["text.linkedin"]).not.toContain("multi-model AI panel");
  });

  it("the diagnostics uniformity badge of a stored synthesis over an all-failed run is never 'Unusually uniform agreement'", async () => {
    const rec = CONS();
    rec.synthesisReport.diagnostics = { ...rec.synthesisReport.diagnostics, homogeneityFlag: true };
    const { texts } = await claims(rec, FIVE.map((m) => fl(m)), ["ui.synthesisView"]);
    expect(texts["ui.synthesisView"]).toContain("Unusually uniform responses (model independence unverified)");
    expect(texts["ui.synthesisView"]).not.toContain("Unusually uniform agreement");
    // control: 5 verified answers keep the stored badge
    const ctl = CONS();
    ctl.synthesisReport.diagnostics = { ...ctl.synthesisReport.diagnostics, homogeneityFlag: true };
    expect((await claims(ctl, FIVE.map(ok), ["ui.synthesisView"])).texts["ui.synthesisView"]).toContain("Unusually uniform agreement");
  });
});
