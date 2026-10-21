/**
 * Order 5 Contract P — final hardening (owner: ORDER5_P_FINAL_HARDENING_AUTHORIZED_PR_WITHHELD). H-1 X weighted length,
 * H-2 substitution attribution, H-3 citation presentation, H-4 remaining findings (N-4 … N-8, m-7 vocabulary).
 *
 * H-1's reference values come from twitter-text 3.1.0 itself (`parseTweet`, default v3 configuration), recorded in
 * __fixtures__/xOracleCorpus.json with the package integrity hashes; the library is not a dependency. Every behaviour
 * change has a negative control: the a49f2172 behaviour, or the unmarked rendering, fails the same check.
 */
process.env.TZ = "UTC";

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
import { AdaptiveRetryUsageSink } from "@/lib/adaptiveSchema/retryCorrection";
import {
  presentPositionSafeReport,
  rowTypeOf,
  rowView,
  readSlots,
  markedSourceCountText,
  statementAfterHeading,
  NO_UNRESOLVED_ROW,
  substitutedSlotLabel,
  } from "@/lib/adaptiveSchema/positionPresentation";
import { buildAdaptiveXPost, markedXFallback, xFit, xPostFits, xWeightedLength, X_POST_LIMIT } from "@/lib/adaptiveSchema/shareBuilders";
import { parseXText, xUrlSpans } from "@/lib/adaptiveSchema/xWeightedText";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import { buildAdaptiveMemoInput } from "@/lib/adaptiveSchema/shareBuilders";
import { readFileSync } from "fs";
import { join } from "path";
import { CLASSIFICATION_BASE, DEFAULT_MODE, SCENARIOS, Scenario, geminiMockImpl } from "./o5pScenarios";
import { QUESTION, renderRecord, RecordUnderTest } from "./o5pRender";

const gem = callGemini as unknown as jest.Mock;

async function build(s: Scenario): Promise<{ record: RecordUnderTest & Record<string, any>; input: any[] }> {
  gem.mockReset();
  gem.mockImplementation(geminiMockImpl({ ...DEFAULT_MODE, ...(s.mode ?? {}) }));
  for (const k of Object.keys(connectorMap)) delete connectorMap[k];
  for (const r of s.retry ?? []) connectorMap[r.modelId] = jest.fn(async () => ({ modelId: r.modelId, status: "ok", rawText: JSON.stringify(r.data), latencyMs: 5 }));
  const input = s.results();
  const retryContext = s.retry ? { apiKeys: {}, promptOverrides: Object.fromEntries(input.map((r) => [r.modelId, "BASE PROMPT"])), context: null, budget: { startedAtMonoMs: 0, budgetMs: 300_000 }, usageSink: new AdaptiveRetryUsageSink(), now: () => 1_000 } : undefined;
  const classification = { ...CLASSIFICATION_BASE, queryType: s.schemaId, answerShape: getResultSchema(s.schemaId as any).renderHint } as any;
  const r: any = await finalizeAdaptiveRun(getResultSchema(s.schemaId as any), input, QUESTION, retryContext as any, classification);
  const record = r.persistedLegacyOutput
    ? JSON.parse(JSON.stringify({ ...r.persistedLegacyOutput, generatedAt: undefined }))
    : { schemaId: r.schemaId, classification, results: r.adaptiveResults, alignedClaims: r.alignedClaims, gate: r.gate, synthesisReport: r.synthesisReport, trustSummary: r.trustSummary };
  return { record, input };
}

const scenario = (name: string) => SCENARIOS.find((s) => s.name === name)!;
const MARKED = SCENARIOS.filter((s) => !["generic-all-failed", "creative", "graceful-limitation"].includes(s.name)).map((s) => s.name);
const outputs = async (name: string, unmark = false) => {
  const { record, input } = await build(scenario(name));
  if (unmark) delete record.synthesisReport.presentation.disagreementPositionVersion;
  return { record, input, out: await renderRecord(record, input) };
};

