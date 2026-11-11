/**
 * Owner-authorized saved-copy retry notice (2026-11-07).
 *
 * Production run run-37992243 (comparison_matrix): Gemini's slot was "ok", its first answer was fenced JSON missing a
 * comma, ONE corrective retry was adopted and contributed matrix cells attributed to the gemini slot. Only the first
 * answer is saved, so the reopened report could only say "can't be shown". The new notice is selected only when the
 * PERSISTED record establishes success+inclusion: a recorded retry for the slot AND cells attributed to the slot.
 * `calls >= 1` alone only proves an ATTEMPT (orchestrate.ts records a call for failed/no_change retries too).
 */
jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: false, GEMINI_API_KEY: "test-key" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));

import { callGemini } from "@/lib/connectors/gemini";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { AdaptiveRetryUsageSink } from "@/lib/adaptiveSchema/retryCorrection";
import { reconstructModelResults } from "@/lib/adaptiveSchema/reconstructModelResults";
import {
  retriedIncludedSlotsFromRecord,
  slotsAttributedInResult,
  slotsWithRecordedRetry,
} from "@/lib/adaptiveSchema/savedCopyRetryEvidence";
import {
  SAVED_COPY_RETRIED_AFTER_NAME,
  SAVED_COPY_RETRIED_INCLUDED,
  SAVED_COPY_RETRIED_SHORTENED,
  SAVED_COPY_SHORTENED,
  SAVED_COPY_UNSTRUCTURED,
} from "@/lib/adaptiveSchema/savedCopyNotice";
import { buildRunReadPayload } from "@/lib/runs/runReadPayload";
import type { ModelResult } from "@/lib/types";

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

const cellsFor = (m: string) => [
  { subject: "Alpha", attribute: "Price", value: `${m} price` },
  { subject: "Alpha", attribute: "Speed", value: `${m} speed` },
  { subject: "Beta", attribute: "Price", value: `${m} beta price` },
];
const validBody = (m: string) =>
  JSON.stringify({ cells: cellsFor(m), directConclusion: `${m} conclusion`, tradeoffs: ["t"], bestUseRecommendations: ["b"], uncertainties: [] });
/** run-37992243's first Gemini answer: fenced JSON with a missing comma early on. */
const fencedMissingComma = "```json\n" + validBody("gemini").replace('"Alpha","attribute"', '"Alpha" "attribute"') + "\n```";

const usage = (byModel: Record<string, unknown>, calls?: number) => ({
  schemaVersion: 1,
  calls: calls ?? Object.values(byModel).reduce((n: number, e: any) => n + (typeof e?.calls === "number" ? e.calls : 0), 0),
  usageUnavailableCalls: 0,
  totals: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
  byModel,
  userCounter: "applied",
});
const entry = (calls: unknown) => ({ calls, usageUnavailableCalls: 0, promptTokens: 10, completionTokens: 10, totalTokens: 20 });

const matrixEnvelope = (valuesByModel: Record<string, string>[]) => ({
  version: 1,
  schemaId: "comparison_matrix",
  answerShape: "comparison_grid",
  classification: { queryType: "comparison_matrix", confidence: 0.9 },
  meta: {},
  generatedAt: "2026-11-01T00:00:00.000Z",
  result: {
    subjects: [],
    lowConfidenceSubjects: [],
    attributes: [],
    lowConfidenceAttributes: [],
    cells: valuesByModel.map((v, i) => ({ subjectId: `s${i}`, subject: "S", attributeId: "a", attribute: "A", valuesByModel: v, coverageCount: 1, totalModels: 2, coverageRatio: 0.5, agreement: "single_source" })),
    hasVerifiedSourceData: false,
    totalModels: 2,
    directConclusion: "",
    tradeoffs: [],
    bestUseRecommendations: [],
    uncertainties: [],
  },
});

const perModelRow = (modelId: string, status: string, text: string, wasTruncated = false) => ({
  modelId,
  status,
  rawTextTruncated: text,
  tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 1,
  wasTruncated,
});

const runDoc = (extra: Record<string, unknown>, rows = [perModelRow("chatgpt", "ok", validBody("chatgpt")), perModelRow("gemini", "ok", fencedMissingComma)]) => ({
  userId: "owner-1",
  question: "Compare Alpha and Beta",
  status: "complete",
  runDocument: { perModel: rows },
  ...extra,
});

const read = async (data: Record<string, unknown>) =>
  (await buildRunReadPayload({ mayReadDecisionContent: true, runId: "run-1", data, viewerRole: "owner", resolveReviewRouting: jest.fn().mockResolvedValue("not_configured") })) as any;
