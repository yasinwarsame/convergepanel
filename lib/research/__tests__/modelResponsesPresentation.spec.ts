/**
 * Saved-response and comparison presentation (2026-11-11): the pure table and count helpers.
 */
import {
  buildComparisonTable,
  comparisonEntryText,
  modelResponsesCountLines,
  partitionModelResponses,
  summarizeModelResponses,
} from "@/lib/research/modelResponsesPresentation";
import { SAVED_COPY_MISSING, SAVED_COPY_RETRIED_INCLUDED, SAVED_COPY_UNSTRUCTURED } from "@/lib/adaptiveSchema/savedCopyNotice";
import type { AdaptiveModelResult, ComparisonCell } from "@/lib/adaptiveSchema/types";

const c = (subject: string, attribute: string, value: string, verdict?: ComparisonCell["verdict"]): ComparisonCell => ({ subject, attribute, value, ...(verdict ? { verdict } : {}) });

describe("buildComparisonTable", () => {
  it("rows and columns in first-appearance order; every cell in its position with its exact verdict", () => {
    const t = buildComparisonTable([c("B", "y", "1", "worse"), c("A", "x", "2", "better"), c("B", "x", "3"), c("A", "y", "4", "even")]);
    expect(t.subjects).toEqual(["B", "A"]);
    expect(t.attributes).toEqual(["y", "x"]);
    expect(t.entries).toEqual([
      [[{ value: "1", verdict: "worse" }], [{ value: "3" }]],
      [[{ value: "4", verdict: "even" }], [{ value: "2", verdict: "better" }]],
    ]);
    expect(t.cellCount).toBe(4);
  });

  it("a repeated position keeps every entry, in input order", () => {
    const t = buildComparisonTable([c("A", "x", "first", "better"), c("A", "x", "second", "worse")]);
    expect(t.entries[0][0].map(comparisonEntryText)).toEqual(["first (Better)", "second (Worse)"]);
    expect(t.cellCount).toBe(2);
  });

  it("a cell without a subject or attribute is kept as unpaired, never dropped and never given a position", () => {
    const t = buildComparisonTable([c("A", "x", "1"), c("", "x", "2"), c("A", "  ", "3", "even")]);
    expect(t.subjects).toEqual(["A"]);
    expect(t.attributes).toEqual(["x"]);
    expect(t.unpaired.map((u) => u.value)).toEqual(["2", "3"]);
    expect(t.cellCount).toBe(3);
  });

  it("exact strings: differently written subjects are separate rows (nothing merged or renamed)", () => {
    expect(buildComparisonTable([c("Carbon Taxes", "x", "1"), c("Carbon taxes", "x", "2")]).subjects).toEqual(["Carbon Taxes", "Carbon taxes"]);
  });

  it("is deterministic", () => {
    const cells = [c("B", "y", "1"), c("A", "x", "2"), c("A", "x", "3")];
    expect(buildComparisonTable(cells)).toEqual(buildComparisonTable(cells.map((x) => ({ ...x }))));
  });

  it("value (Verdict); value alone without a verdict", () => {
    expect(comparisonEntryText({ value: "High", verdict: "better" })).toBe("High (Better)");
    expect(comparisonEntryText({ value: "High", verdict: "even" })).toBe("High (Even)");
    expect(comparisonEntryText({ value: "High" })).toBe("High");
  });
});

const res = (modelId: string, over: Partial<AdaptiveModelResult> = {}): AdaptiveModelResult =>
  ({ modelId, schemaId: "comparison_matrix", ok: true, data: { cells: [] }, ...over }) as AdaptiveModelResult;
const failed = (modelId: string, parseError: string, over: Partial<AdaptiveModelResult> = {}) => res(modelId, { ok: false, data: null, parseError, ...over });

describe("summarizeModelResponses / modelResponsesCountLines", () => {
  it("each slot is counted once, from its recorded status", () => {
    const results = [
      res("chatgpt"),
      failed("claude", SAVED_COPY_RETRIED_INCLUDED),
      failed("grok", SAVED_COPY_UNSTRUCTURED, { savedResponseText: "text" }),
      failed("perplexity", "Invalid JSON: x"),
      failed("gemini", "Empty response"),
    ];
    const statuses = new Map([["chatgpt", "ok"], ["claude", "ok"], ["grok", "substituted"], ["perplexity", "ok"], ["gemini", "timeout"]]);
    const s = summarizeModelResponses(results, statuses);
    expect(s).toEqual({ requested: 5, answered: 4, substituted: 1, didNotRespond: 1, structuredShown: 1, savedTextShown: 1, savedCopyUnavailable: 1, unusable: 1 });
    expect(modelResponsesCountLines(s)).toEqual([
      "5 models requested · 4 answered (1 by a substitute model) · 1 did not respond",
      "1 structured response shown · 1 shown as saved text · 1 saved copy can't be shown · 1 answered in a format that couldn't be used",
    ]);
    const { cards, notes } = partitionModelResponses(results, statuses);
    expect(cards.map((r) => r.modelId)).toEqual(["chatgpt", "grok"]);
    expect(notes.map((r) => r.modelId)).toEqual(["claude", "perplexity", "gemini"]);
  });

  it("without recorded statuses, only the validator's empty-response slot with no saved text is a non-response", () => {
    const s = summarizeModelResponses([res("chatgpt"), failed("gemini", "Empty response"), failed("claude", SAVED_COPY_MISSING)], null);
    expect([s.answered, s.didNotRespond, s.savedCopyUnavailable]).toEqual([2, 1, 1]);
  });

  it("a recorded failure is never an answer, whatever the result carries", () => {
    const s = summarizeModelResponses([res("chatgpt", { savedResponseText: "x" })], new Map([["chatgpt", "error"]]));
    expect([s.answered, s.didNotRespond, s.structuredShown]).toEqual([0, 1, 0]);
    expect(partitionModelResponses([res("chatgpt", { savedResponseText: "x" })], new Map([["chatgpt", "error"]])).cards).toEqual([]);
  });

  it("plural forms", () => {
    expect(modelResponsesCountLines(summarizeModelResponses([res("chatgpt")], null))).toEqual(["1 model requested · 1 answered", "1 structured response shown"]);
    expect(modelResponsesCountLines(summarizeModelResponses([failed("a", SAVED_COPY_MISSING), failed("b", SAVED_COPY_MISSING)], null))[1]).toBe(
      "0 structured responses shown · 2 saved copies can't be shown"
    );
  });

  it("text is never inspected: a 'mock response' mention is an ordinary answer", () => {
    const s = summarizeModelResponses([res("claude", { data: { directConclusion: "Mock response servers are cheap." }, savedResponseText: "mock response" })], new Map([["claude", "ok"]]));
    expect([s.answered, s.structuredShown]).toEqual([1, 1]);
  });
});