const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
/** The text of one data-section of a rendered page (up to the next data-section). */
const section = (html: string, name: string) => {
  const m = html.match(new RegExp(`data-section="${name}"[^>]*>([\\s\\S]*?)(?=<[^<>]*data-section=|$)`));
  return m ? text(m[1]) : "";
};
const FIELD = ["metric", "scenario", "step", "scalar"];
const fieldTexts = (record: any) => (record.alignedClaims ?? []).filter((r: any) => FIELD.includes(rowTypeOf(r.cells))).map((r: any) => r.claimText as string);
const claimTexts = (record: any) => (record.alignedClaims ?? []).filter((r: any) => rowTypeOf(r.cells) === "claim").map((r: any) => r.claimText as string);


const SUB = { status: "substituted", provider: "deepseek", requestedModel: "deepseek-chat", substitutedFrom: "anthropic:claude-model-1", substitutionReason: "timeout" };
/** The scenario with its Claude slot answered by a substitute (DeepSeek), recorded as such in the result row. */
const substituted = (name: string): Scenario => {
  const s = scenario(name);
  return { ...s, name: `${name}+sub`, results: () => s.results().map((r: any) => (r.modelId === "claude" && r.status !== "error" ? { ...r, ...SUB } : r)) };
};

// ─── H-1: X weighted length ─────────────────────────────────────────────────

/** The a49f2172 counter (m-1), kept here only as the negative control: a URL-like token swallowed what followed it. */
function legacyA49Weight(text: string): number {
  const LIGHT: [number, number][] = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
  const cw = (cp: number) => (LIGHT.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2);
  const raw = (t: string) => {
    let w = 0;
    let last = 0;
    for (const m of t.matchAll(/(?:https?:\/\/)?(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?:\/\S*)?/gu)) {
      const at = m.index ?? 0;
      for (const ch of t.slice(last, at)) w += cw(ch.codePointAt(0)!);
      let own = 0;
      for (const ch of m[0]) own += cw(ch.codePointAt(0)!);
      w += Math.max(23, own);
      last = at + m[0].length;
    }
    for (const ch of t.slice(last)) w += cw(ch.codePointAt(0)!);
    return w;
  };
  return Math.max(raw(text), raw(text.normalize("NFC")));
}

const corpus: { meta: Record<string, unknown>; cases: { text: string; weightedLength: number; valid: boolean }[] } = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "xOracleCorpus.json"), "utf8")
);