const noticeOf = async (data: Record<string, unknown>, modelId = "gemini") =>
  (await read(data)).adaptive.modelResults.find((r: any) => r.modelId === modelId)?.parseError;

describe("the notice text", () => {
  it("is exactly the owner-authorized sentence once the display name is put in front", () => {
    expect(`Gemini${SAVED_COPY_RETRIED_AFTER_NAME}`).toBe(
      "Gemini's response was successfully retried and included in this report. The corrected response was not preserved as a separately viewable saved copy."
    );
    expect(SAVED_COPY_RETRIED_INCLUDED).toBe(`This model${SAVED_COPY_RETRIED_AFTER_NAME}`);
  });
});

describe("slotsWithRecordedRetry: a well-formed retry record or nothing", () => {
  it("accepts the sink's own shape", () => {
    expect(Array.from(slotsWithRecordedRetry(usage({ gemini: entry(1) })))).toEqual(["gemini"]);
  });
  it.each([
    ["absent", undefined],
    ["null", null],
    ["an array", [entry(1)]],
    ["a string", "gemini"],
    ["wrong schemaVersion", { ...usage({ gemini: entry(1) }), schemaVersion: 2 }],
    ["missing byModel", { ...usage({ gemini: entry(1) }), byModel: undefined }],
    ["byModel an array", { ...usage({}), calls: 1, byModel: [entry(1)] }],
    ["slot calls 0", usage({ gemini: entry(0) }, 1)],
    ["slot calls a string", usage({ gemini: entry("1") }, 1)],
    ["slot calls fractional", usage({ gemini: entry(0.5) }, 1)],
    ["slot calls NaN", usage({ gemini: entry(NaN) }, 1)],
    ["slot entry not an object", usage({ gemini: 1 }, 1)],
    ["top-level calls 0", usage({ gemini: entry(1) }, 0)],
    ["top-level calls disagree with the per-slot sum", usage({ gemini: entry(1) }, 2)],
    ["one malformed sibling poisons the record", usage({ gemini: entry(1), claude: entry(-1) }, 1)],
    // Consistent totals, so only the per-value checks can reject these (the sum check cannot mask them).
    ["calls 0 everywhere, totals consistent", usage({ gemini: entry(0) }, 0)],
    ["slot calls 0 beside a real retry, totals consistent", usage({ gemini: entry(0), claude: entry(1) }, 1)],
    ["fractional calls, totals consistent", usage({ gemini: entry(1.5) }, 1.5)],
    ["fractional calls summing to an integer", usage({ gemini: entry(0.5), claude: entry(0.5) }, 1)],
  ])("%s → no slot", (_label, raw) => {
    expect(slotsWithRecordedRetry(raw).size).toBe(0);
  });
});

describe("slotsAttributedInResult", () => {
  it("reads non-empty cell values by slot; ignores empty values and malformed cells", () => {
    const env = matrixEnvelope([{ chatgpt: "x" }, { gemini: "  " } as any, { claude: 5 } as any]);
    (env.result.cells as unknown[]).push(null, { valuesByModel: ["gemini"] });
    expect(Array.from(slotsAttributedInResult(env as any))).toEqual(["chatgpt"]);
  });
  it("is empty for every other schema (no per-slot attribution is read there)", () => {
    // Even a cells-shaped attribution on another schema is not read.
    const other = { schemaId: "deep_research", result: { findings: [{ supportingModels: ["gemini"] }], cells: [{ valuesByModel: { gemini: "g" } }] } } as any;
    expect(slotsAttributedInResult(other).size).toBe(0);
  });
});

describe("retriedIncludedSlotsFromRecord: recorded retry AND attributed content", () => {
  it("both → the slot; retry without attribution, or attribution without retry → nothing", () => {
    const env = matrixEnvelope([{ chatgpt: "c", gemini: "g" }]) as any;
    expect(Array.from(retriedIncludedSlotsFromRecord(usage({ gemini: entry(1) }), env))).toEqual(["gemini"]);
    expect(retriedIncludedSlotsFromRecord(usage({ gemini: entry(1) }), matrixEnvelope([{ chatgpt: "c" }]) as any).size).toBe(0);
    expect(retriedIncludedSlotsFromRecord(usage({ claude: entry(1) }), env).size).toBe(0);
    expect(retriedIncludedSlotsFromRecord(undefined, env).size).toBe(0);
  });
});

