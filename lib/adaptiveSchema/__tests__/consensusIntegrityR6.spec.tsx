/**
 * Consensus Integrity — R6 corrections, end to end (real pipeline, Gemini mocked by system prompt).
 *
 * R6-1  the Unified Answer and the executive-summary fallback: each claim with its own computed result; the
 *       fallback summary is computed text only; DOCX/PDF no longer call the mixed text "Panel conclusion".
 * R6-2  Markdown and memo: model prose is quoted under its label and can never become a report heading.
 * R6-3  Markdown: model-written text is escaped at every interpolation, once.
 * R6-4..R6-6  load-bearing claims / single-model insights labelled, bias section labelled, "Panel result:"
 *       copied by a model stays inside the model's block.
 * Reports without the new optional fields render exactly as before.
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
import { buildAdaptiveMemoInput, buildAdaptiveSynthesisMarkdown } from "@/lib/adaptiveSchema/shareBuilders";
import { MODEL_EXPLANATION_LABEL, presentExecutiveSummary, presentUnifiedAnswer } from "@/lib/adaptiveSchema/reportPresentation";
import { escapeMarkdownInline, markdownQuote, plainTextQuote } from "@/lib/adaptiveSchema/textSerialization";
import { MODEL_CAVEAT_LABEL, quoteClaim, renderRowStatus, rowAgreementFacts } from "@/lib/adaptiveSchema/agreementNarrative";
import { computeContestedDimensions } from "@/lib/adaptiveSchema/consensusIntegrity";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import AdaptiveSynthesisReportView, { SingleModelInsightsList, UnifiedAnswerCard } from "@/components/adaptive/AdaptiveSynthesisReportView";
import PrimarySynthesisStrip from "@/components/adaptive/PrimarySynthesisStrip";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
import { AdaptiveSynthesisReport, AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";

const g = callGemini as jest.MockedFunction<typeof callGemini>;
const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const ok = (o: unknown) => ({ modelId: "gemini", status: "ok", latencyMs: 1, rawText: JSON.stringify(o) }) as any;
const off = { modelId: "gemini", status: "error", rawText: null, errorMessage: "off", latencyMs: 1 } as any;
const results = (): ModelResult[] => M.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "{}", latencyMs: 1 }));
type St = AlignedClaimCell["stance"] | null;

function row(claimText: string, status: string, st: St[], opts: { contested?: boolean; score?: number } = {}): AlignedClaim {
  const r: AlignedClaim = {
    id: claimText,
    claimText,
    cells: M.map((m, i) =>
      st[i]
        ? { modelId: m as ModelId, stance: st[i]!, rawStance: "asserts", confidence: opts.contested ? "contested" : "settled", excerpt: `${m} excerpt`, origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } }
        : null
    ) as any,
    agreementScore: opts.score ?? (status === "split" ? 0.3 : 0.95),
    certaintyScore: opts.score ?? (status === "split" ? 0.3 : 0.9),
    status: status as any,
  };
  const contested = computeContestedDimensions(r);
  return contested ? { ...r, contested } : r;
}
const ALL5: St[] = ["agrees", "agrees", "agrees", "agrees", "agrees"];
const MAJ45: St[] = ["agrees", "agrees", "agrees", "agrees", "disputes"];
const SPLIT23: St[] = ["agrees", "agrees", "disputes", "disputes", "disputes"];
const UNAN = "All five models unanimously agree rate cuts reach inflation within a year";

function mockCalls(narrative: Record<string, unknown> | null, bias: unknown[] | null = null) {
  g.mockImplementation(async (_q: any, _c: any, _k: any, opts: any) => {
    const sp = String(opts?.systemPromptOverride ?? "");
    if (narrative && sp.includes("narrative portion")) {
      return ok({ executiveSummary: "", whyModelsDisagree: [], disagreementStakes: [], certaintyAssessment: "", narrativeSections: [], ...narrative });
    }
    if (bias && sp.includes("shared biases")) return ok({ biasAndBlindSpots: bias });
    return off;
  });
}
async function build(rows: AlignedClaim[], narrative: Record<string, unknown> | null, bias: unknown[] | null = null) {
  mockCalls(narrative, bias);
  return buildAdaptiveSynthesisReport("Q?", "generic", rows, results());
}
const statusOf = (r: AlignedClaim) => renderRowStatus(rowAgreementFacts(r, M.length));
const unent = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Rendered text grouped by the nearest enclosing data-source ("unattributed" outside any). */
function bySource(html: string): { source: string; text: string }[] {
  const outList: { source: string; text: string }[] = [];
  const stack: string[] = [];
  const re = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[4]) {
      const t = unent(m[4]).trim();
      if (t) outList.push({ source: [...stack].reverse().find((s) => s !== "") ?? "unattributed", text: t });
    } else if (m[1]) stack.pop();
    else if (!/\/$/.test(m[3])) stack.push(/data-source="([^"]+)"/.exec(m[3])?.[1] ?? "");
  }
  return outList;
}
const view = (report: AdaptiveSynthesisReport, rows: AlignedClaim[], loadBearing: AlignedClaim[] = []) =>
  renderToStaticMarkup(
    createElement(AdaptiveSynthesisReportView, {
      report,
      gate: { status: report.gate, runCertainty: report.runCertainty, loadBearingClaims: loadBearing, loadBearingSplitCount: 0 } as any,
      alignedClaims: rows,
      question: "Q?",
      modelsUsed: M as ModelId[],
    })
  );
