/**
 * ADAPTIVE_RETRY_CORRECTION — finalizeAdaptiveRun() end-to-end over fake
 * connectors (no provider calls). comparison_matrix is used because its
 * aggregation makes no post-retry LLM call, so every assertion here is about
 * the retry path itself.
 */

jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: false }));

const connectorMap: Record<string, jest.Mock> = {};
jest.mock("@/lib/connectors", () => ({ CONNECTOR_MAP: connectorMap }));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { finalizeAdaptiveRun, AdaptiveRetryContext } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { AdaptiveRetryUsageSink } from "@/lib/adaptiveSchema/retryCorrection";
import { ModelId, ModelResult } from "@/lib/types";

const SCHEMA = SCHEMA_REGISTRY.comparison_matrix;
const FULL = {
  cells: [
    { subject: "A", attribute: "speed", value: "fast", verdict: "better" },
    { subject: "B", attribute: "speed", value: "slow", verdict: "worse" },
  ],
  directConclusion: "RETRY conclusion",
  tradeoffs: ["RETRY tradeoff"],
  bestUseRecommendations: ["RETRY rec"],
  uncertainties: ["RETRY unc"],
};
const FIRST_PARTIAL = JSON.stringify({ cells: FULL.cells, directConclusion: "FIRST conclusion", tradeoffs: "bad", uncertainties: ["FIRST unc"] });
const USAGE = { totalTokens: 99, promptTokens: 60, completionTokens: 39 };

function okRetry(text: string, usage: any = USAGE): ModelResult {
  return { modelId: "perplexity", status: "ok", rawText: text, latencyMs: 777, tokenUsage: usage };
}

function slot(modelId: ModelId, rawText: string | null, status: ModelResult["status"] = "ok", extra: Partial<ModelResult> = {}): ModelResult {
  return { modelId, status, rawText, latencyMs: 111, tokenUsage: { totalTokens: 50, promptTokens: 30, completionTokens: 20 }, ...extra };
}

let clockMs = 0;
function ctx(models: ModelId[], overrides: Partial<AdaptiveRetryContext> = {}): AdaptiveRetryContext {
  return {
    apiKeys: {},
    promptOverrides: Object.fromEntries(models.map((m) => [m, "BASE"])),
    context: null,
    budget: { startedAtMonoMs: 0, budgetMs: 300_000 },
    usageSink: new AdaptiveRetryUsageSink(),
    now: () => clockMs,
    ...overrides,
  };
}

function install(modelId: ModelId, impl: (...args: any[]) => any) {
  connectorMap[modelId] = jest.fn(impl);
  return connectorMap[modelId];
}

beforeEach(() => {
  clockMs = 1_000;
  for (const k of Object.keys(connectorMap)) delete connectorMap[k];
});

afterEach(() => {
  jest.useRealTimers();
});

describe("AR1 — complete first-attempt failure + valid retry", () => {
  it.each([
    ["invalid JSON", "{not json"],
    ["empty", "   "],
    ["JSON primitive", "42"],
    ["JSON array", "[1,2]"],
    ["all fields invalid", JSON.stringify({ cells: "x", directConclusion: 5, tradeoffs: 1, bestUseRecommendations: 2, uncertainties: 3 })],
  ])("%s → retry adopted in full, one call", async (_label, firstText) => {
    const conn = install("perplexity", async () => okRetry(JSON.stringify(FULL)));
    const c = ctx(["perplexity"]);
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", firstText)], "q", c);
    const r = out.adaptiveResults[0];
    expect(conn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ modelId: "perplexity", schemaId: "comparison_matrix", ok: true, retried: true, retryOutcome: "adopted_full", latencyMs: 111 });
    expect(r.data?.directConclusion).toBe("RETRY conclusion");
    expect(r.parseError).toBeUndefined();
    expect(r.invalidFields).toBeUndefined();
    // The aggregation consumes the adopted data.
    expect(out.comparisonMatrix).toBeDefined();
    expect(c.usageSink.freeze()!.totals.totalTokens).toBe(99);
  });

  it("does not mutate or replace the top-level ModelResult", async () => {
    install("perplexity", async () => okRetry(JSON.stringify(FULL)));
    const results = [slot("perplexity", "{not json")];
    const before = JSON.stringify(results);
    Object.freeze(results[0]);
    const out = await finalizeAdaptiveRun(SCHEMA, results, "q", ctx(["perplexity"]));
    expect(JSON.stringify(results)).toBe(before);
    expect(results[0].rawText).toBe("{not json");
    expect(out.adaptiveResults[0].data?.directConclusion).toBe("RETRY conclusion");
  });
});

