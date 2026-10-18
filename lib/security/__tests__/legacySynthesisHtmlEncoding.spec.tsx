/**
 * Security Gate S0 — CodeQL #3 / #6 (root cause A): model-written text in the legacy synthesis HTML.
 *
 * lib/consensus.ts synthesizeReport builds the Unified Answer as an HTML string, which ResultsDisplay renders with
 * dangerouslySetInnerHTML. Before S0 the model's claim text was interpolated raw and the sink's only defence was a
 * <script> regex, so `<h4>x</h4><img src=x onerror=…>` (the heading ends the sink's section-removal early) reached
 * the DOM as live markup. Every interpolated value is now HTML-encoded at construction.
 *
 * The oracle is independent of the code under test: the template's own markup is an allow-list of tag names and
 * attributes (taken from lib/consensus.ts), and every payload must appear only as encoded text.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "uid-1" }, authReady: true }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }) }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import ResultsDisplay from "@/components/ResultsDisplay";
import { synthesizeReport } from "@/lib/consensus";
import { escapeHtml } from "@/lib/security/escapeHtml";

/** The tags and attributes lib/consensus.ts's Unified Answer template writes itself — nothing else may appear as markup. */
const TEMPLATE_TAGS = new Set(["h2", "h3", "h4", "p", "strong", "em", "ul", "li", "div"]);
const TEMPLATE_ATTRS = new Set(["class"]);

/** Every element in an HTML string: tag name and attribute names (a tokenizer for the test, not a sanitizer). */
function elements(html: string): { tag: string; attrs: string[] }[] {
  const out: { tag: string; attrs: string[] }[] = [];
  for (const m of html.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)) {
    const attrs = Array.from(m[2].matchAll(/\s+([^\s=>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g), (a) => a[1].toLowerCase());
    out.push({ tag: m[1].toLowerCase(), attrs });
  }
  return out;
}
/** Markup outside the template allow-list, plus any raw "<" that does not open a template element. */
function foreignMarkup(html: string): string[] {
  const bad = elements(html)
    .filter((e) => !TEMPLATE_TAGS.has(e.tag) || e.attrs.some((a) => !TEMPLATE_ATTRS.has(a)))
    .map((e) => `<${e.tag} ${e.attrs.join(" ")}>`);
  const stray = (html.match(/<(?!\/?(?:h2|h3|h4|p|strong|em|ul|li|div)[\s>])/g) ?? []).length;
  return stray ? [...bad, `${stray} raw '<'`] : bad;
}

const TAIL = "Rate cuts reach inflation within a year";
const PAYLOADS: [string, string][] = [
  ["img onerror", `<img src=x onerror=alert(1)> ${TAIL}`],
  ["svg onload", `<svg onload=alert(2)></svg> ${TAIL}`],
  ["heading ends the section removal, then img", `<h4>Note</h4><img src=x onerror=alert(3)> ${TAIL}`],
  ["script with a spaced end tag", `<h4>Note</h4></script ><script >alert(4)</script > ${TAIL}`],
  ["javascript: link", `<h2>Note</h2><a href="javascript:alert(5)">source</a> ${TAIL}`],
  ["iframe srcdoc", `<h3>Note</h3><iframe srcdoc="<script>alert(6)</script>"></iframe> ${TAIL}`],
  ["details ontoggle", `<h4>Note</h4><details open ontoggle=alert(7)><summary>x</summary></details> ${TAIL}`],
  ["attribute break-out", `<h4>Note</h4>" onmouseover="alert(8) ' onfocus='alert(9) ${TAIL}`],
  ["style injection", `<h4>Note</h4><p style="background:url(javascript:alert(10))">x</p> ${TAIL}`],
  ["nested / malformed markup", `<h4>Note</h4><<img src=x onerror=alert(11)>> <scr<script>ipt>alert(12)</script> ${TAIL}`],
  ["entity-encoded payload stays literal", `<h4>Note</h4>&lt;img src=x onerror=alert(13)&gt; ${TAIL}`],
];

/** Two models agree on the line (agreement cluster) and a third conflicts (disagreement cluster): the payload lands in every template slot. */
function results(line: string) {
  const mk = (modelId: string, text: string) => ({ modelId, status: "ok", rawText: text, rawTextFull: text, tokenUsage: { totalTokens: 3 }, latencyMs: 12 });
  const other = `${line} unlike the alternative view that tariffs dominate prices in every scenario`;
  return [mk("chatgpt", `- ${line}\n- Housing costs respond slowest over several quarters`), mk("claude", `- ${line}\n- Housing costs respond slowest over several quarters`), mk("grok", `- ${other}\n- Energy shocks dominate headline inflation readings`)];
}

async function sinkHtml(rs: ReturnType<typeof results>) {
  const synthesized = synthesizeReport(rs as never);
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(ResultsDisplay as never, { results: rs, synthesizedReport: synthesized, onRerun: () => {}, onAddModel: () => {}, question: "Q?", runId: "run-x", synthesisStatus: "idle", synthesisReport: null, adaptive: null, allowSynthesisGeneration: false } as never));
  });
  return { unifiedAnswer: synthesized?.unifiedAnswer ?? "", sinks: r.root.findAll((n) => !!(n.props as { dangerouslySetInnerHTML?: unknown }).dangerouslySetInnerHTML).map((n) => (n.props as any).dangerouslySetInnerHTML.__html as string) };
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("escapeHtml", () => {
  it("encodes the five HTML structure characters, & first", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&amp;</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;");
    expect(escapeHtml("plain text, no change")).toBe("plain text, no change");
    expect(escapeHtml("")).toBe("");
  });
});

