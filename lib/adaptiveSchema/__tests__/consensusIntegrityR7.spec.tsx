/**
 * Consensus Integrity — R7 corrections (real pipeline, Gemini mocked by system prompt).
 *
 * R7-1  one line-break policy at every text boundary: CRLF, a lone CR, LF, NEL, LINE SEPARATOR and PARAGRAPH
 *       SEPARATOR. Model text that must stay on one line (claims, positions, bias) has every break turned into a
 *       space; model prose keeps its lines, each one inside its quote. No separator can start a list item,
 *       heading, rule or a detached "Panel result" line in Markdown, the memo or a social post.
 * R7-2  GFM autolink literals are escaped wherever they occur, not only at a word boundary.
 * R7-4  pins found by mutation: unclear models are not disputers; the Unified Answer caps (4, and 5 unresolved on
 *       a gate fail); the answer note's source; the Markdown "Unresolved claims:" heading.
 *
 * The Markdown strings asserted here were also parsed with marked and micromark + GFM in the R7 correction
 * evidence; these tests pin the serialization itself.
 */

jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { callGemini } from "@/lib/connectors/gemini";
import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { buildAdaptiveLinkedInPost, buildAdaptiveMemoInput, buildAdaptiveSynthesisMarkdown, buildAdaptiveXPost } from "@/lib/adaptiveSchema/shareBuilders";
import { escapeMarkdownInline, joinLines, markdownQuote, plainTextQuote, splitLines } from "@/lib/adaptiveSchema/textSerialization";
import { MODEL_CAVEAT_LABEL, quoteClaim, renderRowStatus, rowAgreementFacts } from "@/lib/adaptiveSchema/agreementNarrative";
import { MODEL_EXPLANATION_LABEL } from "@/lib/adaptiveSchema/reportPresentation";
import { computeContestedDimensions } from "@/lib/adaptiveSchema/consensusIntegrity";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import AdaptiveSynthesisReportView from "@/components/adaptive/AdaptiveSynthesisReportView";
import PrimarySynthesisStrip from "@/components/adaptive/PrimarySynthesisStrip";
import { getModelLabel } from "@/components/adaptive/shared";
import { AdaptiveSynthesisReport, AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";

const g = callGemini as jest.MockedFunction<typeof callGemini>;
const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const ok = (o: unknown) => ({ modelId: "gemini", status: "ok", latencyMs: 1, rawText: JSON.stringify(o) }) as any;
const off = { modelId: "gemini", status: "error", rawText: null, errorMessage: "off", latencyMs: 1 } as any;
const results = (): ModelResult[] => M.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "{}", latencyMs: 1 }));
type St = AlignedClaimCell["stance"] | null;

