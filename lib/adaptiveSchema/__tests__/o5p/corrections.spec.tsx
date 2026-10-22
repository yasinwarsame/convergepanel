/**
 * Order 5 Contract P — bounded correction round (independent review of eae6c897: F-1, F-2, m-1 … m-7, n-1 … n-5).
 *
 * Each finding is asserted on the marked rendering of the shared scenarios (built by today's pipeline, every model call
 * mocked) or on the pure presenters, and each has a negative control: the same check run on the historical (unmarked)
 * rendering, or on the pre-correction behaviour, finds the defect — so no assertion here passes vacuously.
 *
 * Scenario row mix (o5pScenarios.ts): claim rows only — generic-*; field rows only — financial-valuation (metric),
 * procedural (step), forecast (scenario), factual-* (scalar); mixed — contested-empirical (claims + metric),
 * legal-regulatory (claim + scalar, gate fail).
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
import { AdaptiveRetryUsageSink } from "@/lib/adaptiveSchema/retryCorrection";
import {
  POSITION_ROWS_UNAVAILABLE,
  TOP_MAJORITY_HEADING,
  hasReadableRowBreakdown,
  positionView,
  presentPositionSafeReport,
  rowTypeOf,
  rowView,
  slotRowCounts,
} from "@/lib/adaptiveSchema/positionPresentation";
import { buildAdaptiveXPost, xFit, xWeightedLength, X_POST_LIMIT } from "@/lib/adaptiveSchema/shareBuilders";
import ListView from "@/components/adaptive/ListView";
import { CLASSIFICATION_BASE, DEFAULT_MODE, SCENARIOS, Scenario, geminiMockImpl } from "./o5pScenarios";
import { QUESTION, renderRecord, RecordUnderTest } from "./o5pRender";
import { sourceLiterals } from "./vocabularyScanner";
import { htmlText } from "./htmlText";

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

const text = htmlText;
/** The text of one data-section of a rendered page (up to the next data-section). */
const section = (html: string, name: string) => {
  const m = html.match(new RegExp(`data-section="${name}"[^>]*>([\\s\\S]*?)(?=<[^<>]*data-section=|$)`));
  return m ? text(m[1]) : "";
};
const FIELD = ["metric", "scenario", "step", "scalar"];
const fieldTexts = (record: any) => (record.alignedClaims ?? []).filter((r: any) => FIELD.includes(rowTypeOf(r.cells))).map((r: any) => r.claimText as string);
const claimTexts = (record: any) => (record.alignedClaims ?? []).filter((r: any) => rowTypeOf(r.cells) === "claim").map((r: any) => r.claimText as string);

// ─── Checkers (each is shown to fail on a bad input below) ──────────────────

/** The items listed under a claim-consensus heading in Markdown / LinkedIn / memo text. */
function itemsUnder(textOut: string, heading: RegExp): string[] {
  const lines = textOut.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const l of lines) {
    if (heading.test(l)) {
      inside = true;
      continue;
    }
    // A group's items follow its heading directly, one per line; the group ends at the first other line.
    if (inside && /^[-→] /.test(l)) out.push(l);
    else inside = false;
  }
  return out;
}

/** Field rows (by their claim text) listed under a claim-consensus heading: must be empty. */
function fieldRowsUnderClaimHeading(textOut: string, heading: RegExp, fields: string[]): string[] {
  return itemsUnder(textOut, heading).filter((l) => fields.some((f) => l.includes(`“${f}”`)));
}