describe("H-1: X weighted length follows twitter-text v3 (oracle: twitter-text 3.1.0 parseTweet)", () => {
  it("the recorded oracle is twitter-text 3.1.0 / twemoji-parser 11.0.2 / punycode 1.4.1, by integrity", () => {
    expect(corpus.meta.oracle).toEqual({
      "twitter-text": "3.1.0 sha512-nulfUi3FN6z0LUjYipJid+eiwXvOLb8Ass7Jy/6zsXmZK3URte043m8fL3FyDzrK+WLpyqhHuR/TcARTN/iuGQ==",
      "twemoji-parser": "11.0.2 sha512-5kO2XCcpAql6zjdLwRwJjYvAZyDy3+Uj7v1ipBzLthQmDL7Ce19bEqHr3ImSNeoSW2OA8u02XmARbXHaNO8GhA==",
      punycode: expect.stringMatching(/^1\.4\.1 sha512-/),
    });
    expect(corpus.cases.length).toBeGreaterThan(500);
  });

  it("every corpus case: weighted length and validity exactly as the oracle", () => {
    const wrong = corpus.cases.filter((c) => { const p = parseXText(c.text); return p.weightedLength !== c.weightedLength || p.valid !== c.valid; });
    expect(wrong.map((c) => [c.text.slice(0, 60), c.weightedLength, parseXText(c.text).weightedLength])).toEqual([]);
  });

  // Oracle values (twitter-text 3.1.0) for the twelve required cases.
  const W: [string, string, number][] = [
    ["1 short URL", "see a.co", 27],
    ["2 long URL", `https://example.com/${"a".repeat(200)}`, 23],
    ["3 multiple URLs", "a.co b.co https://c.co/x www.example.org/path", 95],
    ["4 URL at the end", "read more at example.com", 36],
    ["5 URL then a full stop", "example.com.", 24],
    ["5 URL in punctuation", '(example.com), "example.com"…', 54],
    ["5 reviewer input (URL then dots)", 'Asked a multi-model AI panel: "a.co/xx........ b.co/y........ …"', 98],
    ["6 CJK", "日本語のテキスト", 16],
    ["6 NFC", "é", 1],
    ["6 URL inside CJK", "例子example.com中文", 31],
    ["7 emoji", "😀", 2],
    ["7 ZWJ family", "👨‍👩‍👧‍👦", 2],
    ["7 flags", "🏳️‍🌈🇫🇷", 4],
    ["7 skin tone", "👍🏽", 2],
    ["7 keycap", "1️⃣", 2],
    ["7 © ® are not emoji here", "©®", 2],
    ["t.co", "https://t.co/abcdefghij", 23],
  ];
  it.each(W)("%s", (_n, t, w) => expect(xWeightedLength(t)).toBe(w));

  it("9 exactly 280 is valid; 281 is not (URL and plain)", () => {
    const at280 = `${"x".repeat(256)} https://example.com/${"z".repeat(90)}`;
    expect([xWeightedLength(at280), xPostFits(at280)]).toEqual([280, true]);
    expect([xWeightedLength(`x${at280}`), xPostFits(`x${at280}`)]).toEqual([281, false]);
    expect([xPostFits("x".repeat(280)), xPostFits("x".repeat(281))]).toEqual([true, false]);
    expect(at280.length).toBeGreaterThan(280); // string.length would reject a valid post
  });

  it("invalid characters make a post invalid; empty is invalid", () => {
    expect([xPostFits("a﻿b"), xPostFits("")]).toEqual([false, false]);
  });

  it("negative control: the a49f2172 counter under-counts the reviewer's input and a closing quote after a URL", () => {
    const reviewer = 'Asked a multi-model AI panel: "a.co/xx........ b.co/y........ …"';
    expect(legacyA49Weight(reviewer)).toBeLessThan(98);
    expect(xWeightedLength(reviewer)).toBe(98);
    const quoted = '"see example.com/path"';
    expect(legacyA49Weight(quoted)).toBeLessThan(xWeightedLength(quoted));
    // and on the committed corpus it is below the oracle somewhere
    expect(corpus.cases.some((c) => legacyA49Weight(c.text) < c.weightedLength)).toBe(true);
  });

  it("xFit never cuts inside a URL and never turns a cut word into a different link", () => {
    const t = "Per https://example.com/a/long/path/to/a/study and example.community notes, wages rise";
    for (let b = 1; b <= 90; b += 1) {
      const out = xFit(t, b);
      expect([b, xWeightedLength(out) <= b]).toEqual([b, true]);
      const orig = new Set(xUrlSpans(t).map((u) => `${u.start}|${u.url}`));
      for (const u of xUrlSpans(out)) expect([b, orig.has(`${u.start}|${u.url}`)]).toEqual([b, true]);
    }
    // "example.community" cut to "example.com…" would be a new link: never produced
    for (let b = 1; b <= 90; b += 1) expect(xFit(t, b)).not.toMatch(/example\.com(?![/m])/);
  });

  const QUESTIONS: [string, string][] = [
    ["10 over-limit", "Does raising the minimum wage reduce employment in the long run across regions and sectors? ".repeat(8)],
    ["reviewer", "a.co/xx........ b.co/y........ ".repeat(6)],
    ["url at end", `Is this right? https://example.com/${"p".repeat(120)}`],
    ["urls + cjk", "例子example.com中文 ".repeat(10)],
    ["emoji", `Is 📈 good? ${"👨‍👩‍👧‍👦".repeat(60)}`],
    ["url then quote", 'What does "example.com/path" say?'],
  ];
  const CLAIMS = ["", `Raising the minimum wage reduces employment per https://example.com/study [1] and doi.org/10.1000/xyz ${"evidence ".repeat(20)}`];

  it.each(MARKED)("%s: every post is valid on X, URLs whole, result whole, brand kept, no slot named", async (name) => {
    const { record } = await build(scenario(name));
    const roster = record.results.map((r: any) => r.modelId);
    for (const claim of CLAIMS) {
      const report = JSON.parse(JSON.stringify(record.synthesisReport));
      let rows = record.alignedClaims;
      if (claim && report.presentation?.disagree?.[0]) {
        const old = report.presentation.disagree[0].claim;
        rows = (rows ?? []).map((r: any) => (r.claimText === old ? { ...r, claimText: claim } : r));
        for (const d of report.disagreements) if (d.topic === old) d.topic = claim;
        report.presentation.disagree[0].claim = claim;
      }
      const view = presentPositionSafeReport(report, { rows, roster });
      for (const [label, q] of QUESTIONS) {
        const post = buildAdaptiveXPost(q, report, { rows, roster });
        const id = `${label}/${claim ? "long claim" : "stored claim"}`;
        expect([id, xPostFits(post)]).toEqual([id, true]);
        expect([id, post.endsWith("via ConvergePanel")]).toEqual([id, true]);
        const allowed = new Set([q, view.presentation?.disagree[0]?.claim ?? "", view.presentation?.disagree[0]?.result ?? ""].flatMap((t) => xUrlSpans(t.normalize("NFC").replace(/\s+/g, " ").trim()).map((u) => u.url)));
        for (const u of xUrlSpans(post.normalize("NFC"))) expect([id, u.url, allowed.has(u.url)]).toEqual([id, u.url, true]);
        const split = view.presentation?.disagree[0];
        if (post.includes(" — panel result: ")) expect([id, post.split(" — panel result: ")[1].replace(/\n\nvia ConvergePanel$/, "")]).toEqual([id, split!.result]);
        expect([id, /\b(ChatGPT|Claude|Grok|Perplexity|Gemini|DeepSeek)\b/.test(post)]).toEqual([id, false]);
        expect([id, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(post)]).toEqual([id, false]);
      }
    }
  });

  it("8 substituted slot: the post names neither the requested model nor the substitute (no attribution to get wrong)", async () => {
    const { record } = await build(scenario("generic-substituted-and-failed"));
    const roster = record.results.map((r: any) => r.modelId);
    const post = buildAdaptiveXPost(QUESTION, record.synthesisReport, { rows: record.alignedClaims, roster });
    expect(xPostFits(post)).toBe(true);
    expect(post).not.toMatch(/Claude|DeepSeek|substitut/i);
  });

  it("11 long claim with citations: the claim gives way whole-URL-first; the computed result is never cut", async () => {
    const { record } = await build(scenario("generic-mixed"));
    const roster = record.results.map((r: any) => r.modelId);
    const report = JSON.parse(JSON.stringify(record.synthesisReport));
    const longClaim = `Teen employment falls (see https://example.com/${"s".repeat(40)} [1], doi.org/10.1000/abc [2]) ${"in small firms ".repeat(6)}`.trim();
    const old = report.presentation.disagree[0].claim;
    const rows = record.alignedClaims!.map((r: any) => (r.claimText === old ? { ...r, claimText: longClaim } : r));
    for (const d of report.disagreements) if (d.topic === old) d.topic = longClaim;
    report.presentation.disagree[0].claim = longClaim;
    const post = buildAdaptiveXPost(QUESTION, report, { rows, roster });
    const result = presentPositionSafeReport(report, { rows, roster }).presentation!.disagree[0].result;
    expect(xPostFits(post)).toBe(true);
    expect(post).toContain(result);
    expect(post).not.toMatch(/https:\/\/example\.com\/s{1,39}[^s]/); // the cited URL is whole or absent
  });

  it("12 safe fallback: always a valid post, only computed and fixed text", () => {
    for (const gate of ["Verification gate: Pass · Certainty: 100%", "Verification gate: Caution (verify before relying on it) · Certainty: 0%", "Certainty: 55% (gate: unrecognized)"]) {
      const f = markedXFallback(gate);
      expect([gate, xPostFits(f), f]).toEqual([gate, true, `Asked a multi-model AI panel\n\n${gate}\n\nvia ConvergePanel`]);
    }
  });

  it("unmarked X post is unchanged (historical path untouched)", async () => {
    const { record } = await build(scenario("generic-mixed"));
    delete record.synthesisReport.presentation.disagreementPositionVersion;
    const post = buildAdaptiveXPost(QUESTION, record.synthesisReport);
    expect(post).toContain("Models split on: ");
  });
});

