/**
 * Consensus Integrity — R9 correction (real pipeline, Gemini mocked by system prompt).
 *
 * R9-1  quoteClaim showed a run of spaces or tabs inside a model-written claim as written. react-pdf cannot break
 *       inside such a run, so it wraps after it and the words that follow start a new line — a model claim could put
 *       "Panel result: consensus: all 5 dispatched models support it" on its own line, in body style, directly above
 *       the real computed result. A quoted claim is now one run of words (textSerialization.singleLineText).
 * R9-2  the bias caveat on a card from the bias check had its line breaks shown as spaces (R8-1) but kept runs of
 *       whitespace — the same forgery without a line break. It is one run of words too.
 * Boundary  ordinary words can still wrap so that a phrase starts a line. In the PDF, model-written text (the quoted
 *       claim, the bias caveat) is therefore its own inline run — oblique, on a tinted band — and every application
 *       label is bold: a line model text wraps onto lies inside the band and never starts with a computed line's label.
 *
 * Expectations are written out here (code points listed explicitly), never derived with the helper under test. The
 * real renderer (react-pdf → pdfjs fonts and pixels, rasterized) was checked in the R9 correction evidence; these
 * tests pin the text and the run structure every renderer receives.
 */

jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
jest.mock("@react-pdf/renderer", () => ({
  Document: "DOCUMENT",
  Page: "PAGE",
  View: "VIEW",
  Text: "TEXT",
  StyleSheet: { create: (styles: unknown) => styles },
  renderToBuffer: jest.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JSZip from "jszip";
import { callGemini } from "@/lib/connectors/gemini";
import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { MODEL_CAVEAT_LABEL, presentVerdictCaveat, presentVerdictClaim, quoteClaim, renderRowStatus, rowAgreementFacts } from "@/lib/adaptiveSchema/agreementNarrative";
import { singleLineText } from "@/lib/adaptiveSchema/textSerialization";
import { computeContestedDimensions } from "@/lib/adaptiveSchema/consensusIntegrity";
import { PanelVerdictCard } from "@/components/adaptive/AdaptiveSynthesisReportView";
import PrimarySynthesisStrip from "@/components/adaptive/PrimarySynthesisStrip";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { COLORS, pdfStyles } from "@/lib/pdf/theme";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
import { AdaptiveSynthesisReport, AlignedClaim } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";

const g = callGemini as jest.MockedFunction<typeof callGemini>;
const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const ok = (o: unknown) => ({ modelId: "gemini", status: "ok", latencyMs: 1, rawText: JSON.stringify(o) }) as any;
const off = { modelId: "gemini", status: "error", rawText: null, errorMessage: "off", latencyMs: 1 } as any;
const results = (): ModelResult[] => M.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "{}", latencyMs: 1 }));
function row(claimText: string, status: string, st: (string | null)[]): AlignedClaim {
  const r: AlignedClaim = {
    id: `${status}-row`,
    claimText,
    cells: M.map((m, i) =>
      st[i] ? { modelId: m as ModelId, stance: st[i], rawStance: "asserts", confidence: "settled", excerpt: `${m} excerpt`, origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } } : null
    ) as any,
    agreementScore: status === "split" ? 0.3 : 0.95,
    certaintyScore: status === "split" ? 0.3 : 0.9,
    status: status as any,
  };
  const contested = computeContestedDimensions(r);
  return contested ? { ...r, contested } : r;
}
const MAJ_ST = ["agrees", "agrees", "agrees", "agrees", "disputes"];
const SPLIT_ST = ["agrees", "agrees", "disputes", "disputes", "disputes"];
const statusOf = (r: AlignedClaim) => renderRowStatus(rowAgreementFacts(r, M.length));