function row(claimText: string, status: string, st: St[], opts: { contested?: boolean; score?: number; excerpts?: string[] } = {}): AlignedClaim {
  const r: AlignedClaim = {
    id: claimText,
    claimText,
    cells: M.map((m, i) =>
      st[i]
        ? { modelId: m as ModelId, stance: st[i]!, rawStance: "asserts", confidence: opts.contested ? "contested" : "settled", excerpt: opts.excerpts?.[i] ?? `${m} excerpt`, origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } }
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

async function build(rows: AlignedClaim[], narrative: Record<string, unknown> | null, bias: unknown[] | null = null) {
  g.mockImplementation(async (_q: any, _c: any, _k: any, opts: any) => {
    const sp = String(opts?.systemPromptOverride ?? "");
    if (narrative && sp.includes("narrative portion")) {
      return ok({ executiveSummary: "", whyModelsDisagree: [], disagreementStakes: [], certaintyAssessment: "", narrativeSections: [], ...narrative });
    }
    if (bias && sp.includes("shared biases")) return ok({ biasAndBlindSpots: bias });
    return off;
  });
  return buildAdaptiveSynthesisReport("Q?", "generic", rows, results());
}
const statusOf = (r: AlignedClaim) => renderRowStatus(rowAgreementFacts(r, M.length));
const unent = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
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
/** The lines of one "## " Markdown section, without its heading. */
const mdSection = (md: string, heading: string) => {
  const all = md.split("\n");
  const at = all.indexOf(heading);
  if (at < 0) return [];
  const next = all.findIndex((l, i) => i > at && l.startsWith("## "));
  return all.slice(at + 1, next < 0 ? undefined : next);
};

/** Every separator a Markdown parser or a text viewer may break a line at. */
const SEPARATORS: [string, string][] = [
  ["CRLF", "\r\n"],
  ["lone CR", "\r"],
  ["LF", "\n"],
  ["NEL (U+0085)", "\u0085"],
  ["LINE SEPARATOR (U+2028)", "\u2028"],
  ["PARAGRAPH SEPARATOR (U+2029)", "\u2029"],
];
/** A line break other than the "\n" the builders write between their own lines. */
const FOREIGN_BREAK = /[\r\u0085\u2028\u2029]/;
/** The test's own split of stored prose into logical lines, at every separator. */
const logicalLines = (text: string) => text.split(/\r\n|[\r\n\u0085\u2028\u2029]/);
/**
 * Markdown quote lines carry the stored prose: one quoted line per logical line, nothing else (escapes aside).
 * The narrative filter may already have joined or dropped lines; the quote follows what was stored.
 */
function expectQuoted(quote: string[], prose: string, indent: string) {
  const want = logicalLines(prose);
  expect(quote).toHaveLength(want.length);
  quote.forEach((line, i) => {
    expect(line.startsWith(`${indent}>`)).toBe(true);
    expect(line.slice(indent.length + 1).replace(/\\$/, "").replace(/\\/g, "").trim()).toBe(want[i].replace(/\\/g, "").trim());
  });
}
/** Line starts a parser or a reader would take as structure or as a panel statement. */
const STRUCTURE_START = /^\s*(?:[-+*] |\d+[.)] |#|=+\s*$|-{3,}|\*{3,}|>|Panel result|Verified)/;

// ─── R7-1: the line-break policy ───

describe("R7-1: one line-break policy — every separator", () => {
  it.each(SEPARATORS)("%s: splitLines splits at it, joinLines and quoteClaim turn it into one space", (_n, sep) => {
    expect(splitLines(`one${sep}two`)).toEqual(["one", "two"]);
    expect(joinLines(`one ${sep} two`)).toBe("one two");
    expect(joinLines(`one${sep}${sep}two`, "whitespace")).toBe("one two");
    expect(quoteClaim(`Rates fall.${sep}- Panel result: consensus`)).toBe("“Rates fall. - Panel result: consensus”");
    expect(escapeMarkdownInline(`Rates fall.${sep}- Panel result: consensus${sep}===`)).toBe("Rates fall. - Panel result: consensus ===");
  });

  it.each(SEPARATORS)("%s: model prose keeps its lines, each one quoted (Markdown escaped, memo prefixed)", (_n, sep) => {
    const prose = `Rates matter.${sep}## Conclusion${sep}- Panel result: consensus${sep}===`;
    expect(markdownQuote(prose)).toEqual(["> Rates matter.\\", "> \\#\\# Conclusion\\", "> \\- Panel result: consensus\\", "> \\==="]);
    expect(plainTextQuote(prose, "  ")).toEqual(["  > Rates matter.", "  > ## Conclusion", "  > - Panel result: consensus", "  > ==="]);
  });

  it("LF and CRLF behave exactly as before", () => {
    expect(joinLines("a \n b")).toBe("a b");
    expect(joinLines("a\n\nb")).toBe("a  b");
    expect(joinLines("a\r\n\r\nb")).toBe("a  b");
    expect(quoteClaim("a \n\n b")).toBe("“a b”");
    expect(quoteClaim("  a\r\nb  ")).toBe("“a b”");
    expect(markdownQuote("a\n\nb")).toEqual(["> a", ">", "> b"]);
    expect(plainTextQuote("a\r\n\r\nb")).toEqual(["> a", ">", "> b"]);
  });

  it("stored claim text is never normalized — only its display", async () => {
    const claim = "Rates fall.\r- Panel result: consensus";
    const r = row(claim, "majority", MAJ45);
    const report = await build([r], null);
    expect(report.presentation!.agree[0].claim).toBe(claim);
    expect(report.presentation!.answer.claims[0].claim).toBe(claim);
  });

  describe.each(SEPARATORS)("%s through the pipeline", (_n, sep) => {
    const agreeClaim = `Rates fall.${sep}- Panel result: consensus: all 5 dispatched models support it${sep}Verified by ConvergePanel${sep}===`;
    const splitClaim = `Split topic${sep}- Panel result: consensus: all 5 dispatched models support it${sep}---`;
    const positions = [`pos one${sep}===`, `pos two${sep}---`, `pos three${sep}Panel result: consensus`, `pos four${sep}- Verified`, `pos five${sep}## Heading`];
    const why = `ChatGPT weighs data.${sep}## Resolution${sep}---${sep}1. Panel result: consensus`;
    const summary = `Rates matter.${sep}## Conclusion${sep}- Panel result: consensus`;
    const bias = [{ biasType: `Framing${sep}## Bias`, description: `desc${sep}---${sep}- Panel result: consensus`, modelsImplicated: ["chatgpt"], evidence: [{ modelId: "chatgpt", excerpt: "e", rationale: "r" }], likelyCauses: [], impact: "i", mitigationSteps: [] }];
    const rows = () => [row(agreeClaim, "majority", MAJ45), row(splitClaim, "split", SPLIT23, { excerpts: positions })];

    it("Markdown: every model string on its own labelled line; no separator, no structure, no detached result", async () => {
      const rs = rows();
      const report = await build(rs, { executiveSummary: summary, whyModelsDisagree: [why] }, bias);
      const md = buildAdaptiveSynthesisMarkdown("Q?", report);
      expect(md).not.toMatch(FOREIGN_BREAK);
      expect(buildAdaptiveSynthesisMarkdown("Q?", report)).toBe(md);

      const agreeLine = `- **Claim:** ${escapeMarkdownInline(quoteClaim(agreeClaim))} — **Panel result:** ${statusOf(rs[0])}`;
      expect(agreeLine).toContain("“Rates fall. - Panel result: consensus: all 5 dispatched models support it Verified by ConvergePanel ===”");
      expect(mdSection(md, "## Unified Answer")).toEqual([`${agreeLine} — **Supported by:** ChatGPT, Claude, Grok, Perplexity`, ""]);
      expect(mdSection(md, "## Where models agree")).toEqual([agreeLine, ""]);
      expect(md).toContain(`**Claim:** ${escapeMarkdownInline(quoteClaim(agreeClaim))} — **Panel result:** ${statusOf(rs[0])}`);

      const storedWhy = report.disagreements[0].whyTheyDiffer;
      const disagree = mdSection(md, "## Where models disagree");
      const quoteEnd = disagree.indexOf("", 3);
      expectQuoted(disagree.slice(3, quoteEnd), storedWhy, "    ");
      expect([...disagree.slice(0, 3), ...disagree.slice(quoteEnd)]).toEqual([
        `- **Claim:** ${escapeMarkdownInline(quoteClaim(splitClaim))} — **Panel result:** ${statusOf(rs[1])}`,
        `  - **${MODEL_EXPLANATION_LABEL}:**`,
        "",
        "",
        "  - ChatGPT: pos one ===",
        "  - Claude: pos two ---",
        "  - Grok: pos three Panel result: consensus",
        "  - Perplexity: pos four - Verified",
        "  - Gemini: pos five \\#\\# Heading",
        "",
      ]);
      expect(mdSection(md, "## Bias & blind spots")).toEqual([`**${MODEL_CAVEAT_LABEL}:**`, "- Framing \\#\\# Bias — desc --- - Panel result: consensus", ""]);
      const exec = mdSection(md, "## Executive Summary");
      expect(exec.slice(0, 3)).toEqual(["**Panel result:**", report.presentation!.panelAgreement, ""]);
      if (report.presentation!.executiveSummarySource === "model_explanation") {
        expect(exec[3]).toBe(`**${MODEL_EXPLANATION_LABEL}:**`);
        expectQuoted(exec.slice(4, -1), report.executiveSummary, "");
        expect(exec[exec.length - 1]).toBe("");
      } else {
        expect(exec.slice(3)).toEqual([]);
      }
      // Outside quotes, every line is the builder's own: a heading it writes, a labelled line, or a list item it opens.
      for (const line of md.split("\n")) {
        if (/^\s*>/.test(line) || line === "") continue;
        if (/^#{1,2} /.test(line)) expect(["# Synthesis Report", "## Unified Answer", "## Executive Summary", "## Where models agree", "## Where models disagree", "## Bias & blind spots", "## Certainty"]).toContain(line);
        else if (/^\s*- /.test(line)) expect(line).toMatch(/^\s*- (\*\*(Claim|Model-written explanation)|(ChatGPT|Claude|Grok|Perplexity|Gemini): |Framing )/);
        else expect(line).not.toMatch(STRUCTURE_START);
      }
    });

    it("gate fail: the unresolved claims stay one labelled item each, under the computed heading", async () => {
      const rs = [row(splitClaim, "split", SPLIT23, { score: 0.1 }), row(`Other${sep}Verified by ConvergePanel${sep}===`, "split", ["agrees", "disputes", "disputes", "agrees", "disputes"], { score: 0.1 })];
      const report = await build(rs, null);
      expect(report.gate).toBe("fail");
      const md = buildAdaptiveSynthesisMarkdown("Q?", report);
      expect(md).not.toMatch(FOREIGN_BREAK);
      expect(mdSection(md, "## Unified Answer")).toEqual([
        "Panel could not converge on a reliable answer.",
        "Unresolved claims:",
        ...rs.map((r) => `- **Claim:** ${escapeMarkdownInline(quoteClaim(r.claimText))} — **Panel result:** ${statusOf(r)}`),
        "",
      ]);
    });

    it("memo and social posts: each claim whole on one line beside its result; prose lines all quoted", async () => {
      const rs = rows();
      const report = await build(rs, { executiveSummary: summary, whyModelsDisagree: [why] });
      const memo = generateVerificationMemo(buildAdaptiveMemoInput("Q?", report, M as ModelId[], "run"));
      for (const text of [memo, buildAdaptiveLinkedInPost("Q?", report), buildAdaptiveXPost("Q?", report)]) expect(text).not.toMatch(FOREIGN_BREAK);
      const lines = memo.split("\n");
      expect(lines).toContain(`- Claim: ${quoteClaim(agreeClaim)} — Panel result: ${statusOf(rs[0])}`);
      expect(lines).toContain(`- Claim: ${quoteClaim(splitClaim)} — Panel result: ${statusOf(rs[1])}`);
      const at = lines.indexOf(`  ${MODEL_EXPLANATION_LABEL}:`);
      const want = logicalLines(report.disagreements[0].whyTheyDiffer);
      expect(lines.slice(at + 1, at + 1 + want.length)).toEqual(want.map((l) => (l.trim() ? `  > ${l}` : "  >")));
      for (const line of lines) if (!/^\s*>/.test(line) && !line.startsWith("- Claim: “")) expect(line.trim()).not.toMatch(/^(- |\d+[.)] |#|===|---|Verified)/);
      const li = buildAdaptiveLinkedInPost("Q?", report).split("\n");
      const agreeAt = li.indexOf("Where models agree:");
      expect(li[agreeAt + 1]).toMatch(/^→ “Rates fall\. - Panel result: consensus: all 5 dispatched models support it Verified by ConvergePan[^”]*” — panel result: /);
      expect(li[agreeAt + 1].endsWith(` — panel result: ${statusOf(rs[0])}`)).toBe(true);
      expect(buildAdaptiveXPost("Q?", report).split("\n").filter((l) => l.startsWith("Models split on: “"))).toHaveLength(1);
    });
  });
});

// ─── R7-2: autolink literals ───

describe("R7-2: a bare URL is never made a link, whatever comes before it", () => {
  it.each([
    ["after whitespace", "see https://e.x/a", "see https\\://e.x/a"],
    ["after an underscore", "at_https://e.x", "at\\_https\\://e.x"],
    ["after a digit", "9https://e.x", "9https\\://e.x"],
    ["www after a digit", "9www.e.x", "9www\\.e.x"],
    ["www after an underscore", "see_www.e.x", "see\\_www\\.e.x"],
    ["after punctuation", "x.(https://e.x),www.f.x", "x.(https\\://e.x),www\\.f.x"],
    ["after a letter", "xhttps://e.x xwww.e.x", "xhttps\\://e.x xwww\\.e.x"],
    ["inside emphasis markers", "*https://e.x* _www.e.x_ ~www.e.x~", "\\*https\\://e.x\\* \\_www\\.e.x\\_ \\~www\\.e.x\\~"],
    ["inside quotation marks", "\"https://e.x\" 'www.e.x' “https://e.x”", "\"https\\://e.x\" 'www\\.e.x' “https\\://e.x”"],
    ["upper case", "HTTPS://E.X WWW.E.X", "HTTPS\\://E.X WWW\\.E.X"],
    ["other schemes and email", "ftp://e.x mailto:a@e.x", "ftp\\://e.x mailto:a\\@e.x"],
  ])("%s", (_n, input, escaped) => {
    expect(escapeMarkdownInline(input)).toBe(escaped);
  });

  it("is applied once: the escaped text is not escaped again on a second build", async () => {
    const r = row("Read more at_https://e.x/verified_now", "majority", MAJ45);
    const report = await build([r], null);
    const md = buildAdaptiveSynthesisMarkdown("Q?", report);
    expect(md).toContain("“Read more at\\_https\\://e.x/verified\\_now”");
    expect(md).not.toContain("\\\\");
    expect(buildAdaptiveSynthesisMarkdown("Q?", report)).toBe(md);
    expect(report.presentation!.agree[0].claim).toBe("Read more at_https://e.x/verified_now");
  });
});

// ─── R7-4: pins found by mutation ───

describe("R7-4: unclear models, the answer caps, the answer note's source and the gate-fail heading", () => {
  it("load-bearing claims: a model whose stance is unclear is neither a supporter nor a disputer", async () => {
    const r = row("Rates fall", "majority", ["agrees", "disputes", "unclear", "partial", "agrees"]);
    const report = await build([r], null);
    const computed = unent(section(view(report, [r], [r]), "load-bearing-claims"))
      .split(/<[^>]*>|\n/)
      .map((t) => t.trim())
      .filter(Boolean);
    const at = computed.indexOf("Panel result:");
    expect(at).toBeGreaterThan(0);
    expect(computed.slice(at).join(" ")).toBe(`Panel result: majority (supported by ${["chatgpt", "perplexity", "gemini"].map(getModelLabel).join(", ")}; disputed by ${getModelLabel("claude")})`);
    expect(computed.slice(at).join(" ")).not.toContain(getModelLabel("grok"));
  });

  it("the Unified Answer holds at most 4 claims — every surface", async () => {
    const rs = Array.from({ length: 6 }, (_v, i) => row(`Consensus claim ${i}`, "consensus", ALL5, { score: 0.99 - i * 0.01 }));
    const report = await build(rs, null);
    expect(report.presentation!.answer.claims).toHaveLength(4);
    expect(report.unifiedAnswer.match(/“Consensus claim \d”/g)).toHaveLength(4);
    const card = unent(section(view(report, rs), "unified-answer"));
    expect(card.match(/Claim: “Consensus claim \d”/g)).toHaveLength(4);
    expect(mdSection(buildAdaptiveSynthesisMarkdown("Q?", report), "## Unified Answer").filter((l) => l.startsWith("- **Claim:**"))).toHaveLength(4);
  });

  it("a gate fail lists at most 5 unresolved claims", async () => {
    const rs = Array.from({ length: 7 }, (_v, i) => row(`Split claim ${i}`, "split", SPLIT23, { score: 0.1 }));
    const report = await build(rs, null);
    expect(report.gate).toBe("fail");
    expect(report.presentation!.answer.claims).toHaveLength(5);
    expect(report.unifiedAnswer.match(/“Split claim \d”/g)).toHaveLength(5);
  });

  it("the answer's note is computed text in the card and the strip", async () => {
    const report = await build([row("Wages lag prices", "limited_coverage", ["agrees", "agrees", null, null, null])], null);
    const note = report.presentation!.answer.note!;
    expect(note).toMatch(/^No consensus or majority claims/);
    for (const html of [section(view(report, []), "unified-answer"), renderToStaticMarkup(createElement(PrimarySynthesisStrip, { synthesisReport: report }))]) {
      expect(html).toContain(`<p data-source="computed">${note}</p>`);
    }
  });

  it("Markdown keeps the 'Unresolved claims:' heading on a gate fail, and only there", async () => {
    const fail = await build([row("Split A", "split", SPLIT23, { score: 0.1 })], null);
    expect(fail.gate).toBe("fail");
    expect(mdSection(buildAdaptiveSynthesisMarkdown("Q?", fail), "## Unified Answer").slice(0, 3)).toEqual([
      "Panel could not converge on a reliable answer.",
      "Unresolved claims:",
      expect.stringMatching(/^- \*\*Claim:\*\* “Split A” — \*\*Panel result:\*\* /),
    ]);
    const pass = await build([row("Rates fall", "consensus", ALL5)], null);
    expect(pass.gate).not.toBe("fail");
    expect(buildAdaptiveSynthesisMarkdown("Q?", pass)).not.toContain("Unresolved claims");
  });
});