// ─── H-2: substitution attribution ──────────────────────────────────────────

/** Each "Claude" in rendered text that is not followed, within the same item, by its recorded substitution. */
function unlabelledClaude(t: string): string[] {
  const out: string[] = [];
  const re = /Claude/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const after = t.slice(m.index, m.index + 140);
    if (/^Claude slot \(substituted; answered by DeepSeek\)/.test(after)) continue;
    if (/^Claude(?: [^\s]+){0,6}? Claude slot \(substituted; answered by DeepSeek\)/.test(after)) continue; // chip, then its note
    if (/^Claude · requested: deepseek-chat · substituted/.test(after) || /^Claude Claude requested: deepseek-chat/.test(after) || /^Claude requested: deepseek-chat/.test(after)) continue; // provenance label
    out.push(t.slice(Math.max(0, m.index - 40), m.index + 50));
  }
  return out;
}

const UI_WITH_PROVENANCE = ["ui.panelResponse", "ui.synthesisView", "ui.listView", "ui.panelEvidence", "ui.governance"];

describe("H-2: a substituted slot is never named as the author of the substitute's response", () => {
  it("negative control: the checker flags an unlabelled slot name", () => {
    expect(unlabelledClaude("Trust Claude 86% 5")).toHaveLength(1);
    expect(unlabelledClaude("Claude slot (substituted; answered by DeepSeek): Summary.")).toHaveLength(0);
  });

  it.each(MARKED.filter((n) => !["generic-all-failed"].includes(n)))("%s with the Claude slot substituted: every UI surface with provenance", async (name) => {
    const s = substituted(name);
    const { record, input } = await build(s);
    if (!input.some((r: any) => r.status === "substituted")) return;
    const out = await renderRecord(record, input);
    for (const k of UI_WITH_PROVENANCE) if (out[k]) expect([k, unlabelledClaude(text(out[k]!))]).toEqual([k, []]);
  });

  it("negative control: the same record unmarked still names the slot by family (historical rendering unchanged)", async () => {
    const { record, input } = await build(substituted("contested-empirical"));
    delete record.synthesisReport.presentation.disagreementPositionVersion;
    const out = await renderRecord(record, input);
    expect(unlabelledClaude(text(out["ui.panelResponse"]!)).length).toBeGreaterThan(0);
  });

  it("without recorded provenance nothing is invented: no substitute is named", async () => {
    const { record, input } = await build(substituted("contested-empirical"));
    const out = await renderRecord(record, input);
    expect(text(out["ui.panelResponse.noProvenance"]!)).not.toContain("answered by DeepSeek");
  });

  it("substitutedSlotLabel: only for a slot whose recorded provenance says substituted", () => {
    const prov: any[] = [{ modelId: "claude", substituted: true, provider: "deepseek" }, { modelId: "chatgpt", substituted: false, provider: "openai" }];
    expect(substitutedSlotLabel("claude", prov)).toBe("Claude slot (substituted; answered by DeepSeek)");
    expect(substitutedSlotLabel("chatgpt", prov)).toBeNull();
    expect(substitutedSlotLabel("claude", null)).toBeNull();
    expect(substitutedSlotLabel("claude", [{ modelId: "claude", substituted: true, provider: null } as any])).toBe("Claude slot (substituted; answered by provider not recorded)");
  });
});