async function build(top: string, split: string, caveat: string): Promise<AdaptiveSynthesisReport> {
  g.mockImplementation(async (_q: any, _c: any, _k: any, opts: any) =>
    String(opts?.systemPromptOverride ?? "").includes("shared biases")
      ? ok({ biasAndBlindSpots: [{ biasType: "Regional framing", description: caveat, modelsImplicated: ["chatgpt", "claude"], evidence: [{ modelId: "chatgpt", excerpt: "US data", rationale: "r" }], likelyCauses: [], impact: "i", mitigationSteps: [] }] })
      : off
  );
  return buildAdaptiveSynthesisReport("Q?", "generic", [row(top, "majority", MAJ_ST), row(split, "split", SPLIT_ST)], results());
}
function recordOf(report: AdaptiveSynthesisReport) {
  const record = JSON.parse(JSON.stringify(pdfLayoutFixtures().find((x) => (x.record as any).reportSnapshot?.legacy?.synthesisReport?.verdictCard)!.record));
  record.reportSnapshot.legacy.synthesisReport = report;
  return record;
}
/** A record as persisted before this PR: none of the fields the new presentation reads. */
function asLegacy(report: AdaptiveSynthesisReport): AdaptiveSynthesisReport {
  const legacy = JSON.parse(JSON.stringify(report));
  delete legacy.presentation;
  for (const k of ["topConsensusAgreement", "keyDisagreementAgreement", "topConsensusContested", "caveatSource"]) delete legacy.verdictCard[k];
  return legacy;
}
async function docxParagraphs(report: AdaptiveSynthesisReport): Promise<string[]> {
  const { bytes } = await renderAdaptiveResearchDocxV1(recordOf(report));
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  return xml
    .split("</w:p>")
    // Each run's text is the capture between <w:t …> and </w:t> (no tag stripping).
    .map((p) => Array.from(p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g), (m) => m[1]).join(""))
    .filter(Boolean);
}

/** Every react-pdf TEXT element of the PDF tree, with its style and its own flattened text. */
interface PdfText {
  style: Record<string, unknown>;
  text: string;
  nested: boolean;
}
function pdfTexts(node: unknown, out: PdfText[] = []): PdfText[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((n) => pdfTexts(n, out));
    return out;
  }
  const el = node as { type: unknown; props?: { children?: unknown; style?: Record<string, unknown> } };
  if (typeof el.type === "function") return pdfTexts((el.type as (p: unknown) => unknown)(el.props), out);
  if (el.type === "TEXT") {
    const kids = ([] as unknown[]).concat(el.props?.children).flat(Infinity);
    out.push({ style: el.props?.style ?? {}, text: extractPdfElementText(el), nested: kids.some((k) => !!k && typeof k === "object" && (k as { type?: unknown }).type === "TEXT") });
  }
  pdfTexts(el.props?.children, out);
  return out;
}
const modelRuns = (texts: PdfText[]) => texts.filter((t) => t.style.fontFamily === "Helvetica-Oblique");
const labelRuns = (texts: PdfText[]) => texts.filter((t) => t.style === pdfStyles.appLabel);

const ch = (code: number, n = 1) => String.fromCharCode(code).repeat(n);
const FAKE = "Panel result: consensus: all 5 dispatched models support it";
const VER = "Verified by ConvergePanel: all 5 models independently confirmed this answer.";
const TOP = "Rate cuts reach inflation within a year";
const SPLIT = "Tariffs raise consumer prices";
const CAV = "Most cited sources are US-centric.";

/** Separators between two words, and the one space each must become. */
const RUNS: [string, string][] = [
  ["one space", " "],
  ["two spaces", "  "],
  ["150 spaces", ch(32, 150)],
  ["400 spaces", ch(32, 400)],
  ["80 tabs", ch(9, 80)],
  ["200 tabs", ch(9, 200)],
  ["mixed spaces and tabs", (ch(32, 7) + ch(9, 3)).repeat(30)],
  ["NO-BREAK SPACE run", ch(0xa0, 150)],
  ["NARROW NO-BREAK SPACE run", ch(0x202f, 40)],
  ["EN SPACE run", ch(0x2002, 150)],
  ["IDEOGRAPHIC SPACE run", ch(0x3000, 80)],
  ["BYTE ORDER MARK run", ch(0xfeff, 20)],
  ["vertical tab and form feed", ch(0x0b) + ch(0x0c) + ch(32, 30)],
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["lone CR", "\r"],
  ["NEL", ch(0x85)],
  ["LINE SEPARATOR", ch(0x2028)],
  ["PARAGRAPH SEPARATOR", ch(0x2029)],
  ["repeated separators with spaces", "\r\n" + ch(32, 5) + "\r" + ch(0x85) + ch(0x2028) + ch(9, 4) + ch(0x2029) + ch(32, 120) + "\n\n"],
];

