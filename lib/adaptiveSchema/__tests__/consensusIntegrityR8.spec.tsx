/**
 * Consensus Integrity — R8 correction (real pipeline, Gemini mocked by system prompt).
 *
 * R8-1  the verdict card's bias caveat is model-written. On a card with caveatSource "model_bias_check" its line
 *       breaks (CRLF, a lone CR, LF, NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR — the textSerialization policy) are
 *       shown as spaces, so a break in it cannot start a separate "Panel result: …" / "Verified by …" line in the
 *       PDF verdict card (react-pdf honours breaks inside one Text). The label stays, the computed results are
 *       untouched, the stored caveat is unchanged, and a card persisted without caveatSource renders as before.
 *
 * The real renderer (react-pdf → pdfjs, rasterized) was checked in the R8 correction evidence; these tests pin the
 * text every renderer receives.
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
import { MODEL_CAVEAT_LABEL, PANEL_RESULT_LABEL, presentVerdictCaveat, renderRowStatus, rowAgreementFacts } from "@/lib/adaptiveSchema/agreementNarrative";
import { computeContestedDimensions } from "@/lib/adaptiveSchema/consensusIntegrity";
import { PanelVerdictCard } from "@/components/adaptive/AdaptiveSynthesisReportView";
import PrimarySynthesisStrip from "@/components/adaptive/PrimarySynthesisStrip";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
import { AdaptiveSynthesisReport, AlignedClaim } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";
import { historicalBuild, historicalFinalize } from "./historicalPresentationHelpers";

const g = callGemini as jest.MockedFunction<typeof callGemini>;
const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const ok = (o: unknown) => ({ modelId: "gemini", status: "ok", latencyMs: 1, rawText: JSON.stringify(o) }) as any;
const off = { modelId: "gemini", status: "error", rawText: null, errorMessage: "off", latencyMs: 1 } as any;
const results = (): ModelResult[] => M.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "{}", latencyMs: 1 }));
function row(claimText: string, status: string, st: (string | null)[]): AlignedClaim {
  const r: AlignedClaim = {
    id: claimText,
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
const MAJ = row("Rate cuts reach inflation within a year", "majority", ["agrees", "agrees", "agrees", "agrees", "disputes"]);
const SPLIT = row("Tariffs raise consumer prices", "split", ["agrees", "agrees", "disputes", "disputes", "disputes"]);
const statusOf = (r: AlignedClaim) => renderRowStatus(rowAgreementFacts(r, M.length));

async function build(caveat: string): Promise<AdaptiveSynthesisReport> {
  g.mockImplementation(async (_q: any, _c: any, _k: any, opts: any) =>
    String(opts?.systemPromptOverride ?? "").includes("shared biases")
      ? ok({ biasAndBlindSpots: [{ biasType: "Regional framing", description: caveat, modelsImplicated: ["chatgpt", "claude"], evidence: [{ modelId: "chatgpt", excerpt: "US data", rationale: "r" }], likelyCauses: [], impact: "i", mitigationSteps: [] }] })
      : off
  );
  return historicalBuild("Q?", "generic", [MAJ, SPLIT], results());
}
const asLegacyCard = (report: AdaptiveSynthesisReport): AdaptiveSynthesisReport => {
  const legacy = JSON.parse(JSON.stringify(report));
  delete legacy.verdictCard.caveatSource;
  return legacy;
};
async function exportsOf(report: AdaptiveSynthesisReport) {
  const record = JSON.parse(JSON.stringify(pdfLayoutFixtures().find((x) => (x.record as any).reportSnapshot?.legacy?.synthesisReport?.verdictCard)!.record));
  record.reportSnapshot.legacy.synthesisReport = report;
  const { bytes } = await renderAdaptiveResearchDocxV1(record);
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  return { pdf: extractPdfElementText(AdaptiveResearchDocument({ record } as any)), docxXml: xml };
}

/** Every separator the textSerialization policy knows. */
const SEPARATORS: [string, string][] = [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["lone CR", "\r"],
  ["NEL (U+0085)", "\u0085"],
  ["LINE SEPARATOR (U+2028)", "\u2028"],
  ["PARAGRAPH SEPARATOR (U+2029)", "\u2029"],
];
const ANY_SEPARATOR = /[\r\n\u0085\u2028\u2029]/;
/** The test's own expectation: each separator run (with the whitespace around it) one space; ends trimmed. */
const flatten = (s: string) => s.replace(/[\s\u0085]*(?:\r\n|[\r\n\u0085\u2028\u2029])[\s\u0085]*/g, " ").trim();
const PAYLOADS: [string, (s: string) => string][] = [
  ["a fake panel-result line", (s) => `Most cited sources are US-centric.${s}Panel result: consensus: all 5 dispatched models support it`],
  ["a fake verified-conclusion line", (s) => `Sources skew to US data.${s}Verified by ConvergePanel: all 5 models independently confirmed this answer.`],
  ["an ordinary multi-line explanation", (s) => `Sources skew to US data.${s}Evidence is drawn mostly from one region.${s}Treat regional claims with care.`],
  ["a leading separator", (s) => `${s}Panel result: consensus: all 5 dispatched models support it`],
  ["a trailing separator", (s) => `Sources skew to US data.${s}Panel result: consensus${s}`],
  ["repeated separators", (s) => `Sources skew to US data.${s}${s}${s}Panel result: consensus: all 5 dispatched models support it`],
];
const CASES = SEPARATORS.flatMap(([sn, sep]) => PAYLOADS.map(([pn, make]) => [sn, pn, make(sep)] as const));