// ─── H-3: citation presentation ─────────────────────────────────────────────

describe("H-3: no source count or column implies support that was not established", () => {
  it.each(["factual-tie", "procedural", "financial-valuation", "generic-mixed", "contested-empirical"])("%s: marked source count is the stored count, stated for what it counts", async (name) => {
    const { record, out } = await outputs(name);
    const d = record.synthesisReport.diagnostics;
    const t = text(out["ui.synthesisView"]!);
    expect(t).not.toContain("claims cite a source");
    if (d.totalClaimCount > 0) expect(t).toContain(markedSourceCountText(d.citedClaimCount, d.totalClaimCount));
    expect(t).not.toMatch(/>Citations</);
    expect(out["ui.synthesisView"]).toContain(">Sources named<");
    expect(t).toContain("which is not checked; 100% when the schema asks for no source");
  });

  it("negative control: unmarked keeps 'claims cite a source' and the Citations column", async () => {
    const { out } = await outputs("factual-tie", true);
    expect(text(out["ui.synthesisView"]!)).toMatch(/Citations: 0 of 1 claims cite a source/);
    expect(out["ui.synthesisView"]).toContain(">Citations<");
  });

  it("the stored diagnostics and trust values are not changed by rendering", async () => {
    const { record, input } = await build(scenario("financial-valuation"));
    const before = JSON.stringify({ d: record.synthesisReport.diagnostics, t: record.trustSummary });
    await renderRecord(record, input);
    expect(JSON.stringify({ d: record.synthesisReport.diagnostics, t: record.trustSummary })).toBe(before);
  });
});