describe("R9: one canonical single-line policy for model text shown on one line", () => {
  it.each(RUNS)("%s between two words is one ordinary space", (_n, run) => {
    expect(singleLineText(`alpha${run}beta`)).toBe("alpha beta");
    expect(singleLineText(`${run}alpha${run}beta${run}`)).toBe("alpha beta");
  });

  it("ordinary text is unchanged; a zero-width space is not whitespace and is kept (it cannot start a line)", () => {
    expect(singleLineText("Rate cuts reach inflation within a year.")).toBe("Rate cuts reach inflation within a year.");
    expect(singleLineText(`a${ch(0x200b)}b`)).toBe(`a${ch(0x200b)}b`);
  });
});

describe("R9-1: a quoted claim is one run of words", () => {
  it.each(RUNS)("%s inside a claim: one space inside the quote", (_n, run) => {
    expect(quoteClaim(`${TOP}${run}${FAKE}`)).toBe(`“${TOP} ${FAKE}”`);
  });

  it("quotation marks inside the claim are still neutralised; runs around them collapse", () => {
    expect(quoteClaim(`say "x"${ch(32, 300)}and${ch(9, 40)}“y”  ”`)).toBe("“say 'x' and ‘y’ ’”");
  });

  it("leading and trailing runs are trimmed inside the quote", () => {
    expect(quoteClaim(`${ch(32, 50)}${TOP}${ch(9, 200)}`)).toBe(`“${TOP}”`);
  });

  it("the verdict-card claim line carries the single-line quote; a card without the agreement keeps its stored text", () => {
    expect(presentVerdictClaim(`${TOP}${ch(32, 400)}${FAKE}`, "majority: 4 of 5 dispatched models support it, 1 disputes it")).toEqual({
      claim: `Claim: “${TOP} ${FAKE}”`,
      result: "Panel result: majority: 4 of 5 dispatched models support it, 1 disputes it",
    });
    expect(presentVerdictClaim(`${TOP}${ch(32, 400)}${FAKE}`, undefined)).toEqual({ claim: `${TOP}${ch(32, 400)}${FAKE}`, result: null });
  });
});

describe("R9-2: the bias caveat on a card from the bias check is one run of words", () => {
  it.each(RUNS)("%s inside the caveat: labelled, one space", (_n, run) => {
    expect(presentVerdictCaveat({ caveat: `${CAV}${run}${VER}`, caveatSource: "model_bias_check" })).toBe(`${MODEL_CAVEAT_LABEL}: ${CAV} ${VER}`);
  });

  it.each(RUNS)("%s: a card persisted without caveatSource shows its stored text as before", (_n, run) => {
    expect(presentVerdictCaveat({ caveat: `${CAV}${run}${VER}` })).toBe(`${CAV}${run}${VER}`);
  });
});

