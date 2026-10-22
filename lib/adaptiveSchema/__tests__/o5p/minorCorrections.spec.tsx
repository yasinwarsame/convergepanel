/**
 * Order 5 Contract P — final three-minor corrections (owner: ORDER5_P_FINAL_THREE_MINOR_CORRECTIONS_AUTHORIZED_PR_WITHHELD).
 *
 * MINOR 1: a marked X post never drops both the unresolved row and the pointer to it.
 * MINOR 2: xFit reads the text once; the number of cuts it checks is bounded by the budget, not the text length.
 * N-A: the marked X post reads up to run-panel's question limit (10,000), so no accepted question is cut early.
 * MINOR 3: on a marked record, ListView does not call a count of values that name a source "citations".
 *
 * Each correction has a negative control: the a3416c37 behaviour (for N-A, the 2b0d1c7 limit) fails the same check.
 */

jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
const connectorMap: Record<string, jest.Mock> = {};
jest.mock("@/lib/connectors", () => ({ CONNECTOR_MAP: connectorMap }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { callGemini } from "@/lib/connectors/gemini";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { presentPositionSafeReport } from "@/lib/adaptiveSchema/positionPresentation";
import { buildAdaptiveXPost, markedXFallback, xFit, xPostFits, xWeightedLength, X_TEXT_LIMIT } from "@/lib/adaptiveSchema/shareBuilders";
import { MAX_QUESTION_LENGTH } from "@/lib/security/requestValidation";
import * as XW from "@/lib/adaptiveSchema/xWeightedText";
import ListView, { NAMED_SOURCE_VALUES_TITLE } from "@/components/adaptive/ListView";
import { CLASSIFICATION_BASE, DEFAULT_MODE, SCENARIOS, Scenario, geminiMockImpl } from "./o5pScenarios";
import { QUESTION } from "./o5pRender";
import { htmlText } from "./htmlText";

const gem = callGemini as unknown as jest.Mock;

async function build(s: Scenario): Promise<Record<string, any>> {
  gem.mockReset();
  gem.mockImplementation(geminiMockImpl({ ...DEFAULT_MODE, ...(s.mode ?? {}) }));
  for (const k of Object.keys(connectorMap)) delete connectorMap[k];
  const input = s.results();
  const classification = { ...CLASSIFICATION_BASE, queryType: s.schemaId, answerShape: getResultSchema(s.schemaId as any).renderHint } as any;
  const r: any = await finalizeAdaptiveRun(getResultSchema(s.schemaId as any), input, QUESTION, undefined, classification);
  return r.persistedLegacyOutput
    ? JSON.parse(JSON.stringify({ ...r.persistedLegacyOutput, generatedAt: undefined }))
    : { schemaId: r.schemaId, classification, results: r.adaptiveResults, alignedClaims: r.alignedClaims, gate: r.gate, synthesisReport: r.synthesisReport, trustSummary: r.trustSummary };
}
const scenario = (name: string) => SCENARIOS.find((s) => s.name === name)!;
const SUB = { status: "substituted", provider: "deepseek", requestedModel: "deepseek-chat", substitutedFrom: "anthropic:claude-model-1", substitutionReason: "timeout" };
const text = htmlText;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SLOT_NAME = /\b(ChatGPT|Claude|Grok|Perplexity|Gemini|DeepSeek)\b/;

/** The record's first split row with its claim replaced by `claim` (stored claim, joined row and topic together). */
function withClaim(record: Record<string, any>, claim: string) {
  const report = JSON.parse(JSON.stringify(record.synthesisReport));
  const old = report.presentation.disagree[0].claim;
  const rows = record.alignedClaims.map((r: any) => (r.claimText === old ? { ...r, claimText: claim } : r));
  for (const d of report.disagreements) if (d.topic === old) d.topic = claim;
  report.presentation.disagree[0].claim = claim;
  return { report, rows, roster: record.results.map((r: any) => r.modelId) };
}

/** Whether a marked X post with a split row discloses it: the row (its whole computed result), or the pointer. */
function disclosesUnresolved(post: string, result: string, n: number): boolean {
  const row = post.includes("Unresolved: “") && post.includes(` — panel result: ${result}\n\nvia ConvergePanel`);
  const pointer = post.includes(`\n\n${n} unresolved row${n === 1 ? "" : "s"} — see the full report\n\nvia ConvergePanel`);
  return row || pointer;
}

// ─── MINOR 1 ────────────────────────────────────────────────────────────────

describe("MINOR 1: a marked X post with a split row always discloses it (the row, or the pointer)", () => {
  const REVIEWER_Q = "Does raising the minimum wage reduce employment?";

  it("negative control: the checker flags the a3416c37 post for the reviewer's input (row and pointer both dropped)", () => {
    // The post a3416c37 built for generic-mixed, this question and the claim "example.com/x" (REVIEW.md, MINOR 1).
    const a3416c37 = 'Asked a multi-model AI panel: "Does raising the minimum wage reduce employment?"\n\nVerification gate: Caution (requires further review) · Certainty: 71%\n\nvia ConvergePanel';
    expect(xPostFits(a3416c37)).toBe(true);
    expect(disclosesUnresolved(a3416c37, "1 panel slot supporting or partially supporting and 1 disputing; 1 unclear.", 1)).toBe(false);
  });

  it("the reviewer's input: the URL claim is quoted whole with the computed result (shorter question)", async () => {
    const record = await build(scenario("generic-mixed"));
    const { report, rows, roster } = withClaim(record, "example.com/x");
    const result = presentPositionSafeReport(report, { rows, roster }).presentation!.disagree[0].result;
    const post = buildAdaptiveXPost(REVIEWER_Q, report, { rows, roster });
    expect(xPostFits(post)).toBe(true);
    expect(post).toContain(`Unresolved: “example.com/x” — panel result: ${result}`);
    expect(disclosesUnresolved(post, result, report.disagreements.length)).toBe(true);
    expect(post).toContain("Verification gate: Caution (requires further review) · Certainty: ");
  });

  const LONG_URL = `https://example.com/${"p".repeat(3000)}`;
  const CLAIMS: [string, string][] = [
    ["very long claim", "Raising the minimum wage reduces teen employment in small firms over the long run ".repeat(12)],
    ["very long URL only", LONG_URL],
    ["URL first", `${LONG_URL} shows teen employment falls`],
    ["several URLs", "https://a.example.com/x https://b.example.org/y?z=1 c.example.net/w d.example.io"],
    ["URLs no space", "example.com/a,example.org/b"],
    ["URL with punctuation", '("example.com/a_(b)"), example.org/c?d=e#f!... and more.'],
    ["unicode", "例子example.com中文 最低工资会减少就业吗？ ".repeat(6)],
    ["emoji", `Employment falls 📉👨‍👩‍👧‍👦🏳️‍🌈🇫🇷1️⃣ ${"👍🏽".repeat(80)}`],
    ["model names in claim", "Claude and ChatGPT both say employment falls; DeepSeek disputes it"],
    ["empty", ""],
    ["spaces", "   "],
    ["a 300-character word", "x".repeat(300)],
  ];
  const QUESTIONS: [string, string][] = [
    ["reviewer", REVIEWER_Q],
    ["long", "Does raising the minimum wage reduce employment in the long run across regions and sectors? ".repeat(8)],
    ["URL question", `Is this right? https://example.com/${"q".repeat(200)}`],
    ["near limit", "q".repeat(200)],
  ];

  it.each(["generic-mixed", "generic-splits", "contested-empirical", "financial-valuation", "factual-tie", "generic-substituted-and-failed"])(
    "%s × adversarial claims × questions: valid, row or pointer, result whole, URLs whole, qualifiers kept, no slot named",
    async (name) => {
      const s = name === "generic-substituted-and-failed" ? scenario(name) : scenario(name);
      const record = await build(s);
      if (!record.synthesisReport.presentation?.disagree?.[0]) return;
      for (const [cl, claim] of CLAIMS) {
        const { report, rows, roster } = withClaim(record, claim);
        const view = presentPositionSafeReport(report, { rows, roster });
        const split = view.presentation!.disagree[0];
        const allowed = new Set([split.claim, split.result].flatMap((t) => XW.xUrlSpans(t.normalize("NFC").replace(/\s+/g, " ").trim()).map((u) => u.url)));
        for (const [ql, q] of QUESTIONS) {
          const id = `${cl}/${ql}`;
          const post = buildAdaptiveXPost(q, report, { rows, roster });
          for (const u of XW.xUrlSpans(q.normalize("NFC"))) allowed.add(u.url);
          expect([id, xPostFits(post), xWeightedLength(post) <= 280]).toEqual([id, true, true]);
          expect([id, disclosesUnresolved(post, split.result, report.disagreements.length)]).toEqual([id, true]);
          for (const u of XW.xUrlSpans(post.normalize("NFC"))) expect([id, allowed.has(u.url)]).toEqual([id, true]);
          expect([id, LONE_SURROGATE.test(post)]).toEqual([id, false]);
          expect([id, SLOT_NAME.test(post.replace(/“[^”]*”/g, ""))]).toEqual([id, false]); // only inside the quoted claim
          if (/Caution/.test(post)) expect([id, post.includes("(requires further review)")]).toEqual([id, true]);
          expect([id, post.endsWith("via ConvergePanel")]).toEqual([id, true]);
          if (post.includes("Unresolved: “")) {
            const quoted = post.slice(post.indexOf("Unresolved: “") + "Unresolved: “".length, post.indexOf("” — panel result: "));
            const shown = quoted.endsWith("…") ? quoted.slice(0, -1) : quoted;
            const asQuoted = claim.normalize("NFC").replace(/\s+/g, " ").trim().replace(/"/g, "'").replace(/“/g, "‘").replace(/”/g, "’"); // quoteClaim's quote swap
            expect([id, asQuoted.startsWith(shown)]).toEqual([id, true]); // a prefix of the claim, never invented
          }
        }
      }
    }
  );

  it("an unquotable claim (empty, spaces) gets the pointer, never a row with nothing quoted", async () => {
    const record = await build(scenario("generic-mixed"));
    for (const claim of ["", "   "]) {
      const { report, rows, roster } = withClaim(record, claim);
      const post = buildAdaptiveXPost(REVIEWER_Q, report, { rows, roster });
      const n = report.disagreements.length;
      expect(n).toBeGreaterThan(0);
      expect(post).toBe(`Asked a multi-model AI panel: "${REVIEWER_Q}"\n\nVerification gate: Caution (requires further review) · Certainty: 71%\n\n${n} unresolved row${n === 1 ? "" : "s"} — see the full report\n\nvia ConvergePanel`);
      expect(post).not.toContain("Unresolved: “");
      expect(post).not.toContain("“”");
    }
  });

  it("substituted provenance: the post names neither the requested model nor the substitute", async () => {
    const s = scenario("generic-mixed");
    const sub: Scenario = { ...s, name: "generic-mixed+sub", results: () => s.results().map((r: any) => (r.modelId === "claude" ? { ...r, ...SUB } : r)) };
    const record = await build(sub);
    for (const claim of ["example.com/x", ""]) {
      const { report, rows, roster } = withClaim(record, claim);
      const post = buildAdaptiveXPost(REVIEWER_Q, report, { rows, roster });
      expect(xPostFits(post)).toBe(true);
      expect(post).not.toMatch(/Claude|DeepSeek|substitut/i);
    }
  });

  it("no record without a split row gains a row or pointer (unchanged)", async () => {
    const record = await build(scenario("generic-consensus"));
    if (record.synthesisReport.presentation?.disagree?.length) return;
    const post = buildAdaptiveXPost(REVIEWER_Q, record.synthesisReport, { rows: record.alignedClaims, roster: record.results.map((r: any) => r.modelId) });
    expect(post).not.toMatch(/Unresolved: |unresolved row/);
  });

  it("the defined fallback stays valid and claims nothing it omits", () => {
    const f = markedXFallback("Verification gate: Caution (requires further review) · Certainty: 71%");
    expect(xPostFits(f)).toBe(true);
    expect(f).not.toMatch(/Unresolved|unresolved row|panel result/);
  });
});

// ─── MINOR 2 ────────────────────────────────────────────────────────────────

/** The a3416c37 xFit, kept only as the negative control: it re-parses the whole prefix at every grapheme end. */
function legacyXFit(text: string, budget: number, codePoints = false): string {
  const whole = text.normalize("NFC");
  if (XW.parseXText(whole).weightedLength <= budget) return whole;
  const urls = XW.xUrlSpans(whole);
  const key = (u: XW.XUrlSpan) => `${u.start}\u0000${u.url}`;
  const original = new Set(urls.map(key));
  let at = 0;
  const ends: number[] = codePoints ? Array.from(whole, (ch) => (at += ch.length)) : Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(whole), (x) => x.index + x.segment.length);
  for (let i = ends.length - 2; i >= 0; i -= 1) {
    const cut = ends[i];
    if (urls.some((u) => cut > u.start && cut < u.end)) continue;
    const kept = whole.slice(0, cut).trimEnd();
    if (!kept) continue;
    const candidate = `${kept}…`;
    if (XW.parseXText(candidate).weightedLength > budget) continue;
    if (!XW.xUrlSpans(candidate).every((u) => original.has(key(u)))) continue;
    return candidate;
  }
  return "";
}

describe("MINOR 2: xFit's work is bounded by the budget, not the text length", () => {
  const parses = (f: () => unknown) => {
    const spy = jest.spyOn(XW, "parseXText");
    try {
      f();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  };

  it("negative control: the a3416c37 xFit parses once per grapheme end (about the text length)", () => {
    const t = "lorem ipsum dolor sit amet ".repeat(40); // 1,080 characters
    expect(parses(() => legacyXFit(t, 80))).toBeGreaterThan(900);
  });

  it.each([
    ["words", "lorem ipsum dolor sit amet ".repeat(186)],
    ["a.a.a.", "a.".repeat(2500)],
    ["300 domains", Array.from({ length: 300 }, (_, i) => `site${i}.com`).join(" ")],
    ["versions", "v1.2.3 e.g. a.b ".repeat(300)],
    ["CJK", "最低工资会减少就业吗".repeat(500)],
    ["emoji", "👨‍👩‍👧‍👦👍🏽🇫🇷".repeat(600)],
    ["combining marks", `e${"́".repeat(4000)} tail`],
  ])("%s: parses checked ≤ budget + 2, and xFit + a whole post finish quickly", (_label, t) => {
    for (const budget of [12, 24, 80]) expect(parses(() => xFit(t, budget))).toBeLessThanOrEqual(budget + 2);
    const t0 = Date.now();
    for (const budget of [12, 24, 48, 60, 80]) xFit(t, budget);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("a 5,000-character degenerate question: the post is built and valid", async () => {
    const record = await build(scenario("generic-mixed"));
    const { report, rows, roster } = withClaim(record, "a.".repeat(2500));
    const t0 = Date.now();
    const post = buildAdaptiveXPost("a.".repeat(2500), report, { rows, roster });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(xPostFits(post)).toBe(true);
  });

  it("text over X_TEXT_LIMIT is read only up to its last whitespace before the limit, and shown as cut", async () => {
    expect(X_TEXT_LIMIT).toBe(10000); // /api/run-panel's question limit
    expect(X_TEXT_LIMIT).toBe(MAX_QUESTION_LENGTH);
    const record = await build(scenario("generic-mixed"));
    const cases: [string, string, (post: string) => void][] = [
      ["20,000 degenerate, no whitespace", "a.".repeat(10_000), (post) => expect(post).toMatch(/unresolved rows? — see the full report/)],
      ["12,000 of words", "employment falls in small firms ".repeat(380), (post) => expect(post).toMatch(/Unresolved: “employment[^”]*…” — panel result: /)],
      ["URL across the limit", `${"word ".repeat(1995)}https://example.com/${"x".repeat(200)} tail`, (post) => expect(post).not.toMatch(/example\.com/)],
      ["whole-fitting head of a long text", `${"https://example.com/" + "p".repeat(1500)} ${"https://example.org/" + "q".repeat(1500)} ${"z".repeat(8000)}`, (post) => expect(post).not.toMatch(/q{1500}”/)],
    ];
    for (const [label, claim, check] of cases) {
      const { report, rows, roster } = withClaim(record, claim);
      const t0 = Date.now();
      const post = buildAdaptiveXPost(claim, report, { rows, roster });
      expect([label, Date.now() - t0 < 3_000]).toEqual([label, true]);
      expect([label, xPostFits(post)]).toEqual([label, true]);
      check(post);
      const fragments = XW.xUrlSpans(post.normalize("NFC")).map((u) => u.url);
      const whole = XW.xUrlSpans(claim).map((u) => u.url);
      for (const f of fragments) expect([label, f, whole.includes(f)]).toEqual([label, f, true]);
    }
  });

  it("a question at exactly X_TEXT_LIMIT is not cut (same post as without the limit)", async () => {
    const record = await build(scenario("generic-mixed"));
    const q = "Does raising the minimum wage reduce employment? ".repeat(205).slice(0, 10000);
    expect(q.length).toBe(10000);
    const post = buildAdaptiveXPost(q, record.synthesisReport, { rows: record.alignedClaims, roster: record.results.map((r: any) => r.modelId) });
    const one = q.replace(/\s+/g, " ").trim();
    expect([80, 48, 24].map((b) => `Asked a multi-model AI panel: "${legacyXFit(one, b)}"`)).toContain(post.split("\n\n")[0]);
  });

  it("same result as the a3416c37 xFit on short adversarial inputs, and every cut is a grapheme-safe prefix", () => {
    const pieces = ["example.com", "example.comma", "https://t.co/abcdefghij", "a.co/xx........", "(see foo.com)", "例子.中国/路径", "😀", "👨‍👩‍👧‍👦", "🇫🇷", "é", "é", " ", "…", "Paris", "U.S.A.", "1️⃣", "x.cox.co", "\"example.com/p\""];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 400; n++) {
      let t = "";
      for (let j = 0, k = 1 + Math.floor(rnd() * 12); j < k; j++) t += pieces[Math.floor(rnd() * pieces.length)];
      for (const budget of [3, 12, 24, 40]) {
        const got = xFit(t, budget);
        expect([t, budget, got]).toEqual([t, budget, legacyXFit(t, budget)]);
        expect(LONE_SURROGATE.test(got)).toBe(false);
        if (got && got !== t.normalize("NFC")) {
          const body = got.slice(0, -1);
          const segs = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t.normalize("NFC")), (x) => x.index + x.segment.length);
          expect([t, budget, segs.includes(body.length) || t.normalize("NFC").slice(0, segs.find((e) => e >= body.length)).trimEnd() === body]).toEqual([t, budget, true]);
        }
      }
    }
  });

  it("a URL longer than 23 graphemes is kept whole when it fits as a link (same result as a3416c37)", () => {
    for (const t of [`See https://example.com/${"s".repeat(60)} and more words after it`, `https://example.com/${"s".repeat(200)} tail`, `x ${"https://e.co/" + "a".repeat(40)} y ${"https://f.co/" + "b".repeat(40)} z`]) {
      for (const budget of [24, 30, 40, 60]) {
        const got = xFit(t, budget);
        expect([t, budget, got]).toEqual([t, budget, legacyXFit(t, budget)]);
      }
    }
    expect(xFit(`See https://example.com/${"s".repeat(60)} and more words after it`, 30)).toBe(`See https://example.com/${"s".repeat(60)}…`);
  });

  it("same result as the a3416c37 xFit on emoji sequences, with and without Intl.Segmenter (code-point fallback)", () => {
    const pieces = ["👨‍👩‍👧‍👦", "🏳️‍🌈", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "🇫🇷", "🇬", "1️⃣", "#️⃣", "👍🏽", "❤️", "©", "™", "‼", "a\u200db", " ", "x", "例", "example.com"];
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const texts: string[] = [];
    for (let n = 0; n < 300; n++) {
      let t = "";
      for (let j = 0, k = 1 + Math.floor(rnd() * 16); j < k; j++) t += pieces[Math.floor(rnd() * pieces.length)];
      texts.push(t);
    }
    const check = (codePoints: boolean) => {
      for (const t of texts) for (const budget of [3, 6, 12, 24]) expect([codePoints, t, budget, xFit(t, budget)]).toEqual([codePoints, t, budget, legacyXFit(t, budget, codePoints)]);
    };
    check(false);
    const Seg = (Intl as any).Segmenter;
    try {
      delete (Intl as any).Segmenter;
      check(true);
    } finally {
      (Intl as any).Segmenter = Seg;
    }
  });
});

// ─── N-A ────────────────────────────────────────────────────────────────────

describe("N-A: the marked X post reads up to run-panel's question limit, so no accepted question is cut early", () => {
  const ASKED = "Asked a multi-model AI panel";
  const FAMILY = "👨‍👩‍👧‍👦";
  const fill = (unit: string, n: number) => unit.repeat(Math.floor(n / unit.length)) + "x".repeat(n % unit.length);
  const SHAPES: [string, (n: number) => string][] = [
    ["long word", (n) => "x".repeat(n)],
    ["unspaced CJK", (n) => "最低工资会减少就业吗".repeat(Math.ceil(n / 10)).slice(0, n)],
    ["joined emoji", (n) => fill(FAMILY, n)],
    ["flags and accents", (n) => fill("🇫🇷é", n)],
    ["degenerate a.", (n) => "a.".repeat(Math.ceil(n / 2)).slice(0, n)],
    ["words", (n) => "employment falls in small firms ".repeat(Math.ceil(n / 32)).slice(0, n)],
    ["several URLs", (n) => Array.from({ length: Math.ceil(n / 20) }, (_, i) => `https://site${i}.com/p${i}`).join(" ").slice(0, n)],
    ["URL first", (n) => `https://example.com/${"p".repeat(n - 20)}`],
  ];
  const LENGTHS = [5000, 5001, 9999, 10000, 10001];
  const one = (t: string) => t.replace(/\s+/g, " ").trim();
  const quoted = (line: string) => line.match(/^Asked a multi-model AI panel: "(.*)"$/s)?.[1] ?? null;
  const graphemeEnds = (t: string) => new Set(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t), (x) => x.index + x.segment.length));

  /** Valid on X, no lone surrogate, every URL whole and from the inputs, and a shown cut ends at a grapheme boundary of the input. */
  function checkPost(label: string, post: string, sources: string[], cutOf: [string, string | null][]) {
    expect([label, xPostFits(post)]).toEqual([label, true]);
    expect([label, LONE_SURROGATE.test(post)]).toEqual([label, false]);
    const whole = new Set(sources.flatMap((s) => XW.xUrlSpans(one(s).normalize("NFC")).map((u) => u.url)));
    for (const u of XW.xUrlSpans(post.normalize("NFC"))) expect([label, u.url, whole.has(u.url)]).toEqual([label, u.url, true]);
    for (const [input, shown] of cutOf) {
      if (!shown || !shown.endsWith("…")) continue;
      const body = shown.slice(0, -1);
      expect([label, one(input).startsWith(body)]).toEqual([label, true]);
      expect([label, graphemeEnds(one(input)).has(body.length) || /\s/.test(one(input)[body.length])]).toEqual([label, true]);
    }
  }

  it("X_TEXT_LIMIT is run-panel's MAX_QUESTION_LENGTH, and both count UTF-16 code units", () => {
    expect(X_TEXT_LIMIT).toBe(10000);
    expect(X_TEXT_LIMIT).toBe(MAX_QUESTION_LENGTH);
    expect(FAMILY.length).toBe(11); // string.length, as requestValidation counts
  });

  it.each(LENGTHS)("question of %i code units, every shape: within the limit it is read whole; above it, cut at whitespace or left out", async (n) => {
    const record = await build(scenario("generic-mixed"));
    const split = record.synthesisReport.presentation.disagree[0];
    for (const [shape, make] of SHAPES) {
      const q = make(n);
      expect([shape, q.length]).toEqual([shape, n]);
      const label = `${shape}@${n}`;
      const t0 = Date.now();
      const post = buildAdaptiveXPost(q, record.synthesisReport, { rows: record.alignedClaims, roster: record.results.map((r: any) => r.modelId) });
      expect([label, Date.now() - t0 < 3_000]).toEqual([label, true]);
      const first = post.split("\n\n")[0];
      checkPost(label, post, [q, split.claim, split.result], [[q, quoted(first)]]);
      expect([label, /Unresolved: “|unresolved rows? — see the full report/.test(post)]).toEqual([label, true]);
      if (n <= MAX_QUESTION_LENGTH) {
        // Read whole: the shown question is xFit of the whole question — never empty (the 5,000 limit left these out).
        expect([label, first]).not.toEqual([label, ASKED]);
        expect([label, [80, 48, 24].map((b) => `${ASKED}: "${xFit(one(q), b)}"`).includes(first)]).toEqual([label, true]);
      } else if (/\s/.test(q.slice(0, MAX_QUESTION_LENGTH))) {
        expect([label, quoted(first)?.endsWith("…")]).toEqual([label, true]);
      } else {
        expect([label, first]).toEqual([label, ASKED]);
      }
    }
  });

  it.each(LENGTHS)("claim of %i code units, every shape, substituted slot: the row (or the pointer) is shown, nothing named", async (n) => {
    const s = scenario("generic-mixed");
    const record = await build({ ...s, name: "generic-mixed+sub", results: () => s.results().map((r: any) => (r.modelId === "claude" ? { ...r, ...SUB } : r)) });
    for (const [shape, make] of SHAPES) {
      const claim = make(n);
      const label = `${shape}@${n}`;
      const { report, rows, roster } = withClaim(record, claim);
      const t0 = Date.now();
      const post = buildAdaptiveXPost("Does raising the minimum wage reduce employment?", report, { rows, roster });
      expect([label, Date.now() - t0 < 3_000]).toEqual([label, true]);
      const row = post.match(/Unresolved: “(.*)” — panel result: /s)?.[1] ?? null;
      checkPost(label, post, [claim, report.presentation.disagree[0].result], [[claim, row]]);
      expect([label, row !== null || /unresolved rows? — see the full report/.test(post)]).toEqual([label, true]);
      expect([label, post]).not.toEqual([label, expect.stringMatching(/Claude|DeepSeek|substitut/i)]);
      // Within the limit an unspaced claim is quoted, not replaced by the pointer (the 5,000 limit emptied it).
      if (n <= MAX_QUESTION_LENGTH && shape !== "degenerate a." && xFit(one(claim), 24)) expect([label, row !== null]).toEqual([label, true]);
      if (n > MAX_QUESTION_LENGTH && !/\s/.test(claim.slice(0, MAX_QUESTION_LENGTH))) expect([label, row]).toEqual([label, null]);
    }
  });

  it("10,000-character degenerate question and claim together: valid, and quick", async () => {
    const record = await build(scenario("generic-mixed"));
    const t = "a.".repeat(5000);
    const { report, rows, roster } = withClaim(record, t);
    const t0 = Date.now();
    const post = buildAdaptiveXPost(t, report, { rows, roster });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(xPostFits(post)).toBe(true);
  });
});