// ─── H-4: remaining findings ────────────────────────────────────────────────

describe("N-4: the marked memo never throws on malformed input", () => {
  it("malformed group items, findings, question and slots: no throw, string items kept", async () => {
    const { record } = await build(scenario("generic-mixed"));
    const roster = record.results.map((r: any) => r.modelId);
    const input: any = buildAdaptiveMemoInput(QUESTION, record.synthesisReport, roster, "run", null, record.alignedClaims);
    const bad = { ...input, question: 5, adaptiveAgreeGroups: [{ heading: "Consensus and majority claims", items: [1, null, {}, "kept item"] }, { heading: 7, items: ["x"] }, null], keyFindings: [1, "f"], synthesisDisagreements: [{}], modelsUsed: [null, "chatgpt"] };
    let memo = "";
    expect(() => (memo = generateVerificationMemo(bad))).not.toThrow();
    expect(memo).toContain("kept item");
    expect(memo).not.toContain("[object Object]");
  });
});

describe("N-5: empty top / key slots on records without claim rows are headed as rows", () => {
  it.each(["procedural", "forecast", "factual-tie", "factual-normalizer"])("%s: no 'Key unresolved claim' / 'Top consensus' heading", async (name) => {
    const { out } = await outputs(name);
    for (const k of ["ui.panelResponse", "ui.synthesisView", "ui.primaryStrip", "export.docxXml", "export.pdfTree", "text.markdown"]) {
      const v = out[k];
      if (!v) continue;
      expect([k, /Key unresolved claim|Top consensus\b|Top claim and key unresolved claim/.test(k.startsWith("ui.") ? text(v) : v)]).toEqual([k, false]);
    }
  });

  it("negative control: a claim-only record keeps its claim headings", async () => {
    const { record } = await build(scenario("generic-consensus"));
    const view = positionViewOf(record);
    expect(view.verdict.keyHeading).toMatch(/claim|Recorded opposing|Unresolved/i);
    expect(view.verdict.noKeyText).not.toBe(NO_UNRESOLVED_ROW);
  });
});