/** One data-section of the view, from its opening tag to the next section's opening tag. */
const section = (html: string, name: string) => {
  const attr = html.indexOf(`data-section="${name}"`);
  const at = html.lastIndexOf("<", attr);
  const next = html.indexOf('data-section="', attr + 1);
  return html.slice(at, next < 0 ? undefined : html.lastIndexOf("<", next));
};
const withoutSection = (html: string, name: string) => html.replace(section(html, name), "");
const mdSection = (md: string, heading: string) => {
  const at = md.indexOf(`\n${heading}\n`);
  if (at < 0) return "";
  const next = md.indexOf("\n## ", at + heading.length + 2);
  return md.slice(at, next < 0 ? undefined : next);
};
async function exportsOf(report: AdaptiveSynthesisReport) {
  const record = JSON.parse(JSON.stringify(pdfLayoutFixtures().find((x) => (x.record as any).reportSnapshot?.legacy?.synthesisReport?.verdictCard)!.record));
  record.reportSnapshot.legacy.synthesisReport = report;
  const { bytes } = await renderAdaptiveResearchDocxV1(record);
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  const docx = unent(xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&apos;/g, "'"));
  const pdf = extractPdfElementText(AdaptiveResearchDocument({ record } as any));
  return { docx, pdf };
}
/** A legacy copy: the report as persisted before the R5/R6 optional fields existed. */
function asLegacy(report: AdaptiveSynthesisReport): AdaptiveSynthesisReport {
  const legacy = JSON.parse(JSON.stringify(report));
  delete legacy.presentation;
  for (const k of ["topConsensusAgreement", "keyDisagreementAgreement", "caveatSource", "topConsensusContested"]) delete legacy.verdictCard[k];
  return legacy;
}

// ─── R6-1: Unified Answer claim/result and the executive-summary fallback ───