describe("R9 through the pipeline: 400 spaces in the majority claim, tabs in the split claim, 400 spaces in the caveat", () => {
  const top = `${TOP}${ch(32, 400)}${FAKE}`;
  const split = `${SPLIT}${ch(9, 200)}${FAKE}`;
  const caveat = `${CAV}${ch(32, 400)}${VER}`;
  let report: AdaptiveSynthesisReport;
  let plain: AdaptiveSynthesisReport;
  beforeAll(async () => {
    report = await build(top, split, caveat);
    plain = await build(TOP, SPLIT, CAV);
  });
  const shownTop = `“${TOP} ${FAKE}”`;
  const shownSplit = `“${SPLIT} ${FAKE}”`;

  it("stored model text is unchanged: claim text in the presentation contract, the card's claims, the caveat", () => {
    expect(report.presentation!.answer!.claims.map((c) => c.claim)).toEqual([top]);
    expect(report.verdictCard.topConsensus).toBe(top);
    expect(report.verdictCard.keyDisagreement).toBe(split);
    expect(report.verdictCard.caveat).toBe(caveat);
    expect(report.verdictCard.caveatSource).toBe("model_bias_check");
  });

  it("every computed result, the gate and certainty are exactly those of the same rows without the runs", () => {
    expect(report.verdictCard.topConsensusAgreement).toBe(statusOf(row(top, "majority", MAJ_ST)));
    expect(report.verdictCard.topConsensusAgreement).toBe(plain.verdictCard.topConsensusAgreement);
    expect(report.verdictCard.keyDisagreementAgreement).toBe(plain.verdictCard.keyDisagreementAgreement);
    expect(report.gate).toBe(plain.gate);
    expect(report.runCertainty).toBe(plain.runCertainty);
    expect(report.presentation!.answer!.claims.map((c) => c.result)).toEqual(plain.presentation!.answer!.claims.map((c) => c.result));
  });

  it("derived strings built with quoteClaim carry the single-line quote (new-record derived text): unifiedAnswer, panelVerdict, whereModelsAgree", () => {
    expect(report.unifiedAnswer).toContain(shownTop);
    expect(report.panelVerdict).toContain(shownTop);
    expect(report.whereModelsAgree.join("\n")).toContain(shownTop);
    for (const s of [report.unifiedAnswer, report.panelVerdict, ...report.whereModelsAgree]) expect(s).not.toMatch(/[ \t]{2,}/);
  });

  it("view verdict card and strip: the single-line claims and caveat, after their labels", () => {
    const gate = { status: report.gate, runCertainty: report.runCertainty, loadBearingClaims: [], loadBearingSplitCount: 0 } as any;
    for (const html of [renderToStaticMarkup(createElement(PanelVerdictCard, { report, gate })), renderToStaticMarkup(createElement(PrimarySynthesisStrip, { synthesisReport: report }))]) {
      expect(html).toContain(`${CAV} ${VER}`);
      expect(html).not.toMatch(/ {2,}|\t/);
    }
  });

  it("DOCX: the claim paragraphs and the caveat paragraph are single-line; computed results are their own paragraphs", async () => {
    const paras = await docxParagraphs(report);
    expect(paras).toContain(`Claim: ${shownTop}`);
    expect(paras).toContain(`Claim: ${shownSplit}`);
    expect(paras).toContain(`Panel result: ${report.verdictCard.topConsensusAgreement}`);
    expect(paras).toContain(`Panel result: ${report.verdictCard.keyDisagreementAgreement}`);
    expect(paras).toContain(`${MODEL_CAVEAT_LABEL}: ${CAV} ${VER}`);
    for (const p of paras.filter((x) => x.startsWith("Claim:") || x.startsWith(MODEL_CAVEAT_LABEL))) expect(p).not.toMatch(/ {2,}|\t/);
  });

  it("PDF: each model-written text is its own oblique run on the band, holding exactly the single-line text", () => {
    const texts = pdfTexts(AdaptiveResearchDocument({ record: recordOf(report) } as any));
    const runs = modelRuns(texts);
    // Unified answer + Agreement: the top claim twice; Disagreement: the split claim; the caveat once. Order 4 (D3):
    // this caution run's answer also discloses its load-bearing split — the split claim's second run.
    expect(report.gate).toBe("caution");
    expect(runs.map((r) => r.text).sort()).toEqual([`${CAV} ${VER}`, shownSplit, shownSplit, shownTop, shownTop].sort());
    expect(runs.filter((r) => r.text !== `${CAV} ${VER}`).every((r) => r.style === pdfStyles.modelText)).toBe(true);
    expect(runs.filter((r) => r.text === `${CAV} ${VER}`).every((r) => r.style === pdfStyles.modelCaveatText)).toBe(true);
  });

  it("PDF: the payload appears only inside model runs; every computed result is outside them, after a bold label", () => {
    const texts = pdfTexts(AdaptiveResearchDocument({ record: recordOf(report) } as any));
    const runs = modelRuns(texts);
    const all = extractPdfElementText(AdaptiveResearchDocument({ record: recordOf(report) } as any));
    const count = (s: string, x: string) => s.split(x).length - 1;
    expect(count(all, FAKE)).toBe(runs.reduce((n, r) => n + count(r.text, FAKE), 0));
    expect(count(all, VER)).toBe(runs.reduce((n, r) => n + count(r.text, VER), 0));
    for (const result of [report.verdictCard.topConsensusAgreement!, report.verdictCard.keyDisagreementAgreement!]) {
      expect(runs.some((r) => r.text.includes(result))).toBe(false);
      expect(all).toContain(`Panel result: ${result}`);
    }
    expect(labelRuns(texts).map((r) => r.text)).toEqual(expect.arrayContaining(["Claim: ", "Panel result: ", "Supported by: ", `${MODEL_CAVEAT_LABEL}: `]));
    expect(labelRuns(texts).every((r) => !r.text.includes(FAKE))).toBe(true);
  });

  it("PDF: the claim text and its computed result stay lines of one text (one paginating element, as before)", () => {
    const texts = pdfTexts(AdaptiveResearchDocument({ record: recordOf(report) } as any));
    const owners = texts.filter((t) => t.nested && t.text.includes(shownTop));
    expect(owners).toHaveLength(2);
    for (const t of owners) expect(t.text).toContain(`Claim: ${shownTop}\nPanel result: ${report.verdictCard.topConsensusAgreement}`);
  });

  it("PDF: a contested note on a new card is its own computed line after the result, with its bold label, outside the model run", () => {
    const NOTE = "all 5 models that listed this claim mark it contested";
    const contested = JSON.parse(JSON.stringify(report));
    contested.verdictCard.topConsensusContested = NOTE;
    const texts = pdfTexts(AdaptiveResearchDocument({ record: recordOf(contested) } as any));
    const owner = texts.find((t) => t.nested && t.text.startsWith(`Claim: ${shownTop}\nPanel result:`) && !t.text.includes("Supported by"))!;
    expect(owner.text).toBe(`Claim: ${shownTop}\nPanel result: ${report.verdictCard.topConsensusAgreement}\nContested: ${NOTE}`);
    expect(labelRuns(texts).map((r) => r.text)).toContain("Contested: ");
    expect(modelRuns(texts).some((r) => r.text.includes(NOTE))).toBe(false);
    const without = pdfTexts(AdaptiveResearchDocument({ record: recordOf(report) } as any));
    expect(without.some((t) => t.text.includes("Contested:"))).toBe(false);
  });

  it("PDF Unified answer: each claim's lines are one group, separated from the next claim by a blank line", () => {
    const two = JSON.parse(JSON.stringify(report));
    const first = two.presentation.answer.claims[0];
    two.presentation.answer.claims.push({ ...first, claim: SPLIT });
    const texts = pdfTexts(AdaptiveResearchDocument({ record: recordOf(two) } as any));
    const owner = texts.find((t) => t.nested && t.text.includes("Supported by:"))!;
    const group = (claim: string) => [`Claim: ${claim}`, `Panel result: ${first.result}`, ...(first.contested ? [`Contested: ${first.contested}`] : []), `Supported by: ${first.supporters}`].join("\n");
    expect(owner.text).toContain(`${group(shownTop)}\n\n${group(`“${SPLIT}”`)}`);
  });

  it("legacy record (persisted before this PR): no model runs, no label runs, stored text exactly as written", async () => {
    const legacy = asLegacy(report);
    const texts = pdfTexts(AdaptiveResearchDocument({ record: recordOf(legacy) } as any));
    expect(modelRuns(texts)).toHaveLength(0);
    expect(labelRuns(texts)).toHaveLength(0);
    expect(texts.some((t) => t.nested && t.style.fontFamily === undefined && /Claim:/.test(t.text))).toBe(false);
    const all = extractPdfElementText(AdaptiveResearchDocument({ record: recordOf(legacy) } as any));
    expect(all).toContain(top);
    expect(all).toContain(caveat);
    expect((await docxParagraphs(legacy)).join("\n")).toContain(caveat);
  });
});