describe("F-1: field rows are never listed or framed as claim consensus", () => {
  it("negative control: the checker finds a field row placed under the claim heading (the eae6c897 shape)", () => {
    const bad = "## Consensus and majority claims\n- **Claim:** “Revenue” — **Panel result:** Values differ: …\n\n## Next";
    expect(fieldRowsUnderClaimHeading(bad, /^## Consensus and majority claims$/, ["Revenue"])).toEqual(["- **Claim:** “Revenue” — **Panel result:** Values differ: …"]);
  });

  it.each(MARKED)("%s: no field row under a claim-consensus heading on any surface; the old mixed heading is gone", async (name) => {
    const { record, out } = await outputs(name);
    const fields = fieldTexts(record);
    for (const [k, v] of Object.entries(out)) if (v && k !== "export.json") expect([k, /Consensus and majority rows|CONSENSUS AND MAJORITY ROWS/.test(v)]).toEqual([k, false]);
    expect(fieldRowsUnderClaimHeading(out["text.markdown"]!, /^## Consensus and majority claims$/, fields)).toEqual([]);
    expect(fieldRowsUnderClaimHeading(out["text.linkedin"]!, /^Consensus and majority claims:$/, fields)).toEqual([]);
    expect(fieldRowsUnderClaimHeading(out["text.memo"]!, /^CONSENSUS AND MAJORITY CLAIMS$/, fields)).toEqual([]);
    // UI: the claim group holds no field row; every field row in the agree section is in the value-comparison group.
    const html = out["ui.synthesisView"]!;
    const claimGroup = html.match(/data-agree-group="claim"[\s\S]*?(?=data-agree-group=|data-section=|$)/)?.[0] ?? "";
    for (const f of fields) expect([f, text(claimGroup).includes(`“${f}”`)]).toEqual([f, false]);
    // No field row is labelled a claim anywhere on the page.
    for (const f of fields) expect([f, text(html).includes(`Claim: “${f}”`)]).toEqual([f, false]);
  });

  it("claim-only record: legitimate claim consensus is preserved (heading, Claim label, computed status)", async () => {
    const { out } = await outputs("generic-consensus");
    expect(section(out["ui.synthesisView"]!, "where-models-agree")).toMatch(/^.*Consensus and majority claims Claim: “[^”]+” Panel result: consensus: all \d dispatched models support it/);
    expect(out["text.markdown"]).toContain("## Consensus and majority claims\n- **Claim:**");
    expect(out["text.memo"]).toContain("CONSENSUS AND MAJORITY CLAIMS\n- Claim:");
    expect(out["text.markdown"]).not.toContain("## Value comparisons");
  });

  it("field-only record: value comparisons only — no claim-consensus heading, never 'Raised by only one model'", async () => {
    for (const name of ["procedural", "financial-valuation", "forecast"]) {
      const { record, out } = await outputs(name);
      const all = Object.entries(out).filter(([k, v]) => v && k !== "export.json").map(([, v]) => v as string).join("\n");
      expect([name, /Consensus and majority claims|CONSENSUS AND MAJORITY CLAIMS/.test(all)]).toEqual([name, false]);
      if (record.synthesisReport.presentation.agree.length > 0) expect([name, out["text.markdown"]!.includes("## Value comparisons\n- **Value comparison:**")]).toEqual([name, true]);
      expect([name, all.includes("Raised by only one model")]).toEqual([name, false]);
    }
  });

  it("mixed record: claims and value comparisons are kept apart under their own headings", async () => {
    const { record, out } = await outputs("contested-empirical");
    expect(fieldTexts(record)).toEqual(["Elasticity"]);
    const md = out["text.markdown"]!;
    expect(itemsUnder(md, /^## Consensus and majority claims$/).length).toBe(claimTexts(record).filter((c: string) => record.synthesisReport.presentation.agree.some((a: any) => a.claim === c)).length);
    expect(section(out["ui.synthesisView"]!, "load-bearing-claims")).toContain("Load-bearing claims and value comparisons (top by salience)");
    expect(section(out["ui.synthesisView"]!, "load-bearing-claims")).toContain("Value comparison: “Elasticity”");
  });

  it("single-source rows: a claim row is listed by slot label (no model chip); a field row is a value comparison in the map", async () => {
    const mixed = await outputs("generic-mixed");
    const single = section(mixed.out["ui.synthesisView"]!, "single-model-insights");
    expect(single).toContain("Single-source claims");
    expect(single).toMatch(/slot: (Supports|Partially supports|Disputes|Position unclear)/);
    expect(single).not.toContain("Raised by only one model");
    const singleHtml = mixed.out["ui.synthesisView"]!.match(/data-section="single-model-insights"[\s\S]*?(?=data-section=)/)![0];
    expect(singleHtml).not.toMatch(/h-2 w-2 shrink-0 rounded-full/); // ModelChip's identity dot
    const proc = await outputs("procedural");
    expect(section(proc.out["ui.synthesisView"]!, "single-model-insights")).toBe("");
    expect(section(proc.out["ui.synthesisView"]!, "agreement-disagreement-map")).toContain("Value comparison: “Step 3: Write a config file”");
  });

  it("negative control: the historical (unmarked) rendering still shows field rows under 'Where models agree' and as single-model insights", async () => {
    const { out } = await outputs("procedural", true);
    expect(section(out["ui.synthesisView"]!, "single-model-insights")).toContain("Raised by only one model in this run");
    expect(section(out["ui.synthesisView"]!, "single-model-insights")).toContain("Step 3: Write a config file");
    expect(section(out["ui.synthesisView"]!, "where-models-agree")).toContain("Where models agree");
  });

  it("n-5: a majority claim row is never headed 'Top consensus'", async () => {
    const { record, out } = await outputs("generic-splits");
    const top = record.alignedClaims!.find((r: any) => r.claimText === record.synthesisReport.verdictCard.topConsensus);
    expect(top.status).toBe("majority");
    const view = positionView(presentPositionSafeReport(record.synthesisReport, { rows: record.alignedClaims, roster: record.results.map((r: any) => r.modelId) }))!;
    expect(view.verdict.topHeading).toBe(TOP_MAJORITY_HEADING);
    expect(section(out["ui.synthesisView"]!, "panel-verdict")).not.toContain("Top consensus");
  });
});

// ─── F-2 ────────────────────────────────────────────────────────────────────

const ROSTER = ["chatgpt", "claude", "grok", "perplexity"];
const cc = (modelId: string, stance: string) => ({ modelId, stance, origin: { kind: "claim", field: "keyClaims" }, excerpt: `${modelId} wording` });
const fc = (modelId: string, action: string) => ({ modelId, stance: "agrees", origin: { kind: "field_derived", fieldType: "step" }, excerpt: action, raw: { order: 1, action } });
const R = (claimText: string, status: string, cells: unknown) => ({ id: claimText, claimText, status, cells, agreementScore: 0.5, certaintyScore: 0.5 });

describe("F-2: per-slot list counts — claim rows and value comparisons counted apart (display only)", () => {
  const claimRows = [
    R("A", "consensus", ROSTER.map((m) => cc(m, "agrees"))),
    R("B", "majority", [cc("chatgpt", "disputes"), cc("claude", "agrees"), cc("grok", "agrees"), null]),
    R("C", "split", [cc("chatgpt", "agrees"), cc("claude", "disputes"), null, null]), // a tie: no most common position
  ];
  const fieldRows = [R("Step 1", "consensus", [fc("chatgpt", "Install"), fc("claude", "Install"), fc("grok", "Configure firewall"), fc("perplexity", "Configure firewall")]), R("Step 2", "single_source", [null, null, fc("grok", "Reboot"), null])];

  it("claim-only: matches counted against the single most common validated position; a tie never matches", () => {
    expect(slotRowCounts("chatgpt", claimRows, ROSTER)).toEqual({ claimRows: 3, claimRowsMatching: 1, singleSourceClaims: 0, valueComparisons: 0 });
    expect(slotRowCounts("claude", claimRows, ROSTER)).toEqual({ claimRows: 3, claimRowsMatching: 2, singleSourceClaims: 0, valueComparisons: 0 });
  });

  it("field-only: value comparisons are counted as such — never as aligned claims, never as unique claims", () => {
    expect(slotRowCounts("grok", fieldRows, ROSTER)).toEqual({ claimRows: 0, claimRowsMatching: 0, singleSourceClaims: 0, valueComparisons: 2 });
  });

  it("mixed: both counts, each from its own rows", () => {
    expect(slotRowCounts("grok", [...claimRows, ...fieldRows], ROSTER)).toEqual({ claimRows: 2, claimRowsMatching: 2, singleSourceClaims: 0, valueComparisons: 2 });
  });

  it("missing row types and malformed rows count as neither; a record with no readable breakdown says so", () => {
    const noOrigin = R("D", "consensus", [{ modelId: "chatgpt", stance: "agrees" }]);
    const mixedOrigin = R("E", "consensus", [cc("chatgpt", "agrees"), fc("claude", "x")]);
    const malformed = [null, "row", R("F", "consensus", "not-an-array"), R("G", "consensus", [5, cc("chatgpt", "agrees")]), noOrigin, mixedOrigin];
    expect(slotRowCounts("chatgpt", malformed as unknown[], ROSTER)).toEqual({ claimRows: 0, claimRowsMatching: 0, singleSourceClaims: 0, valueComparisons: 0 });
    expect(hasReadableRowBreakdown(malformed as unknown[])).toBe(false);
    expect(hasReadableRowBreakdown([...malformed, claimRows[0]] as unknown[])).toBe(true);
  });

  it("duplicate entries collapse; a conflicting slot holds no position; a single source with another slot's conflicting entry is not single", () => {
    const dup = R("H", "consensus", [cc("chatgpt", "agrees"), cc("chatgpt", "agrees"), cc("claude", "agrees")]);
    expect(slotRowCounts("chatgpt", [dup], ROSTER)).toMatchObject({ claimRows: 1, claimRowsMatching: 1 });
    const conflict = R("I", "consensus", [cc("chatgpt", "agrees"), cc("chatgpt", "disputes"), cc("claude", "agrees")]);
    expect(slotRowCounts("chatgpt", [conflict], ROSTER)).toMatchObject({ claimRows: 0, claimRowsMatching: 0 });
    const single = R("J", "single_source", [cc("chatgpt", "agrees"), null, null, null]);
    expect(slotRowCounts("chatgpt", [single], ROSTER).singleSourceClaims).toBe(1);
    const notSingle = R("K", "single_source", [cc("chatgpt", "agrees"), { modelId: "claude", stance: "bogus", origin: { kind: "claim" } }, null, null]);
    expect(slotRowCounts("chatgpt", [notSingle], ROSTER).singleSourceClaims).toBe(0);
    const unattributable = R("L", "single_source", [cc("chatgpt", "agrees"), cc("someone-else", "agrees"), null, null]);
    expect(slotRowCounts("chatgpt", [unattributable], ROSTER).singleSourceClaims).toBe(0);
  });

  it("pure: frozen rows are read without mutation", () => {
    const deepFreeze = (o: any): any => (o && typeof o === "object" ? (Object.values(o).forEach(deepFreeze), Object.freeze(o)) : o);
    const rows = deepFreeze(JSON.parse(JSON.stringify([...claimRows, ...fieldRows])));
    const before = JSON.stringify(rows);
    for (const m of ROSTER) slotRowCounts(m, rows, ROSTER);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("procedural (field rows only): no 'aligns', no 'unique claim'; value comparisons per slot instead", async () => {
    const { out } = await outputs("procedural");
    const t = text(out["ui.listView"]!);
    expect(t).not.toMatch(/aligns \d+\/\d+/);
    expect(t).not.toMatch(/unique claim/);
    expect(t).not.toMatch(/same as the most common position/);
    expect(t).toMatch(/Grok trust \d+% gave values in \d value comparisons/);
    expect(t).toContain("Single-source claims 0");
  });

  it("factual-tie: no 'aligns 0/1' implying a panel answer", async () => {
    const { out } = await outputs("factual-tie");
    expect(text(out["ui.listView"]!)).not.toMatch(/aligns \d/);
  });

  it("claim rows: the claim count is stated as a claim count", async () => {
    const { out } = await outputs("generic-mixed");
    expect(text(out["ui.listView"]!)).toMatch(/ChatGPT trust \d+% same as the most common position on \d\/\d claim rows/);
  });

  it("a record without a readable breakdown: neutral wording only", () => {
    const rows = [R("M", "consensus", [{ modelId: "chatgpt", stance: "agrees" }, { modelId: "claude", stance: "agrees" }])];
    const report: any = { gate: "pass", runCertainty: 0.9, presentation: { disagreementPositionVersion: 1, agree: [], disagree: [], answer: { note: null, claims: [] } } };
    const html = renderToStaticMarkup(
      createElement(ListView as any, {
        schema: getResultSchema("generic" as any),
        results: ROSTER.slice(0, 2).map((modelId) => ({ modelId, ok: true, data: { summary: "s", keyClaims: [] }, latencyMs: 5 })),
        alignedClaims: rows,
        gate: { status: "pass" },
        synthesisReport: report,
      })
    );
    expect(text(html)).toContain("row counts unavailable");
    expect(text(html)).not.toMatch(/aligns|unique claim|same as the most common/);
  });

  it("negative control: the historical (unmarked) list view shows the reviewer's 'aligns 2/2' on the procedural record", async () => {
    const { out } = await outputs("procedural", true);
    expect(text(out["ui.listView"]!)).toMatch(/Grok trust \d+% aligns 2\/2/);
  });

  it("the stored trust summary and rows are not changed by rendering (computation untouched)", async () => {
    const { record, input } = await build(scenario("procedural"));
    const before = JSON.stringify({ t: record.trustSummary, a: record.alignedClaims, g: record.gate });
    await renderRecord(record, input);
    expect(JSON.stringify({ t: record.trustSummary, a: record.alignedClaims, g: record.gate })).toBe(before);
  });
});

// ─── m-1 ────────────────────────────────────────────────────────────────────

describe("m-1: marked X posts fit X's weighted 280 limit; the computed result is never cut", () => {
  it("weighted length: light code points 1, others 2, URLs 23, NFC-normalized (twitter-text v3); never string.length", () => {
    expect(xWeightedLength("abc")).toBe(3);
    expect(xWeightedLength("日本")).toBe(4);
    expect(xWeightedLength("😀")).toBe(2);
    expect(xWeightedLength("see https://example.com/a")).toBe(4 + 23);
    expect(xWeightedLength("convergepanel.com")).toBe(23);
    expect(xWeightedLength(`https://example.com/${"a".repeat(60)}`)).toBe(23); // H-1: a URL is 23 whatever its length
    expect(xWeightedLength("é")).toBe(1); // H-1: NFC "é", as X normalizes
    // Negative control: 200 CJK characters are 200 by string.length — within 280 — but weigh 400 on X.
    const cjk = "日".repeat(200);
    expect(cjk.length).toBeLessThanOrEqual(280);
    expect(xWeightedLength(cjk)).toBe(400);
  });

  it("xFit cuts at a grapheme boundary, within the budget", () => {
    const s = xFit("👨‍👩‍👧 family 👨‍👩‍👧 again 👨‍👩‍👧", 20);
    expect(xWeightedLength(s)).toBeLessThanOrEqual(20);
    expect(s.endsWith("…")).toBe(true);
    expect(s).not.toMatch(/‍…$/);
  });

  const QUESTIONS: [string, string][] = [
    ["plain", QUESTION],
    ["long", `${"Does raising the minimum wage reduce employment in the long run across regions and sectors? ".repeat(6)}`],
    ["cjk", "最低賃金の引き上げは雇用を減らしますか".repeat(12)],
    ["emoji", `Is 📈 good? ${"🤔".repeat(80)}`],
    ["urls", `Per https://example.com/${"x".repeat(80)} and www.convergepanel.com/research, does it reduce jobs?`],
  ];

  it.each(MARKED)("%s: within the limit for every question; brand kept; a shown result is whole; no slot named", async (name) => {
    const { record } = await build(scenario(name));
    const roster = record.results.map((r: any) => r.modelId);
    const view = presentPositionSafeReport(record.synthesisReport, { rows: record.alignedClaims, roster });
    for (const [label, q] of QUESTIONS) {
      const post = buildAdaptiveXPost(q, record.synthesisReport, { rows: record.alignedClaims, roster });
      expect([label, xWeightedLength(post) <= X_POST_LIMIT]).toEqual([label, true]);
      expect([label, post.endsWith("via ConvergePanel")]).toEqual([label, true]);
      const split = view.presentation!.disagree[0];
      if (post.includes(" — panel result: ")) {
        expect([label, post.split(" — panel result: ")[1].replace(/\n\nvia ConvergePanel$/, "")]).toEqual([label, split.result]);
      } else if (split) {
        expect([label, post]).toEqual([label, expect.stringContaining("unresolved row")]);
      }
      expect([label, /\b(ChatGPT|Claude|Grok|Perplexity|Gemini) slot\b|DeepSeek/.test(post)]).toEqual([label, false]);
      expect([label, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(post)]).toEqual([label, false]); // no lone surrogate
    }
  });

  it("a long model-written claim gives way, never the computed result", async () => {
    const { record } = await build(scenario("generic-mixed"));
    const roster = record.results.map((r: any) => r.modelId);
    const report = JSON.parse(JSON.stringify(record.synthesisReport));
    const longClaim = `${"Raising the minimum wage reduces teen employment in small firms ".repeat(5)}`.trim();
    const rows = record.alignedClaims!.map((r: any) => (r.claimText === report.disagreements[0].topic ? { ...r, claimText: longClaim } : r));
    report.disagreements[0].topic = longClaim;
    report.presentation.disagree[0].claim = longClaim;
    const post = buildAdaptiveXPost(QUESTION, report, { rows, roster });
    expect(xWeightedLength(post)).toBeLessThanOrEqual(X_POST_LIMIT);
    const result = presentPositionSafeReport(report, { rows, roster }).presentation!.disagree[0].result;
    expect(post).toContain(result);
    expect(post).toContain("…”");
  });
});

// ─── m-2 / m-3 ──────────────────────────────────────────────────────────────

describe("m-2 / m-3: statements disclose what could not be read", () => {
  it("m-2: a step row whose only cell has a conflicting duplicate does not say no step was given", () => {
    const row = R("Step 3", "single_source", [{ ...fc("chatgpt", "Write a config file"), stance: "agrees" }, { ...fc("chatgpt", "Write a config file"), stance: "disputes" }, null, null]);
    const v = rowView(row, ROSTER);
    expect(v.text).not.toContain("no step text was given");
    expect(v.text).toContain("Not comparable: no readable step text at this position; 1 panel slot with conflicting stored values."); // N-6: values, not positions
  });

  it("m-2: a scalar comparison with a conflicting duplicate states it in the comparison", () => {
    const sc = (m: string, v: string, stance = "agrees") => ({ modelId: m, stance, origin: { kind: "field_derived", fieldType: "scalar" }, excerpt: v });
    const row = R("Paris", "split", [sc("chatgpt", "Paris"), sc("claude", "Paris"), sc("grok", "Lyon"), sc("perplexity", "Lyon"), sc("perplexity", "Lyon", "disputes")]);
    const v = rowView(row, ROSTER);
    expect(v.text).toBe("Answers differ: 2 different answers; the most common was given by 2 of 3 panel slots (ignoring case and punctuation); 1 panel slot with conflicting stored values."); // N-6
  });

  it("m-2: a metric comparison keeps its trailing computed sentence after the disclosure", () => {
    const mc = (m: string, value: unknown) => ({ modelId: m, stance: "agrees", origin: { kind: "field_derived", fieldType: "metric" }, excerpt: String(value), raw: { value, unit: "x" } });
    const v = rowView(R("P/E", "majority", [mc("chatgpt", 10), mc("claude", 12), { ...mc("nobody", 11) }, null]), ROSTER);
    // The entry naming no slot sits at the Grok slot's index, so that slot reads as unreadable too (readSlots).
    expect(v.text).toBe("Values differ: 2 numeric values, 2 distinct, from 10 x to 12 x; 1 stored value could not be attributed to a panel slot; 1 value could not be read. A computed comparison of the stated values, not model positions."); // N-6
  });

  it("negative control: the same rows without the unreadable entries read as before", () => {
    const v = rowView(R("Step 3", "single_source", [fc("chatgpt", "Write a config file"), null, null, null]), ROSTER);
    expect(v.text).toBe("Only 1 panel slot gave a step at this position; there is nothing to compare it with.");
  });

  it("m-3: a single-source claim row with no readable position never reads 'only 0 of N'", () => {
    const v = rowView(R("Claim", "single_source", [cc("chatgpt", "agrees"), cc("chatgpt", "disputes"), null, null]), ROSTER);
    expect(v.text).not.toMatch(/only 0 of/);
    expect(v.text).toBe("single source: no readable, attributable position is recorded for this row; 1 panel slot with conflicting stored positions");
    const ok = rowView(R("Claim", "single_source", [cc("chatgpt", "agrees"), null, null, null]), ROSTER);
    expect(ok.text).toBe("single source: only 1 of 4 dispatched models raised it — not panel agreement");
  });
});

// ─── m-4 / m-5 / m-6 ────────────────────────────────────────────────────────

describe("m-4: the marked memo claims no more than the record holds", () => {
  it.each(["generic-substituted-and-failed", "factual-single", "generic-retry"])("%s", async (name) => {
    const { out } = await outputs(name);
    expect(out["text.memo"]).not.toMatch(/answered this question independently|identical instructions/);
    expect(out["text.memo"]).toMatch(/panel slots? (was|were) dispatched for this question/);
  });
});

describe("m-5: a gate-derived level on a marked report is labelled as the gate, never as consensus", () => {
  it.each(MARKED)("%s", async (name) => {
    const { out } = await outputs(name);
    for (const k of ["ui.panelResponse", "export.pdfTree", "export.docxXml"]) {
      expect([k, /(Strong|Moderate|Weak) consensus|Consensus reflects panel agreement/.test(out[k] ?? "")]).toEqual([k, false]);
    }
    expect(out["export.docxXml"]).toContain("The verification gate reflects computed checks on the scored rows");
  });

  it("negative control: the unmarked rendering still shows the consensus badge", async () => {
    const { out } = await outputs("generic-consensus", true);
    expect(out["ui.panelResponse"]).toMatch(/Strong consensus/);
    expect(out["export.docxXml"]).toMatch(/Strong consensus/);
  });
});

describe("m-6: field rows in the answer lead are value comparisons, not claims", () => {
  it("caution with a scalar load-bearing row", async () => {
    const { out } = await outputs("factual-tie");
    const t = text(out["ui.panelResponse"]!);
    expect(t).toContain("Unresolved load-bearing value comparison Value comparison: “Paris”");
    expect(t).not.toMatch(/Unresolved load-bearing claim|Claim: “Paris”/);
  });

  it("fail with a claim row and a scalar row: one mixed heading, each row labelled by what it is", async () => {
    const { out } = await outputs("legal-regulatory");
    const t = text(out["ui.panelResponse"]!);
    expect(t).toContain("Unresolved claims and value comparisons Claim: “The state statute preempts local ordinances”");
    expect(t).toContain("Value comparison: “U.S.”");
    expect(t).not.toContain("Claim: “U.S.”");
    expect(out["export.docxXml"]).not.toContain("Claim: “U.S.”");
  });

  it("negative control: the unmarked answer lead labels the scalar row a claim", async () => {
    const { out } = await outputs("factual-tie", true);
    expect(text(out["ui.panelResponse"]!)).toMatch(/Unresolved load-bearing claim|Claim: “Paris”/);
  });
});

// ─── m-7 ────────────────────────────────────────────────────────────────────

const SNIPPET = `import { x } from "agree-module";
// a comment about consensus
/* a block comment: models agree */
export function A({ a, b }: { a: number; b: number }) {
  const t = \`multi-line template
    where models disagree\`;
  return (
    <div>
      <p>
        Raised by only one model in this run — not corroborated or disputed by any other model.
      </p>
      <span>aligns {a}/{b}</span>
      {t}
    </div>
  );
}
`;

describe("m-7: the scanner reads the parsed source, not lines", () => {
  const lits = sourceLiterals(SNIPPET, "snippet.tsx");

  it("multi-line JSX text, JSX text beside an expression and multi-line templates are literals", () => {
    expect(lits).toContain(">Raised by only one model in this run — not corroborated or disputed by any other model.<");
    expect(lits).toContain(">aligns<");
    expect(lits).toContain("`multi-line template where models disagree`");
  });

  it("comments and import specifiers are not literals", () => {
    expect(lits.some((l) => /consensus|models agree/.test(l))).toBe(false);
    expect(lits).not.toContain('"agree-module"');
  });

  it("negative control: the previous line-based scan misses all three", () => {
    const LITERAL = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|>[^<>{}]+<)/g;
    const old = SNIPPET.split("\n").flatMap((line) => (/^\s*(\/\/|\*|\/\*|import )/.test(line) ? [] : [...line.matchAll(LITERAL)].map((m) => m[0].replace(/\s+/g, " "))));
    expect(old.some((l) => l.includes("Raised by only one model"))).toBe(false);
    expect(old.some((l) => /aligns/.test(l))).toBe(false);
    expect(old.some((l) => l.includes("where models disagree"))).toBe(false);
  });
});

// ─── NITs ───────────────────────────────────────────────────────────────────

describe("NITs addressed in this round", () => {
  it("n-1: without rows the reason says the rows are absent", async () => {
    const { record } = await build(scenario("generic-mixed"));
    const v = presentPositionSafeReport(record.synthesisReport, { rows: null, roster: record.results.map((r: any) => r.modelId) });
    expect(v.presentation!.answer.claims.every((c: any) => c.result === POSITION_ROWS_UNAVAILABLE)).toBe(true);
  });

  it("n-2: an unknown stored gate is never echoed into computed text", async () => {
    const { record } = await build(scenario("generic-mixed"));
    const report = { ...record.synthesisReport, gate: "mystery" };
    const v = presentPositionSafeReport(report, { rows: record.alignedClaims, roster: record.results.map((r: any) => r.modelId) });
    expect(v.certaintyAssessment).toContain("(gate: unrecognized)");
    expect(v.certaintyAssessment).not.toContain("mystery");
  });

  it("n-4: the marked claim matrix names columns by recorded slot, with the substitution", async () => {
    const { out } = await outputs("generic-substituted-and-failed");
    // Standalone panel evidence (its own boundary) and the full page both name the column by its recorded slot.
    for (const k of ["ui.panelEvidence", "ui.panelResponse"]) expect([k, /<th[^>]*>Claude slot \(substituted; answered by DeepSeek\)<\/th>/.test(out[k]!)]).toEqual([k, true]);
    // Negative control: the matrix rendered outside any marked boundary is the historical one, named by family.
    expect(out["ui.claimMatrix"]).toMatch(/<th[^>]*>Claude<\/th>/);
  });
});

describe("F-2 (related surface): the trust table's computed inputs are labelled for what they count", () => {
  it("marked: rows, not claims; the stored values are shown unchanged", async () => {
    const { record, out } = await outputs("procedural");
    const t = section(out["ui.synthesisView"]!, "trust-summary");
    expect(t).toContain("Items contributed");
    expect(t).toContain("Stance match"); // N-7: defined in the note
    expect(t).toContain("value comparisons included; these are not claim positions");
    expect(t).not.toMatch(/Majority align|\bClaims\b/);
    for (const m of record.trustSummary.perModel) expect(t).toContain(`${Math.round(m.majorityAlignment * 100)}%`);
  });

  it("negative control: the unmarked table keeps its historical labels", async () => {
    const { out } = await outputs("procedural", true);
    expect(section(out["ui.synthesisView"]!, "trust-summary")).toMatch(/Claims Majority align/);
  });
});
