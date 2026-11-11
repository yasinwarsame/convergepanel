/**
 * Order 35 A (F-1, owner ruling): the research memo states the verified count of independent executing models that
 * returned a successful response — never the requested slot count, never a stored count, never an inferred identity.
 *   0 → no model responses; consensus cannot be assessed; no score.
 *   1 → one model answered; no multi-model agreement; no score.
 *   ≥2 → agreement wording and the stored score, with the verified count.
 * The stored record, the score in the memo input and every decision field stay as stored (presentation only).
 */

import { readFileSync } from "fs";
import { join } from "path";
import { buildAdaptiveMemoInput } from "@/lib/adaptiveSchema/shareBuilders";
import { answeringIndependentModelCount } from "@/lib/adaptiveSchema/verdictIndependence";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import { runModelProvenanceFromResultRow, type RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";
import { withPlaceholderFact } from "@/lib/panel/executionIdentity";

const records: Record<string, any> = JSON.parse(
  readFileSync(join(__dirname, "..", "adaptiveSchema", "__tests__", "o5p", "__fixtures__", "baseline-2c17fee", "records.json"), "utf8")
);
const ROSTER = ["chatgpt", "claude", "grok", "perplexity", "gemini"] as const;
const PROVIDER: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" };
const GENUINE = "Employment effects are small at moderate increases.";
const MOCK_DISCUSSION = "The vendor's demo returned a mock response instead of live data, so the study excluded it.";

type Row = { modelId: string; status: string; provider?: string; rawText?: string; outputClass?: string; errorCode?: string; substitutedFrom?: string };
const ok = (m: string, extra: Partial<Row> = {}): Row => ({ modelId: m, status: "ok", provider: PROVIDER[m], rawText: GENUINE, outputClass: "model_response", ...extra });
const failed = (m: string, status = "timeout", extra: Partial<Row> = {}): Row => ({ modelId: m, status, ...extra });
const facts = (rows: Row[]): RunModelProvenanceFacts[] => rows.map((r) => withPlaceholderFact(runModelProvenanceFromResultRow(r), r as any));

/** The stored report with a stored run certainty of 1.0 (a stored 100/100), presentation-marked and legacy forms. */
function storedReport(presentation: boolean) {
  const r = JSON.parse(JSON.stringify(records["generic-consensus"].synthesisReport));
  r.runCertainty = 1;
  if (!presentation) delete r.presentation;
  return r;
}

function memoFor(rows: Row[] | null, presentation = true) {
  const input = buildAdaptiveMemoInput("Q?", storedReport(presentation), [...ROSTER] as any, "run-f1", rows ? facts(rows) : null);
  return { input, memo: generateVerificationMemo(input) };
}

const SLOT_COUNT_CLAIM = /\b5 AI models researched this question independently|independently researched by 5 large language models/;
const ANY_SCORE = /CONSENSUS SCORE: \d+\/100/;
const ZERO_LINE = "CONSENSUS SCORE: none (no successful model responses; consensus cannot be assessed)";
const ONE_LINE = "CONSENSUS SCORE: none (fewer than two independent models responded";

describe.each([true, false])("F-1 research memo (presentation-marked stored report: %s)", (presentation) => {
  it("zero answering models (every slot timed out): no responses, consensus cannot be assessed, no score", () => {
    const { input, memo } = memoFor(ROSTER.map((m) => failed(m)), presentation);
    expect(memo).toContain(ZERO_LINE);
    expect(memo).toContain("No model responses are available for this question");
    expect(memo).not.toMatch(ANY_SCORE);
    expect(memo).not.toMatch(SLOT_COUNT_CLAIM);
    expect(memo).not.toContain("WHERE MODELS AGREE");
    expect(memo).not.toContain("single model's output");
    // Data unchanged: the memo input still carries the stored score; only the presentation withholds it.
    expect(input.consensusScore).toBe(100);
  });

  it("one answering model + four timeouts, stored 100/100: one model, no agreement, no score", () => {
    const { input, memo } = memoFor([ok("chatgpt"), ...ROSTER.slice(1).map((m) => failed(m))], presentation);
    expect(memo).toContain(ONE_LINE);
    expect(memo).toContain("Treat the findings as a single model's output.");
    expect(memo).not.toMatch(ANY_SCORE);
    expect(memo).not.toMatch(SLOT_COUNT_CLAIM);
    expect(memo).not.toContain("WHERE MODELS AGREE");
    expect(input.consensusScore).toBe(100);
  });

  it("missing credentials (fail-closed provider_not_configured errors) count as no response", () => {
    const { memo } = memoFor([ok("claude"), ...["chatgpt", "grok", "perplexity", "gemini"].map((m) => failed(m, "error", { errorCode: "provider_not_configured" }))], presentation);
    expect(memo).toContain(ONE_LINE);
    expect(memo).not.toMatch(ANY_SCORE);
  });

  it("two independent answering models + three failures: agreement wording with the verified count 2 and the score", () => {
    const { memo } = memoFor([ok("chatgpt"), ok("claude"), failed("grok"), failed("perplexity", "rate_limited"), failed("gemini", "error")], presentation);
    expect(memo).toContain("2 AI models researched this question independently");
    expect(memo).toContain("independently researched by 2 large language models");
    expect(memo).toContain("CONSENSUS SCORE: 100/100");
    expect(memo).not.toMatch(SLOT_COUNT_CLAIM);
  });

  it("genuine 5/5: the memo exactly as before (no count added to the input)", () => {
    const { input, memo } = memoFor(ROSTER.map((m) => ok(m)), presentation);
    expect(input).not.toHaveProperty("independentModelCount");
    expect(memo).toContain("5 AI models researched this question independently");
  });

  it("substituted providers: one substitute answering two slots counts once", () => {
    const rows = [ok("chatgpt"), ok("grok"), ok("perplexity"), { modelId: "claude", status: "substituted", provider: "deepseek", rawText: GENUINE, outputClass: "model_response", substitutedFrom: "anthropic:claude" }, { modelId: "gemini", status: "substituted", provider: "deepseek", rawText: GENUINE, outputClass: "model_response", substitutedFrom: "google:gemini" }];
    const { memo } = memoFor(rows, presentation);
    expect(memo).toContain("4 AI models researched this question independently");
    expect(memo).not.toMatch(SLOT_COUNT_CLAIM);
  });

  it("the same substitute answering the only two answering slots is one model: no score", () => {
    const rows = [{ modelId: "claude", status: "substituted", provider: "deepseek", rawText: GENUINE, outputClass: "model_response", substitutedFrom: "anthropic:claude" }, { modelId: "gemini", status: "substituted", provider: "deepseek", rawText: GENUINE, outputClass: "model_response", substitutedFrom: "google:gemini" }, failed("chatgpt"), failed("grok"), failed("perplexity")];
    const { memo } = memoFor(rows, presentation);
    expect(memo).toContain(ONE_LINE);
    expect(memo).not.toMatch(ANY_SCORE);
  });

  it("a genuine new answer that discusses a 'mock response' (F-2 fact) still counts", () => {
    const { memo } = memoFor([ok("chatgpt", { rawText: MOCK_DISCUSSION }), ok("claude"), failed("grok"), failed("perplexity"), failed("gemini")], presentation);
    expect(memo).toContain("2 AI models researched this question independently");
    expect(memo).toContain("CONSENSUS SCORE: 100/100");
  });

  it("a historical row with the same text and no outputClass fact: unverified, score withheld (nothing inferred)", () => {
    const { memo } = memoFor([ok("chatgpt", { rawText: MOCK_DISCUSSION, outputClass: undefined }), ok("claude"), failed("grok"), failed("perplexity"), failed("gemini")], presentation);
    expect(memo).toContain("CONSENSUS SCORE: withheld (model independence not recorded)");
    expect(memo).not.toMatch(ANY_SCORE);
  });

  it("historical provider-less answered rows: unverified, score withheld, no count stated", () => {
    const { memo } = memoFor(ROSTER.map((m) => ({ modelId: m, status: "ok", rawText: GENUINE })), presentation);
    expect(memo).toContain("CONSENSUS SCORE: withheld (model independence not recorded)");
    expect(memo).not.toMatch(/\d+ AI models researched/);
  });

  it("a placeholder row is not a response: one genuine answer + the exact INVALID_MOCK literal → one model", () => {
    const { memo } = memoFor([ok("chatgpt"), { modelId: "claude", status: "ok", provider: "anthropic", rawText: "Mock response from claude (no API key configured)" }, failed("grok"), failed("perplexity"), failed("gemini")], presentation);
    expect(memo).not.toMatch(ANY_SCORE);
    expect(memo).not.toMatch(SLOT_COUNT_CLAIM);
  });

  it("without the run's rows nothing is inferred: the memo as before", () => {
    const { input, memo } = memoFor(null, presentation);
    expect(input).not.toHaveProperty("independentModelCount");
    expect(memo).toContain("5 AI models researched this question independently");
  });
});

describe("answeringIndependentModelCount", () => {
  it("counts verified responding executing models only", () => {
    expect(answeringIndependentModelCount(null)).toBeNull();
    expect(answeringIndependentModelCount([])).toBeNull();
    expect(answeringIndependentModelCount(facts(ROSTER.map((m) => failed(m))))).toBe(0);
    expect(answeringIndependentModelCount(facts([ok("chatgpt"), failed("claude")]))).toBe(1);
    expect(answeringIndependentModelCount(facts(ROSTER.map((m) => ok(m))))).toBe(5);
    // A responding slot without a recorded provider or status fails the shared gate: unknown, never counted.
    expect(answeringIndependentModelCount(facts([ok("chatgpt"), { modelId: "claude", status: "ok", rawText: GENUINE }]))).toBeNull();
    expect(answeringIndependentModelCount([{ modelId: "chatgpt" }, ...facts([ok("claude")])])).toBeNull();
    expect(answeringIndependentModelCount([{ modelId: "" } as any, ...facts([ok("claude")])])).toBeNull();
    // A row with no slot id at all (or a null row) makes the run's identity unknown: null, never a crash or a count.
    expect(answeringIndependentModelCount([{ status: "timeout" } as any, ...facts([ok("claude"), ok("chatgpt")])])).toBeNull();
    expect(answeringIndependentModelCount([null as any, ...facts([ok("claude"), ok("chatgpt")])])).toBeNull();
    expect(answeringIndependentModelCount([{ modelId: 7, status: "ok" } as any, ...facts([ok("claude"), ok("chatgpt")])])).toBeNull();
  });

  it("a substitute answering several slots counts once (executing models, not answering slots)", () => {
    const sub = (m: string): Row => ({ modelId: m, status: "substituted", provider: "deepseek", rawText: GENUINE, outputClass: "model_response", substitutedFrom: `x:${m}` });
    expect(answeringIndependentModelCount(facts([sub("claude"), sub("gemini"), failed("chatgpt")]))).toBe(1);
    expect(answeringIndependentModelCount(facts([sub("claude"), sub("gemini"), ok("chatgpt")]))).toBe(2);
  });
});