describe("reconstructModelResults with retriedIncludedSlots", () => {
  const slots = new Set(["gemini"]);
  it("retried+included slot, saved copy malformed → the retried notice", () => {
    const [r] = reconstructModelResults("comparison_matrix", [{ modelId: "gemini", status: "ok", rawText: fencedMissingComma }], { retriedIncludedSlots: slots });
    expect([r.ok, r.data, r.parseError]).toEqual([false, null, SAVED_COPY_RETRIED_INCLUDED]);
  });
  it("no retry signal → the existing neutral notice", () => {
    const [r] = reconstructModelResults("comparison_matrix", [{ modelId: "gemini", status: "ok", rawText: fencedMissingComma }]);
    expect(r.parseError).toBe(SAVED_COPY_UNSTRUCTURED);
    const [s] = reconstructModelResults("comparison_matrix", [{ modelId: "gemini", status: "ok", rawText: fencedMissingComma }], { retriedIncludedSlots: new Set(["claude"]) });
    expect(s.parseError).toBe(SAVED_COPY_UNSTRUCTURED);
  });
  // Review D1 (2026-11-11): the recorded retry now outranks a shortened first answer, which is not shown; success is not
  // claimed for a shortened copy (it can't show the first answer failed in full), so the notice is SAVED_COPY_RETRIED_SHORTENED.
  it("a recorded retry outranks a shortened saved copy (no first-answer text, success not claimed)", () => {
    const [r] = reconstructModelResults("comparison_matrix", [{ modelId: "gemini", status: "ok", rawText: fencedMissingComma, wasTruncatedForStorage: true }], { retriedIncludedSlots: slots });
    expect([r.parseError, r.savedResponseText]).toEqual([SAVED_COPY_RETRIED_SHORTENED, undefined]);
  });
  it("a saved copy that validates is returned as-is (no notice at all)", () => {
    const [r] = reconstructModelResults("comparison_matrix", [{ modelId: "gemini", status: "ok", rawText: validBody("gemini") }], { retriedIncludedSlots: slots });
    expect([r.ok, r.parseError]).toEqual([true, undefined]);
  });
  it.each(["substituted", "error", "failed", "timeout", undefined])("status %s is unchanged by the retry signal", (status) => {
    const row = { modelId: "gemini", status, rawText: fencedMissingComma };
    expect(reconstructModelResults("comparison_matrix", [row], { retriedIncludedSlots: slots })).toEqual(reconstructModelResults("comparison_matrix", [row]));
    expect(reconstructModelResults("comparison_matrix", [row], { retriedIncludedSlots: slots })[0].parseError).not.toBe(SAVED_COPY_RETRIED_INCLUDED);
  });
  it("a slot id saved twice never gets the retried notice", () => {
    const rows = [{ modelId: "gemini", status: "ok", rawText: fencedMissingComma }, { modelId: "gemini", status: "ok", rawText: fencedMissingComma }];
    expect(reconstructModelResults("comparison_matrix", rows, { retriedIncludedSlots: slots }).map((r) => r.parseError)).toEqual([SAVED_COPY_UNSTRUCTURED, SAVED_COPY_UNSTRUCTURED]);
  });
});

describe("buildRunReadPayload fails closed on the retry record", () => {
  const env = matrixEnvelope([{ chatgpt: "c", gemini: "g" }]);
  it("run-37992243 shape (ok slot, fenced JSON missing a comma, retry calls 1, cells attributed to the slot) → retried notice", async () => {
    expect(await noticeOf(runDoc({ adaptiveOutput: env, adaptiveRetryUsage: usage({ gemini: entry(1) }) }))).toBe(SAVED_COPY_RETRIED_INCLUDED);
  });
  it("the retry record is never returned in the payload", async () => {
    const p = await read(runDoc({ adaptiveOutput: env, adaptiveRetryUsage: usage({ gemini: entry(1) }) }));
    expect(JSON.stringify(p)).not.toContain("byModel");
    expect(JSON.stringify(p)).not.toContain("usageUnavailableCalls");
  });
  it.each([
    ["absent", undefined],
    ["wrong type", "gemini"],
    ["calls 0", usage({ gemini: entry(0) }, 1)],
    ["calls as a string", usage({ gemini: entry("1") }, 1)],
    ["unknown slot only", usage({ grok: entry(1) })],
    ["inconsistent totals", usage({ gemini: entry(1) }, 3)],
  ])("adaptiveRetryUsage %s → neutral notice", async (_label, raw) => {
    expect(await noticeOf(runDoc({ adaptiveOutput: env, adaptiveRetryUsage: raw }))).toBe(SAVED_COPY_UNSTRUCTURED);
  });
  it("NEGATIVE: retry attempted (calls 1) but no content attributed to the slot → neutral notice", async () => {
    expect(await noticeOf(runDoc({ adaptiveOutput: matrixEnvelope([{ chatgpt: "c" }]), adaptiveRetryUsage: usage({ gemini: entry(1) }) }))).toBe(SAVED_COPY_UNSTRUCTURED);
  });
  it("a substituted or failed slot is unchanged even with a retry record and attributed cells", async () => {
    for (const status of ["substituted", "error"]) {
      const rows = [perModelRow("chatgpt", "ok", validBody("chatgpt")), perModelRow("gemini", status, fencedMissingComma)];
      const n = await noticeOf(runDoc({ adaptiveOutput: env, adaptiveRetryUsage: usage({ gemini: entry(1) }) }, rows));
      const without = await noticeOf(runDoc({ adaptiveOutput: env }, rows));
      expect(n).toBe(without);
      expect(n).not.toBe(SAVED_COPY_RETRIED_INCLUDED);
    }
  });
  it("shortened saved copy with an established retry → RETRIED_SHORTENED through the payload (review D1); without the record → SHORTENED", async () => {
    const rows = [perModelRow("chatgpt", "ok", validBody("chatgpt")), perModelRow("gemini", "ok", fencedMissingComma, true)];
    expect(await noticeOf(runDoc({ adaptiveOutput: env, adaptiveRetryUsage: usage({ gemini: entry(1) }) }, rows))).toBe(SAVED_COPY_RETRIED_SHORTENED);
    expect(await noticeOf(runDoc({ adaptiveOutput: env }, rows))).toBe(SAVED_COPY_SHORTENED);
  });
});