// ─── MINOR 3 ────────────────────────────────────────────────────────────────

function listText(record: Record<string, any>, results = record.results): string {
  return renderToStaticMarkup(
    createElement(ListView as any, { schema: getResultSchema(record.schemaId as any), results, alignedClaims: record.alignedClaims, gate: record.gate, synthesisReport: record.synthesisReport, trustSummary: record.trustSummary })
  );
}
const withSources = (record: Record<string, any>, sources: (string | undefined)[]) =>
  record.results.map((r: any) => (r.ok && r.data?.metrics ? { ...r, data: { ...r.data, metrics: sources.map((source, i) => ({ label: `M${i}`, value: i, unit: "x", asOf: "2026", ...(source === undefined ? {} : { source }) })) } } : r));

describe("MINOR 3: a marked ListView counts values that name a source, not citations", () => {
  const MISLEADING = /\bcitations?\b|\bcited\b|\bverified\b|\bsupport(?:ed|ing)? (?:by )?sources?\b/i;

  it("negative control: the a3416c37 wording ('N citations') on a marked record is flagged", () => {
    expect(MISLEADING.test("Claude trust 73% gave values in 4 value comparisons 4 citations")).toBe(true);
  });

  it("the same source named on several values: counted once per value, never 'citations'", async () => {
    const record = await build(scenario("financial-valuation")); // every metric's source is "est"
    const t = text(listText(record));
    expect(t).toContain("ChatGPT trust 100% gave values in 5 value comparisons 7 values with a named source");
    expect(text(listText(record, withSources(record, ["est", "est"])))).toContain("2 values with a named source");
    expect(t).not.toMatch(MISLEADING);
    expect(listText(record)).toContain(`title="${NAMED_SOURCE_VALUES_TITLE}"`);
    expect(NAMED_SOURCE_VALUES_TITLE).toMatch(/counts once per value, and sources are not checked/);
  });

  it("distinct sources, missing / placeholder sources, zero", async () => {
    const record = await build(scenario("financial-valuation"));
    expect(text(listText(record, withSources(record, ["IMF", "World Bank", "OECD"])))).toContain("3 values with a named source");
    expect(text(listText(record, withSources(record, ["IMF", "unknown", "none", "N/A", "", undefined])))).toContain("1 value with a named source");
    const zero = text(listText(record, withSources(record, ["unknown", undefined])));
    expect(zero).not.toMatch(/with a named source|citation/);
  });

  it("a named source that the value does not establish is still only 'named' (no support implied)", async () => {
    const record = await build(scenario("financial-valuation"));
    const t = text(listText(record, withSources(record, ["a blog post that disputes this figure"])));
    expect(t).toContain("1 value with a named source");
    expect(t).not.toMatch(MISLEADING);
  });

  it("factual record: the answer's source counts as one value", async () => {
    const record = await build(scenario("factual-tie"));
    const t = text(listText(record));
    expect(t).toContain("1 value with a named source");
    expect(t).not.toMatch(MISLEADING);
  });

  it("historical / unmarked records keep 'N citations' exactly", async () => {
    for (const name of ["financial-valuation", "factual-tie"]) {
      const record = await build(scenario(name));
      delete record.synthesisReport.presentation.disagreementPositionVersion;
      const t = text(listText(record));
      expect(t).toMatch(name === "factual-tie" ? /\b1 citation\b/ : /aligns 5\/5 disputes 1 claim \+1 unique claim 7 citations\b/);
      expect(t).not.toContain("with a named source");
    }
  });
});