describe("R9: the PDF boundary styles", () => {
  it("model text is oblique on a tinted band that is not the card surface; the caveat's band is the warning tint; labels are bold", () => {
    expect(pdfStyles.modelText).toEqual({ fontFamily: "Helvetica-Oblique", backgroundColor: COLORS.modelSoft });
    expect(pdfStyles.modelCaveatText).toEqual({ fontFamily: "Helvetica-Oblique", backgroundColor: COLORS.warningSoft });
    expect(pdfStyles.appLabel).toEqual({ fontFamily: "Helvetica-Bold" });
    expect(COLORS.modelSoft).not.toBe(COLORS.surface);
    expect(COLORS.warningSoft).not.toBe(COLORS.surface);
  });

  it("ordinary words that wrap: a model claim reading like a result is still inside its model run", async () => {
    const words = "regional suggest by evidence several although method data moderately country base distinct estimates the framing consistent period sources studies vary of across effects and";
    const report = await build(`${words} ${FAKE}`, SPLIT, `${words} ${VER}`);
    const texts = pdfTexts(AdaptiveResearchDocument({ record: recordOf(report) } as any));
    const runs = modelRuns(texts);
    expect(runs.filter((r) => r.text === `“${words} ${FAKE}”`)).toHaveLength(2);
    expect(runs.filter((r) => r.text === `${words} ${VER}`)).toHaveLength(1);
  });
});