describe("end to end through the real retry pipeline (finalizeAdaptiveRun → persisted fields → read)", () => {
  afterEach(() => jest.clearAllMocks());
  const schema = SCHEMA_REGISTRY.comparison_matrix;
  const classification = { queryType: "comparison_matrix", confidence: 0.9 } as never;
  const firstResults: ModelResult[] = [
    { modelId: "chatgpt", status: "ok", rawText: validBody("chatgpt"), latencyMs: 5 },
    { modelId: "gemini", status: "ok", rawText: fencedMissingComma, latencyMs: 5 },
  ];
  const ctx = (sink: AdaptiveRetryUsageSink) => ({
    apiKeys: { gemini: "k" },
    promptOverrides: { gemini: "BASE", chatgpt: "BASE" },
    context: null,
    budget: { startedAtMonoMs: 0, budgetMs: 300_000 },
    usageSink: sink,
    now: () => 1_000,
  });
  /** What the write path persists: perModel (first answers), adaptiveOutput (persistedOutput), adaptiveRetryUsage (frozen sink). */
  const persistedDoc = async () => {
    const sink = new AdaptiveRetryUsageSink();
    const out = await finalizeAdaptiveRun(schema, firstResults, "Compare Alpha and Beta", ctx(sink) as never, classification);
    const frozen = sink.freeze();
    return {
      out,
      doc: runDoc({ adaptiveOutput: out.persistedOutput, ...(frozen ? { adaptiveRetryUsage: { ...frozen, userCounter: "applied" } } : {}) }),
    };
  };
  const tokenUsage = { promptTokens: 10, completionTokens: 10, totalTokens: 20 };

  it("adopted retry → cells attributed to gemini, calls 1 → retried notice", async () => {
    mockedCallGemini.mockResolvedValueOnce({ modelId: "gemini", status: "ok", rawText: validBody("gemini"), latencyMs: 5, tokenUsage } as never);
    const { out, doc } = await persistedDoc();
    expect(out.adaptiveResults.find((r) => r.modelId === "gemini")?.retryOutcome).toBe("adopted_full");
    expect((doc as any).adaptiveRetryUsage.byModel.gemini.calls).toBe(1);
    expect(await noticeOf(doc)).toBe(SAVED_COPY_RETRIED_INCLUDED);
  });

  it.each([
    ["no_change (retry still malformed)", () => mockedCallGemini.mockResolvedValueOnce({ modelId: "gemini", status: "ok", rawText: fencedMissingComma, latencyMs: 5, tokenUsage } as never), "no_change"],
    ["failed_call (non-ok status)", () => mockedCallGemini.mockResolvedValueOnce({ modelId: "gemini", status: "error", rawText: "", latencyMs: 5 } as never), "failed_call"],
    ["failed_call (thrown)", () => mockedCallGemini.mockRejectedValueOnce(new Error("boom")), "failed_call"],
  ])("NEGATIVE: attempted but unsuccessful retry — %s — records calls 1 yet never gets the retried notice", async (_l, arrange, outcome) => {
    arrange();
    const { out, doc } = await persistedDoc();
    expect(out.adaptiveResults.find((r) => r.modelId === "gemini")?.retryOutcome).toBe(outcome);
    expect((doc as any).adaptiveRetryUsage.byModel.gemini.calls).toBe(1);
    expect(await noticeOf(doc)).toBe(SAVED_COPY_UNSTRUCTURED);
  });
});