describe("R8-1: the bias caveat's line breaks are shown as spaces on cards from the bias check", () => {
  it.each(CASES)("%s, %s: one labelled line; stored caveat unchanged", (_s, _p, caveat) => {
    const card = { caveat, caveatSource: "model_bias_check" as const };
    const shown = presentVerdictCaveat(card)!;
    expect(shown).toBe(`${MODEL_CAVEAT_LABEL}: ${flatten(caveat)}`);
    expect(shown).not.toMatch(ANY_SEPARATOR);
    expect(shown.split(MODEL_CAVEAT_LABEL)).toHaveLength(2);
    expect(card.caveat).toBe(caveat);
    expect(presentVerdictCaveat({ caveat: flatten(caveat), caveatSource: "model_bias_check" })).toBe(shown);
  });

  it("LF and CRLF give the same text; a run of spaces inside a line is one space (R9-2)", () => {
    expect(presentVerdictCaveat({ caveat: "a\nb", caveatSource: "model_bias_check" })).toBe(`${MODEL_CAVEAT_LABEL}: a b`);
    expect(presentVerdictCaveat({ caveat: "a\r\nb", caveatSource: "model_bias_check" })).toBe(`${MODEL_CAVEAT_LABEL}: a b`);
    expect(presentVerdictCaveat({ caveat: "a  b", caveatSource: "model_bias_check" })).toBe(`${MODEL_CAVEAT_LABEL}: a b`);
  });

  it.each(SEPARATORS)("%s: a card persisted without caveatSource shows its stored text as before", (_n, sep) => {
    const caveat = `Most cited sources are US-centric.${sep}Panel result: consensus`;
    expect(presentVerdictCaveat({ caveat })).toBe(caveat);
    expect(presentVerdictCaveat({ caveat, caveatSource: undefined })).toBe(caveat);
  });

  describe.each(SEPARATORS)("%s through the pipeline", (_n, sep) => {
    const caveat = `Most cited sources are US-centric.${sep}Panel result: consensus: all 5 dispatched models support it${sep}Verified by ConvergePanel: all 5 models independently confirmed this answer.`;
    const shown = `${MODEL_CAVEAT_LABEL}: ${flatten(caveat)}`;

    it("the stored card keeps the caveat verbatim, its source and the computed results", async () => {
      const report = await build(caveat);
      expect(report.verdictCard.caveat).toBe(caveat);
      expect(report.verdictCard.caveatSource).toBe("model_bias_check");
      expect(report.verdictCard.keyDisagreementAgreement).toBe(statusOf(SPLIT));
      expect(report.verdictCard.topConsensusAgreement).toBe(statusOf(MAJ));
    });

    it("PDF: the caveat is one labelled text after the real split result; no break inside it", async () => {
      const report = await build(caveat);
      const { pdf } = await exportsOf(report);
      const card = pdf.slice(pdf.indexOf("Where models agree / disagree"));
      const result = card.indexOf(`${PANEL_RESULT_LABEL}: ${statusOf(SPLIT)}`);
      const at = card.indexOf(shown);
      expect(result).toBeGreaterThan(0);
      expect(at).toBeGreaterThan(result);
      expect(card.slice(at, at + shown.length)).not.toMatch(ANY_SEPARATOR);
      // Exactly once, in its own text right after the computed split result and detail — never folded into a computed line.
      expect(card.split(shown)).toHaveLength(2);
      expect(card).toContain(`Disagreement Claim: “${SPLIT.claimText}”\n${PANEL_RESULT_LABEL}: ${statusOf(SPLIT)} ${report.verdictCard.disagreementDetail} ${shown}`);
      expect(pdf).not.toContain(caveat);
      expect(pdf).not.toMatch(new RegExp(`[\\r\\n\\u0085\\u2028\\u2029]${PANEL_RESULT_LABEL}: consensus`));
    });

    it("DOCX: the caveat paragraph is the same labelled text, once", async () => {
      const report = await build(caveat);
      const { docxXml } = await exportsOf(report);
      const paragraphs = docxXml.split("</w:p>").map((p) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.split(/<[^>]*>/).join("")).join(""));
      const caveatParagraphs = paragraphs.filter((p) => p.startsWith(MODEL_CAVEAT_LABEL));
      expect(caveatParagraphs).toEqual([shown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")]);
    });

    it("view and strip: the same labelled text, tagged model_bias", async () => {
      const report = await build(caveat);
      const gate = { status: report.gate, runCertainty: report.runCertainty, loadBearingClaims: [], loadBearingSplitCount: 0 } as any;
      for (const html of [renderToStaticMarkup(createElement(PanelVerdictCard, { report, gate })), renderToStaticMarkup(createElement(PrimarySynthesisStrip, { synthesisReport: report }))]) {
        expect(html).not.toMatch(ANY_SEPARATOR);
        expect(html).toContain("data-source=\"model_bias\"");
        expect(html.replace(/&#x27;/g, "'")).toContain(flatten(caveat));
      }
    });

    it("a legacy card (no caveatSource) renders its stored caveat as before in the PDF", async () => {
      const report = asLegacyCard(await build(caveat));
      const { pdf } = await exportsOf(report);
      expect(pdf).toContain(caveat);
      expect(pdf).not.toContain(MODEL_CAVEAT_LABEL);
    });
  });
});