describe("S0 root cause A: model text in the legacy synthesis HTML is data, never markup", () => {
  it.each(PAYLOADS)("%s: synthesizeReport's Unified Answer contains only template markup, with the payload encoded", (_n, line) => {
    const html = synthesizeReport(results(line) as never)!.unifiedAnswer;
    expect(foreignMarkup(html)).toEqual([]);
    expect(html).toContain(escapeHtml(line.split(" Rate cuts")[0]));
  });

  it.each(PAYLOADS)("%s: the real ResultsDisplay sink receives no foreign markup", async (_n, line) => {
    // Before S0 the payload's own heading ended the sink's duplicate-section removal and the payload reached the
    // sink as live markup. Encoded, it cannot: the agreement sections are removed whole (no sink is rendered for
    // them), and whatever the sink does render is template markup only.
    const { sinks } = await sinkHtml(results(line));
    // With this fixture every section of the template is a duplicate the sink removes: an encoded payload cannot
    // cut that removal short, so nothing is left to render (before S0, each heading-prefixed payload left a sink).
    expect(sinks).toEqual([]);
    for (const h of sinks) {
      expect(foreignMarkup(h)).toEqual([]);
      expect(h).not.toMatch(/<(img|svg|script|iframe|a|details|style)\b/i);
    }
  });

  it("benign text with & < > and quotes is preserved, encoded once (it displays exactly as written)", () => {
    const line = `<h4>Note</h4> Wages & prices: "lag" <by> design's way ${TAIL}`;
    const html = synthesizeReport(results(line) as never)!.unifiedAnswer;
    expect(html).toContain("&lt;h4&gt;Note&lt;/h4&gt; Wages &amp; prices: &quot;lag&quot; &lt;by&gt; design&#39;s way");
    expect(html).not.toContain("&amp;amp;");
    expect(foreignMarkup(html)).toEqual([]);
  });

  it("a model id outside the known set is encoded too: runModelFamilyName returns unknown ids as written, and /api/run-panel does not allow-list them", () => {
    const evil = `<img src=x onerror=alert(15)>`;
    const mk = (modelId: string, text: string) => ({ modelId, status: "ok", rawText: text, rawTextFull: text, tokenUsage: { totalTokens: 3 }, latencyMs: 12 });
    const rs = [mk(evil, `- ${TAIL}\n- Housing costs respond slowest over several quarters`), mk("claude", `- ${TAIL}\n- Housing costs respond slowest over several quarters`), mk("grok", `- ${TAIL} unlike the alternative view that tariffs dominate\n- Energy shocks dominate headline inflation readings`)];
    const html = synthesizeReport(rs as never)!.unifiedAnswer;
    expect(html).toContain(escapeHtml(evil));
    expect(foreignMarkup(html)).toEqual([]);
  });

  it("model names and the template's own structure are unchanged for ordinary text", () => {
    const html = synthesizeReport(results(TAIL) as never)!.unifiedAnswer;
    expect(html).toContain("<h2>Trust Summary</h2>");
    expect(html).toContain("<h3>Where the models agree</h3>");
    expect(html).toMatch(/Agreed by 2 models \(ChatGPT, Claude\)/);
    expect(foreignMarkup(html)).toEqual([]);
  });
});