describe("AR2 — partial salvage", () => {
  it("first valid fields win; retry fills only gaps", async () => {
    install("perplexity", async () => okRetry(JSON.stringify({ ...FULL, directConclusion: "DIFFERENT" })));
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", FIRST_PARTIAL)], "q", ctx(["perplexity"]));
    const r = out.adaptiveResults[0];
    expect(r.retryOutcome).toBe("adopted_partial");
    expect(r.data?.directConclusion).toBe("FIRST conclusion");
    expect(r.data?.uncertainties).toEqual(["FIRST unc"]);
    expect(r.data?.tradeoffs).toEqual(["RETRY tradeoff"]);
    expect(r.data?.bestUseRecommendations).toEqual(["RETRY rec"]);
  });
});

describe("retry failure keeps the first attempt authoritative", () => {
  it("thrown connector → failed_call, usage unavailable", async () => {
    install("perplexity", async () => {
      throw new Error("connector exploded");
    });
    const c = ctx(["perplexity"]);
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", FIRST_PARTIAL)], "q", c);
    expect(out.adaptiveResults[0]).toMatchObject({ ok: true, retryOutcome: "failed_call", data: { directConclusion: "FIRST conclusion" } });
    expect(out.adaptiveResults[0].retried).toBeUndefined();
    expect(c.usageSink.freeze()).toMatchObject({ calls: 1, usageUnavailableCalls: 1, totals: { totalTokens: 0 } });
  });

  it("non-ok retry status → failed_call; reported usage still counted", async () => {
    install("perplexity", async () => ({ modelId: "perplexity", status: "error", rawText: null, latencyMs: 1, tokenUsage: { totalTokens: 7, promptTokens: 3, completionTokens: 4 } }));
    const c = ctx(["perplexity"]);
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", "{not json")], "q", c);
    expect(out.adaptiveResults[0]).toMatchObject({ ok: false, retryOutcome: "failed_call" });
    expect(out.adaptiveResults[0].parseError).toMatch(/^Invalid JSON/);
    expect(c.usageSink.freeze()!.totals.totalTokens).toBe(7);
  });

  it("malformed retry with zero-salvage first → no_change, first parseError kept, usage counted", async () => {
    install("perplexity", async () => okRetry("nope"));
    const c = ctx(["perplexity"]);
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", "{not json")], "q", c);
    const r = out.adaptiveResults[0];
    expect(r).toMatchObject({ ok: false, retried: true, retryOutcome: "no_change" });
    expect(r.parseError).toMatch(/^Invalid JSON/);
    expect(c.usageSink.freeze()!.totals.totalTokens).toBe(99);
  });

  it("invalid / zero-change retry on partial first → no_change, first data byte-identical", async () => {
    install("perplexity", async () => okRetry(JSON.stringify({ directConclusion: "only an already-valid field" })));
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", FIRST_PARTIAL)], "q", ctx(["perplexity"]));
    expect(out.adaptiveResults[0]).toMatchObject({ retryOutcome: "no_change", retried: true, data: { directConclusion: "FIRST conclusion" } });
    expect([...(out.adaptiveResults[0].invalidFields || [])].sort()).toEqual(["bestUseRecommendations", "tradeoffs"]);
  });
});

describe("eligibility and call cardinality", () => {
  it.each(["failed", "error", "timeout", "refused", "rate_limited"] as const)("original status %s → zero retry calls, no outcome", async (status) => {
    const conn = install("perplexity", async () => okRetry(JSON.stringify(FULL)));
    const c = ctx(["perplexity"]);
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", "{not json", status as any)], "q", c);
    expect(conn).not.toHaveBeenCalled();
    expect(out.adaptiveResults[0].retryOutcome).toBeUndefined();
    expect(c.usageSink.freeze()).toBeNull();
  });

  it("substituted slot → zero calls to the original connector, ineligible_substituted, salvage still applied", async () => {
    const conn = install("perplexity", async () => okRetry(JSON.stringify(FULL)));
    const deepseek = install("deepseek" as ModelId, async () => okRetry(JSON.stringify(FULL)));
    const c = ctx(["perplexity"]);
    const out = await finalizeAdaptiveRun(
      SCHEMA,
      [slot("perplexity", FIRST_PARTIAL, "substituted", { provider: "deepseek", substitutedFrom: "perplexity:perplexity/sonar" })],
      "q",
      c
    );
    expect(conn).not.toHaveBeenCalled();
    expect(deepseek).not.toHaveBeenCalled();
    expect(out.adaptiveResults[0]).toMatchObject({ ok: true, retryOutcome: "ineligible_substituted", data: { directConclusion: "FIRST conclusion" } });
    expect(c.usageSink.freeze()).toBeNull();
  });

  it("a substituted slot that validated cleanly carries no retry metadata", async () => {
    install("perplexity", async () => okRetry(JSON.stringify(FULL)));
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", JSON.stringify(FULL), "substituted")], "q", ctx(["perplexity"]));
    expect(out.adaptiveResults[0].retryOutcome).toBeUndefined();
  });

  it("clean ok slot → zero calls", async () => {
    const conn = install("perplexity", async () => okRetry(JSON.stringify(FULL)));
    await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", JSON.stringify(FULL))], "q", ctx(["perplexity"]));
    expect(conn).not.toHaveBeenCalled();
  });

  it("never more than one retry call per slot, across a mixed five-slot panel", async () => {
    const models: ModelId[] = ["chatgpt", "claude", "gemini", "grok", "perplexity"];
    const conns = Object.fromEntries(models.map((m) => [m, install(m, async () => ({ ...okRetry("still {bad"), modelId: m }))]));
    const c = ctx(models);
    await finalizeAdaptiveRun(
      SCHEMA,
      [slot("chatgpt", "{bad"), slot("claude", FIRST_PARTIAL), slot("gemini", JSON.stringify(FULL)), slot("grok", "{bad", "error"), slot("perplexity", "[]")],
      "q",
      c
    );
    expect(conns.chatgpt).toHaveBeenCalledTimes(1);
    expect(conns.claude).toHaveBeenCalledTimes(1);
    expect(conns.gemini).toHaveBeenCalledTimes(0);
    expect(conns.grok).toHaveBeenCalledTimes(0);
    expect(conns.perplexity).toHaveBeenCalledTimes(1);
    expect(c.usageSink.freeze()!.calls).toBe(3);
  });

  it("skipped_budget → zero calls, first attempt authoritative, no usage", async () => {
    const conn = install("perplexity", async () => okRetry(JSON.stringify(FULL)));
    clockMs = 300_000 - 76_000 - 29_999; // 29 999 ms available < Perplexity's 30 s floor
    const c = ctx(["perplexity"]);
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", FIRST_PARTIAL)], "q", c);
    expect(conn).not.toHaveBeenCalled();
    expect(out.adaptiveResults[0]).toMatchObject({ retryOutcome: "skipped_budget", data: { directConclusion: "FIRST conclusion" } });
    expect(out.adaptiveResults[0].retried).toBeUndefined();
    expect(c.usageSink.freeze()).toBeNull();
  });

  it("a missing budget fails closed to skipped_budget (never an unbounded retry)", async () => {
    const conn = install("perplexity", async () => okRetry(JSON.stringify(FULL)));
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", FIRST_PARTIAL)], "q", ctx(["perplexity"], { budget: undefined as any }));
    expect(conn).not.toHaveBeenCalled();
    expect(out.adaptiveResults[0].retryOutcome).toBe("skipped_budget");
  });
});

describe("guard timing (fake timers, no real sleeps)", () => {
  it("a Perplexity retry lasting 25 s (> the old 20 s cap) succeeds inside its 95 s guard", async () => {
    jest.useFakeTimers();
    install("perplexity", () => new Promise((resolve) => setTimeout(() => resolve(okRetry(JSON.stringify(FULL))), 25_000)));
    const c = ctx(["perplexity"]);
    const pending = finalizeAdaptiveRun(SCHEMA, [slot("perplexity", "{not json")], "q", c);
    await jest.advanceTimersByTimeAsync(25_000);
    const out = await pending;
    expect(out.adaptiveResults[0].retryOutcome).toBe("adopted_full");
    expect(c.usageSink.freeze()!.totals.totalTokens).toBe(99);
  });

  it("guard = hard timeout + 5 s: a retry still pending at 95 000 ms is cut; one at 94 999 ms is not", async () => {
    jest.useFakeTimers();
    install("perplexity", () => new Promise((resolve) => setTimeout(() => resolve(okRetry(JSON.stringify(FULL))), 94_999)));
    const ok = finalizeAdaptiveRun(SCHEMA, [slot("perplexity", "{not json")], "q", ctx(["perplexity"]));
    await jest.advanceTimersByTimeAsync(95_000);
    expect((await ok).adaptiveResults[0].retryOutcome).toBe("adopted_full");

    install("perplexity", () => new Promise((resolve) => setTimeout(() => resolve(okRetry(JSON.stringify(FULL))), 95_001)));
    const cut = finalizeAdaptiveRun(SCHEMA, [slot("perplexity", "{not json")], "q", ctx(["perplexity"]));
    await jest.advanceTimersByTimeAsync(95_000);
    expect((await cut).adaptiveResults[0].retryOutcome).toBe("failed_call");
    await jest.advanceTimersByTimeAsync(10);
  });

  it("the guard is capped by the remaining budget minus the 76 s reserve", async () => {
    jest.useFakeTimers();
    clockMs = 180_000; // 120 s remaining → 44 s guard for claude
    install("claude", () => new Promise((resolve) => setTimeout(() => resolve({ ...okRetry(JSON.stringify(FULL)), modelId: "claude" }), 44_001)));
    const pending = finalizeAdaptiveRun(SCHEMA, [slot("claude", "{not json")], "q", ctx(["claude"]));
    await jest.advanceTimersByTimeAsync(44_000);
    expect((await pending).adaptiveResults[0].retryOutcome).toBe("failed_call");
    await jest.advanceTimersByTimeAsync(10);
  });

  it("a late resolution after the guard cannot mutate the adaptive result or the frozen usage", async () => {
    jest.useFakeTimers();
    let resolveLate!: (r: ModelResult) => void;
    install("perplexity", () => new Promise<ModelResult>((resolve) => (resolveLate = resolve)));
    const c = ctx(["perplexity"]);
    const pending = finalizeAdaptiveRun(SCHEMA, [slot("perplexity", FIRST_PARTIAL)], "q", c);
    await jest.advanceTimersByTimeAsync(95_000);
    const out = await pending;
    const frozen = c.usageSink.freeze();
    const resultBefore = JSON.stringify(out.adaptiveResults);
    expect(out.adaptiveResults[0].retryOutcome).toBe("failed_call");
    expect(frozen).toMatchObject({ calls: 1, usageUnavailableCalls: 1, totals: { totalTokens: 0 } });

    resolveLate(okRetry(JSON.stringify(FULL), { totalTokens: 5000, promptTokens: 4000, completionTokens: 1000 }));
    await jest.advanceTimersByTimeAsync(1_000);

    expect(JSON.stringify(out.adaptiveResults)).toBe(resultBefore);
    expect(c.usageSink.freeze()).toBe(frozen);
    expect(c.usageSink.freeze()!.totals.totalTokens).toBe(0);
  });
});

describe("one slot failing never discards another slot's usage", () => {
  it("slot A's retry throws during validation while slot B's retry is still pending; both usages are captured", async () => {
    jest.useFakeTimers();
    install("claude", async () => {
      const r: any = { modelId: "claude", status: "ok", latencyMs: 1, tokenUsage: { totalTokens: 30, promptTokens: 20, completionTokens: 10 } };
      Object.defineProperty(r, "rawText", {
        get() {
          throw new Error("validation exploded");
        },
      });
      return r;
    });
    install("perplexity", () => new Promise((resolve) => setTimeout(() => resolve(okRetry(JSON.stringify(FULL))), 10_000)));
    const c = ctx(["claude", "perplexity"]);
    const pending = finalizeAdaptiveRun(SCHEMA, [slot("claude", FIRST_PARTIAL), slot("perplexity", "{not json")], "q", c);
    await jest.advanceTimersByTimeAsync(10_000);
    const out = await pending;
    expect(out.adaptiveResults[0]).toMatchObject({ modelId: "claude", retryOutcome: "failed_call", data: { directConclusion: "FIRST conclusion" } });
    expect(out.adaptiveResults[1]).toMatchObject({ modelId: "perplexity", retryOutcome: "adopted_full" });
    const usage = c.usageSink.freeze()!;
    expect(usage.calls).toBe(2);
    expect(usage.byModel.claude.totalTokens).toBe(30);
    expect(usage.byModel.perplexity.totalTokens).toBe(99);
    expect(usage.totals.totalTokens).toBe(129);
  });
});

describe("governance inputs vs governance algorithms", () => {
  const classification = {
    queryType: "comparison_matrix",
    domain: "test",
    answerShape: "comparison_matrix_view",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "compare",
    confidence: 0.9,
    riskLevel: "general",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: null,
    requiresClarification: false,
    rationale: "test fixture",
  } as any;

  it("a repaired adaptive result changes the facts fed to governance (usable-output count) through the unchanged meta builder", async () => {
    // Same panel, retry disabled vs enabled: only the adaptive data differs.
    const results = [slot("claude", JSON.stringify(FULL)), slot("perplexity", "{not json")];
    const unrepaired = await finalizeAdaptiveRun(SCHEMA, results, "q", undefined, classification);
    install("perplexity", async () => okRetry(JSON.stringify(FULL)));
    const repaired = await finalizeAdaptiveRun(SCHEMA, results, "q", ctx(["claude", "perplexity"]), classification);

    expect(unrepaired.commonResponseMeta?.executionStatus).toBe("partial");
    expect(repaired.commonResponseMeta?.executionStatus).toBe("completed");
    // The panel-level facts (statuses) are identical: only corrected adaptive data moved the outcome.
    expect(results.map((r) => r.status)).toEqual(["ok", "ok"]);
  });
});

describe("contract-breaking retry responses", () => {
  it("a connector that resolves nothing still counts as an issued call with unavailable usage", async () => {
    const conn = install("perplexity", async () => undefined);
    const c = ctx(["perplexity"]);
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", FIRST_PARTIAL)], "q", c);
    expect(conn).toHaveBeenCalledTimes(1);
    expect(out.adaptiveResults[0]).toMatchObject({ retryOutcome: "failed_call", data: { directConclusion: "FIRST conclusion" } });
    expect(c.usageSink.freeze()).toMatchObject({ calls: 1, usageUnavailableCalls: 1, totals: { totalTokens: 0 } });
  });

  it("a retry that comes back 'substituted' is not a usable correction (failed_call), its usage still counted", async () => {
    install("perplexity", async () => ({ ...okRetry(JSON.stringify(FULL)), status: "substituted" }));
    const c = ctx(["perplexity"]);
    const out = await finalizeAdaptiveRun(SCHEMA, [slot("perplexity", "{not json")], "q", c);
    expect(out.adaptiveResults[0]).toMatchObject({ ok: false, retryOutcome: "failed_call" });
    expect(c.usageSink.freeze()!.totals.totalTokens).toBe(99);
  });
});