describe("R6-1: each Unified Answer claim carries its own computed result; the fallback summary carries no claim text", () => {
  const rows = () => [
    row(UNAN, "majority", MAJ45),
    row("Every model confirms the lag is one year", "consensus", ALL5),
    row("Claim S split — settled", "split", SPLIT23),
    row("Claim O single — several models agree", "single_source", ["agrees", null, null, null, null]),
    row("Claim L limited — full consensus", "limited_coverage", ["agrees", "agrees", null, null, null]),
  ];

  it.each([
    ["narrative missing", null],
    ["narrative fully filtered", { executiveSummary: "All the models agree on this. The panel is unanimous.", certaintyAssessment: "Every model agrees." }],
  ])("%s: answer = the Unified Answer's claims, each with its own row's result", async (_n, narrative) => {
    const rs = rows();
    const report = await build(rs, narrative);
    const p = report.presentation!;
    expect(p.executiveSummarySource).toBe("unified_answer");
    expect(report.executiveSummary).toBe(report.unifiedAnswer); // stored as before
    expect(p.answer.note).toBeNull();
    // Same claims, same order as the stored string; each result is that claim's own row status — never another's.
    const order = p.answer.claims.map((c) => report.unifiedAnswer.indexOf(quoteClaim(c.claim)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(p.answer.claims.map((c) => c.claim).sort()).toEqual([UNAN, "Every model confirms the lag is one year"].sort());
    for (const c of p.answer.claims) expect(c.result).toBe(statusOf(rs.find((r) => r.claimText === c.claim)!));
    expect(p.answer.claims.find((c) => c.claim === UNAN)!.supporters).toBe("ChatGPT, Claude, Grok, Perplexity");

    // Executive summary: computed blocks only, and none of them holds claim text.
    const summary = presentExecutiveSummary(report);
    expect(summary.map((b) => b.source)).toEqual(["computed"]);
    for (const r of rs) for (const b of summary) expect(b.text).not.toContain(r.claimText);
  });

  it("view, strip, Markdown and memo: no claim inside a computed summary block; the Unified Answer pairs each claim with its result", async () => {
    const rs = rows();
    const report = await build(rs, null);
    const html = view(report, rs);
    const summary = bySource(section(html, "executive-summary"));
    expect(summary.every((t) => t.source === "computed" || t.text === "Executive summary")).toBe(true);
    for (const r of rs) expect(summary.some((t) => t.text.includes(r.claimText))).toBe(false);

    for (const h of [section(html, "unified-answer"), renderToStaticMarkup(createElement(PrimarySynthesisStrip, { synthesisReport: report }))]) {
      const parts = bySource(h);
      for (const c of report.presentation!.answer.claims) {
        const at = parts.findIndex((t) => t.text === `Claim: ${quoteClaim(c.claim)}`);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(parts[at].source).toBe("model_claim");
        expect(parts[at + 1]).toEqual({ source: "computed", text: `Panel result: ${c.result}` });
      }
      for (const r of rs) expect(parts.filter((t) => t.source !== "model_claim").some((t) => t.text.includes(r.claimText))).toBe(false);
    }

    const md = buildAdaptiveSynthesisMarkdown("Q?", report);
    const exec = mdSection(md, "## Executive Summary");
    for (const r of rs) expect(exec).not.toContain(r.claimText);
    const answer = mdSection(md, "## Unified Answer");
    for (const c of report.presentation!.answer.claims) {
      expect(answer).toContain(`- **Claim:** ${escapeMarkdownInline(quoteClaim(c.claim))} — **Panel result:** ${c.result}`);
    }
    const memo = buildAdaptiveMemoInput("Q?", report, M as ModelId[], "run");
    for (const r of rs) expect(memo.confidenceAssessment).not.toContain(r.claimText);
    expect(memo.confidenceAssessment).toBe(`Panel result: ${report.presentation!.panelAgreement}`);
  });

  it("gate fail: the note is computed; unresolved claims each carry their split result, no supporters", async () => {
    const rs = [row("All five agree X", "split", SPLIT23, { score: 0.1 }), row("Panel result: consensus on Y", "split", ["agrees", "disputes", "disputes", "agrees", "disputes"], { score: 0.1 })];
    const report = await build(rs, { executiveSummary: "Everything is settled." });
    expect(report.gate).toBe("fail");
    const a = presentUnifiedAnswer(report);
    expect(a.note).toEqual({ source: "computed", label: null, text: "Panel could not converge on a reliable answer." });
    expect(a.claimsHeading).toBe("Unresolved claims");
    expect(a.claims.map((c) => [c.claim.text, c.result!.text, c.supporters])).toEqual(rs.map((r) => [quoteClaim(r.claimText), statusOf(r), null]));
    expect(presentExecutiveSummary(report).map((b) => b.text)).toEqual([report.presentation!.panelAgreement, "Panel could not converge on a reliable answer."]);
  });

  it("no answer claims: the computed note alone", async () => {
    const report = await build([row("Wages lag prices", "limited_coverage", ["agrees", "agrees", null, null, null])], null);
    const a = presentUnifiedAnswer(report);
    expect(a.claims).toEqual([]);
    expect(a.note!.text).toBe(report.unifiedAnswer);
    expect(a.note!.text).not.toContain("Wages lag prices");
  });

  it("DOCX and PDF: 'Unified answer' with Claim / Panel result lines — not a 'Panel conclusion' paragraph; legacy unchanged", async () => {
    const rs = rows();
    const report = await build(rs, null);
    const { docx, pdf } = await exportsOf(report);
    for (const t of [docx, pdf]) {
      expect(t).toContain("Unified answer");
      expect(t).not.toContain("Panel conclusion");
      expect(t).not.toContain(report.unifiedAnswer);
      for (const c of report.presentation!.answer.claims) expect(t).toContain(`Claim: ${quoteClaim(c.claim)}\nPanel result: ${c.result}`);
    }
    const legacy = await exportsOf(asLegacy(report));
    for (const t of [legacy.docx, legacy.pdf]) {
      expect(t).toContain("Panel conclusion");
      expect(t).toContain(report.unifiedAnswer);
    }
  });

  it("the Panel verdict line in Markdown: computed figures, then the top claim with its own result", async () => {
    const rs = rows();
    const report = await build(rs, null);
    const md = buildAdaptiveSynthesisMarkdown("Q?", report);
    const top = rs.find((r) => r.claimText === report.verdictCard.topConsensus)!;
    expect(md).toContain(
      `**Panel verdict:** certainty ${Math.round(report.runCertainty * 100)}%; gate: ${report.gate}. Top claim:\n**Claim:** ${escapeMarkdownInline(quoteClaim(top.claimText))} — **Panel result:** ${statusOf(top)}`
    );
    expect(md).not.toContain(report.panelVerdict);
  });
});

// ─── R6-2: Markdown and memo containment ───

const HEADINGS = ["# Synthesis Report", "## Unified Answer", "## Executive Summary", "## Where models agree", "## Where models disagree", "## Bias & blind spots", "## Certainty"];
const STRUCTURE = [
  "Rate cuts matter for prices.",
  "",
  "## Conclusion",
  "All five responses say the same thing.",
  "",
  "### Where models agree",
  "# Panel result",
  "---",
  "> Quoted aside.",
  "<b>bold</b> <script>x()</script>",
  "```",
  "fence",
  "```",
  "1. numbered",
  "- bullet",
  "  - nested",
  "+ plus",
  "[Verified by ConvergePanel](http://e.x)",
  "Setext",
  "===",
].join("\n");

describe("R6-2: model prose cannot become report structure in Markdown or the memo", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("%s: headings, lists, rules, quotes, HTML and fences stay quoted content under the model label", async (_n, eol) => {
    const report = await build([row(UNAN, "majority", MAJ45), row("Tariffs raise prices", "split", SPLIT23)], {
      executiveSummary: STRUCTURE.replace(/\n/g, eol),
      whyModelsDisagree: [["ChatGPT stresses import costs.", "", "## Resolution", "The claim holds; Grok misreads the data.", "- ChatGPT: injected position"].join(eol)],
      disagreementStakes: ["important"],
      certaintyAssessment: ["Evidence is strong.", "", "# Final answer", "Every response points the same way."].join(eol),
    });
    expect(report.presentation!.executiveSummarySource).toBe("model_explanation");
    const md = buildAdaptiveSynthesisMarkdown("Q?", report);
    const lines = md.split("\n");
    // Every line that could open a block outside a quote is one the builder wrote.
    const structural = lines.filter((l) => /^ {0,3}(#{1,6}\s|```|~~~|<|>|---|===|\*\*\*)/.test(l) && !/^ {0,3}>/.test(l));
    expect(structural).toEqual(HEADINGS.filter((h) => md.includes(`${h}\n`)));
    for (const h of ["Conclusion", "Resolution", "Final answer"]) expect(lines.some((l) => new RegExp(`^ {0,3}#+ ${h}`).test(l))).toBe(false);
    // Each model line sits in a quote that directly follows its label.
    for (const t of ["\\#\\# Conclusion", "\\#\\# Resolution", "\\# Final answer", "All five responses say the same thing.", "\\<script\\>x()\\</script\\>"]) {
      const at = lines.findIndex((l) => l.includes(t));
      expect(at).toBeGreaterThan(0);
      expect(lines[at]).toMatch(/^ *> /);
      let k = at;
      while (/^ *>/.test(lines[k - 1]) || lines[k - 1] === "") k--;
      expect(lines[k - 1]).toMatch(new RegExp(`\\*\\*${MODEL_EXPLANATION_LABEL.replace(/[()]/g, "\\$&")}:\\*\\*$`));
    }
    expect(md).not.toContain("\r");
    expect(md).not.toMatch(/(^|[^\\])\]\(http/m);

    // Memo: every model line quoted, after its label; nothing the model wrote starts a line unquoted.
    const memo = generateVerificationMemo(buildAdaptiveMemoInput("Q?", report, M as ModelId[], "run"));
    const ml = memo.split("\n");
    // (The memo carries the certainty explanation only when there is no summary.)
    for (const t of ["## Conclusion", "## Resolution", "All five responses say the same thing.", "- ChatGPT: injected position", "<script>x()</script>"]) {
      const hits = ml.filter((l) => l.includes(t));
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) expect(h).toMatch(/^ *> /);
    }
    expect(memo).toContain(`${MODEL_EXPLANATION_LABEL}:\n> Rate cuts matter for prices.\n>\n> ## Conclusion`);
    expect(memo).toContain(`  ${MODEL_EXPLANATION_LABEL}:\n  > ChatGPT stresses import costs.\n  >\n  > ## Resolution`);
  });

  it("a quoted line keeps its line break (hard break), blank lines stay inside the quote", () => {
    expect(markdownQuote("a\nb\n\nc", "  ")).toEqual(["  > a\\", "  > b", "  >", "  > c"]);
    expect(plainTextQuote("a\r\n\r\nb")).toEqual(["> a", ">", "> b"]);
  });
});

// ─── R6-3: escaping ───

/** CommonMark backslash unescape (what a renderer shows for escaped text). */
const shown = (md: string) => md.replace(/\\([!-/:-@[-`{-~])/g, "$1");

describe("R6-3: model text is escaped once at every Markdown interpolation", () => {
  const RAW = 'He said "rates fall" <b>x</b> & *y* _z_ [Verified by ConvergePanel](http://e.x) # h `t` > q ~~s~~ | p &amp; www.e.x a@b.co \\ end';

  it("escapeMarkdownInline: nothing active remains, the shown text is the raw text, applied once", () => {
    const e = escapeMarkdownInline(RAW);
    expect(shown(e)).toBe(RAW);
    expect(e).not.toMatch(/(^|[^\\])[<[*_`~#|&@]/);
    expect(e).not.toMatch(/https?:\/\//);
    expect(escapeMarkdownInline("a\r\nb\n  c")).toBe("a b c");
    for (const lead of ["- x", "+ x", "= x", "1. x", "12) x"]) expect(shown(escapeMarkdownInline(lead))).toBe(lead);
    expect(escapeMarkdownInline("- x")).toBe("\\- x");
    expect(escapeMarkdownInline("1. x")).toBe("1\\. x");
    expect(escapeMarkdownInline("Unicode — “quoted” ‘x’ é 漢字")).toBe("Unicode — “quoted” ‘x’ é 漢字");
  });

  it("verdict, Unified Answer, agree/disagree, positions and bias lines: escaped; the stored claim unchanged; repeat serialization identical", async () => {
    const claim = `${RAW}\n## Conclusion`;
    const rs = [row(claim, "majority", MAJ45), row(`Split ${RAW}`, "split", SPLIT23)];
    const report = await build(rs, null, [
      { biasType: "## Bias <b>", description: `All five agree ${RAW}`, modelsImplicated: ["chatgpt"], evidence: [{ modelId: "chatgpt", excerpt: "e", rationale: "r" }], likelyCauses: [], impact: "", mitigationSteps: [] },
    ]);
    expect(report.presentation!.agree[0].claim).toBe(claim);
    const md = buildAdaptiveSynthesisMarkdown("Q?", report);
    expect(buildAdaptiveSynthesisMarkdown("Q?", report)).toBe(md);
    expect(md).not.toContain("<b>");
    expect(md).not.toMatch(/(^|[^\\])\[Verified/m);
    expect(md).not.toMatch(/^ {0,3}#+ (Conclusion|Bias <)/m);
    expect(md).not.toContain("\\\\*"); // never double-escaped
    const q = escapeMarkdownInline(quoteClaim(claim));
    expect(md).toContain(`**Claim:** ${q} — **Panel result:** ${statusOf(rs[0])}\n\n## Unified Answer`); // panel verdict
    expect(md).toContain(`- **Claim:** ${q} — **Panel result:** ${statusOf(rs[0])} — **Supported by:**`); // Unified Answer
    expect(md).toContain(`- **Claim:** ${q} — **Panel result:** ${statusOf(rs[0])}\n`); // where agree
    expect(md).toContain(`**${MODEL_CAVEAT_LABEL}:**\n- \\#\\# Bias \\<b\\> — All five agree ${escapeMarkdownInline(RAW)}`);
    for (const p of report.disagreements[0].positions) expect(md).toContain(`: ${escapeMarkdownInline(p.position)}`);
    expect(shown(q)).toBe(quoteClaim(claim));
  });
});

// ─── R6-4 / R6-5 / R6-6 ───

describe("R6-4..R6-6: load-bearing claims, single-model insights, bias and copied labels keep their attribution", () => {
  it("load-bearing claims: Claim quoted and labelled, then its computed status with supporters and disputers", async () => {
    const r = row(UNAN, "majority", MAJ45);
    const report = await build([r], null);
    const parts = bySource(section(view(report, [r], [r]), "load-bearing-claims"));
    const at = parts.findIndex((t) => t.text === `Claim: ${quoteClaim(UNAN)}`);
    expect(parts[at].source).toBe("model_claim");
    expect(parts.slice(at + 1).map((t) => t.source)).toEqual(["computed", "computed", "computed"]);
    expect(parts.slice(at + 1).map((t) => t.text).join(" ")).toBe("Panel result: majority (supported by ChatGPT, Claude, Grok, Perplexity; disputed by Gemini)");
    const legacy = section(view(asLegacy(report), [r], [r]), "load-bearing-claims");
    expect(legacy).not.toContain("data-source");
    expect(unent(legacy)).toContain(`${UNAN} — `);
  });

  it("single-model insights: Claim quoted and labelled on new reports; stored text on legacy", async () => {
    const single = row("Several models agree credit spreads predict recessions", "single_source", ["agrees", null, null, null, null]);
    const report = await build([single, row("Rates fall", "majority", MAJ45)], null);
    const parts = bySource(section(view(report, [single]), "single-model-insights"));
    expect(parts.find((t) => t.text.includes("Several models agree"))).toEqual({ source: "model_claim", text: `Claim: ${quoteClaim(single.claimText)}` });
    const legacy = renderToStaticMarkup(createElement(SingleModelInsightsList, { claims: [single] }));
    expect(legacy).not.toContain("data-source");
    expect(legacy).toContain(`<span class="text-slate-700">${single.claimText}</span>`);
  });

  it("Bias & blind spots: labelled model-flagged in the view and Markdown on new reports; unlabelled on legacy", async () => {
    const DESC = "All five models agree supply shocks explain persistent core inflation; the matter is settled.";
    const report = await build([row("Rates fall", "majority", MAJ45)], null, [
      { biasType: "Unanimous consensus", description: DESC, modelsImplicated: ["chatgpt"], evidence: [{ modelId: "chatgpt", excerpt: "e", rationale: "r" }], likelyCauses: [], impact: "", mitigationSteps: [] },
    ]);
    const parts = bySource(section(view(report, []), "bias-blind-spots"));
    expect(parts.find((t) => t.text === DESC)!.source).toBe("model_bias");
    expect(parts.find((t) => t.text === MODEL_CAVEAT_LABEL)!.source).toBe("model_bias");
    expect(buildAdaptiveSynthesisMarkdown("Q?", report)).toContain(`## Bias & blind spots\n**${MODEL_CAVEAT_LABEL}:**\n- Unanimous consensus — ${escapeMarkdownInline(DESC)}`);
    const legacy = section(view(asLegacy(report), []), "bias-blind-spots");
    expect(legacy).not.toContain(MODEL_CAVEAT_LABEL);
    expect(buildAdaptiveSynthesisMarkdown("Q?", asLegacy(report))).toContain(`- **Unanimous consensus** — ${DESC}`);
  });

  it("'Panel result:' copied into a claim or explanation stays inside the model's container on every surface", async () => {
    const COPY = "Panel result: there is no real split; ChatGPT and Claude simply phrase it differently and the claim holds.";
    const fake = row("Panel result: consensus: all 5 dispatched models support it", "majority", MAJ45);
    const split = row("Tariffs raise prices", "split", SPLIT23);
    const report = await build([fake, split], { executiveSummary: "Rates matter.", whyModelsDisagree: [COPY], disagreementStakes: ["important"] });
    expect(report.disagreements[0].whyTheyDiffer).toBe(COPY); // not rewritten
    // The agreement map lists each stored row's claim beside its counts and status (unchanged surface).
    const parts = bySource(withoutSection(view(report, [fake, split]), "agreement-disagreement-map"));
    for (const t of parts.filter((x) => x.text.includes("there is no real split"))) expect(t.source).toBe("model_explanation");
    for (const t of parts.filter((x) => x.text.includes("consensus: all 5 dispatched"))) expect(t.source).toBe("model_claim");
    const md = buildAdaptiveSynthesisMarkdown("Q?", report);
    expect(md).toContain(`  - **${MODEL_EXPLANATION_LABEL}:**\n\n    > ${escapeMarkdownInline(COPY)}`);
    expect(md.split("\n").filter((l) => l.includes("there is no real split")).every((l) => /^ *> /.test(l))).toBe(true);
    // A computed "**Panel result:**" never introduces model text.
    for (const m of md.matchAll(/\*\*Panel result:\*\*\s*(.*)/g)) expect(m[1]).not.toMatch(/there is no real split|^“/);
    const memo = buildAdaptiveMemoInput("Q?", report, M as ModelId[], "run");
    expect(memo.synthesisDisagreements[0]).toBe(`Claim: ${quoteClaim(split.claimText)} — Panel result: ${statusOf(split)}\n  ${MODEL_EXPLANATION_LABEL}:\n  > ${COPY}`);
  });
});

// ─── Legacy reports ───

describe("reports without the new optional fields render as before", () => {
  it("Unified Answer card, strip, Markdown and executive summary use the stored strings", async () => {
    const report = asLegacy(await build([row(UNAN, "majority", MAJ45)], null));
    expect(presentUnifiedAnswer(report)).toEqual({ note: { source: "legacy", label: null, text: report.unifiedAnswer }, claimsHeading: null, claims: [] });
    expect(renderToStaticMarkup(createElement(UnifiedAnswerCard, { answer: report.unifiedAnswer, report }))).toBe(
      renderToStaticMarkup(createElement(UnifiedAnswerCard, { answer: report.unifiedAnswer }))
    );
    const strip = renderToStaticMarkup(createElement(PrimarySynthesisStrip, { synthesisReport: report }));
    expect(strip).toContain(renderToStaticMarkup(createElement("p", { className: "text-sm leading-relaxed text-slate-900 whitespace-pre-line" }, report.unifiedAnswer)));
    expect(strip).not.toContain('data-source="model_claim">Claim: “All five models unanimously agree rate cuts reach inflation within a year”</span><span data-source="computed" class="block text-xs text-slate-600 mt-0.5">Panel result');
    const md = buildAdaptiveSynthesisMarkdown("Q?", report);
    expect(md).toContain(`**Panel verdict:** ${report.panelVerdict}\n\n## Unified Answer\n${report.unifiedAnswer}\n\n## Executive Summary\n${report.executiveSummary}\n`);
  });
});