function positionViewOf(record: any) {
  const roster = record.results.map((r: any) => r.modelId);
  const v: any = presentPositionSafeReport(record.synthesisReport, { rows: record.alignedClaims, roster });
  return (Object.getOwnPropertySymbols(v).map((s) => v[s]).find((x) => x && x.verdict) ?? {}) as any;
}

describe("N-6: value comparisons disclose values, not positions", () => {
  const cell = (modelId: string, value: number, stance = "agrees") => ({ modelId, stance, origin: { kind: "field_derived", fieldType: "metric" }, raw: { label: "p", value, unit: "%" } });
  it("conflicting cells on a value row are 'conflicting stored values'", () => {
    const row = { id: "r", claimText: "P(soft landing)", status: "split", agreementScore: 0, cells: [cell("chatgpt", 45), { ...cell("chatgpt", 45), stance: "disputes" }, cell("claude", 50), null] };
    const v = rowView(row as any, ["chatgpt", "claude", "grok", "perplexity"], null)!;
    expect(v.text).toContain("1 panel slot with conflicting stored values");
    expect(v.text).not.toContain("conflicting stored positions");
  });
  it("same-stance duplicates with different values: the first is shown and that is disclosed", () => {
    const row = { id: "r", claimText: "P(soft landing)", status: "split", agreementScore: 0, cells: [cell("chatgpt", 45), cell("chatgpt", 99), cell("claude", 50), null] };
    const v = rowView(row as any, ["chatgpt", "claude", "grok", "perplexity"], null)!;
    expect(v.text).toContain("1 panel slot with more than one stored value (the first is shown)");
    expect(readSlots(row.cells, ["chatgpt"]).slots[0]).toMatchObject({ kind: "position", moreStoredValues: true });
  });
  it("negative control: identical duplicates are not flagged; claim rows keep 'positions'", () => {
    const row = { id: "r", claimText: "P", status: "split", agreementScore: 0, cells: [cell("chatgpt", 45), cell("chatgpt", 45), cell("claude", 50), null] };
    expect(rowView(row as any, ["chatgpt", "claude", "grok", "perplexity"], null)!.text).not.toContain("more than one stored value");
  });
});

describe("N-8: no repeated prefixes", () => {
  it("statementAfterHeading drops a repeated heading only", () => {
    expect(statementAfterHeading("Consensus", "consensus: all 5 dispatched models support it")).toBe("all 5 dispatched models support it");
    expect(statementAfterHeading("Values differ", "Values differ: 3 numeric values")).toBe("3 numeric values");
    expect(statementAfterHeading("Values match", "All 3 numeric values are identical.")).toBe("All 3 numeric values are identical.");
  });
  it.each(MARKED)("%s: no 'X: x:' repeated prefix and no 'All 2' on marked UI", async (name) => {
    const { out } = await outputs(name);
    for (const k of UI_WITH_PROVENANCE) {
      if (!out[k]) continue;
      const t = text(out[k]!);
      expect([k, t.match(/\b(Consensus|Majority|Single source|Limited coverage|Values differ|Position details unavailable|Split): \1:/i)?.[0] ?? null]).toEqual([k, null]);
      expect([k, /\bAll 2 panel slots\b/.test(t)]).toEqual([k, false]);
    }
  });
});

it("guard: rowTypeOf is the row-kind source these checks rely on", () => expect(rowTypeOf([{ modelId: "a", stance: "agrees", origin: { kind: "claim" } }])).toBe("claim"));
