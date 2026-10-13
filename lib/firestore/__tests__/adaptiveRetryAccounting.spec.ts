/**
 * ADAPTIVE_RETRY_CORRECTION — supplemental retry accounting (AR4 / A2′)
 * against an in-memory Firestore fake that applies FieldValue.increment the
 * way the server does. The free-user non-regression case runs the REAL
 * incrementUserTokenUsage() for the primary write.
 */

type Op = { __inc: number } | { __ts: true };

jest.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    increment: (n: number) => ({ __inc: n }),
    serverTimestamp: () => ({ __ts: true }),
  },
  Timestamp: { now: () => ({ toDate: () => new Date() }), fromDate: (d: Date) => ({ toDate: () => d }) },
}));

const store = new Map<string, Record<string, any>>();
let failNextTransaction: Error | null = null;
let transactionAttempts = 0;
let commitThenThrowOnce = false;
let transactionOptions: Array<{ maxAttempts?: number } | undefined> = [];
/** null = settle immediately; a number = settle (and commit) after that many ms; "never" = hold until released. */
let transactionDelay: number | "never" | null = null;
let releaseHeldTransaction: (() => Promise<unknown>) | null = null;

function isOp(v: unknown): v is Op {
  return typeof v === "object" && v !== null && ("__inc" in (v as any) || "__ts" in (v as any));
}
function applyValue(current: unknown, value: unknown): unknown {
  if (isOp(value)) return "__inc" in value ? (typeof current === "number" ? current : 0) + value.__inc : "SERVER_TS";
  return value;
}
function applyUpdate(doc: Record<string, any>, data: Record<string, unknown>) {
  for (const [path, value] of Object.entries(data)) {
    const parts = path.split(".");
    let target = doc;
    for (const p of parts.slice(0, -1)) target = target[p] ??= {};
    const leaf = parts[parts.length - 1];
    target[leaf] = applyValue(target[leaf], value);
  }
}
function applyMergeSet(doc: Record<string, any>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (!isOp(value) && typeof value === "object" && value !== null && !Array.isArray(value)) {
      doc[key] = doc[key] && typeof doc[key] === "object" ? doc[key] : {};
      applyMergeSet(doc[key], value as Record<string, unknown>);
    } else {
      doc[key] = applyValue(doc[key], value);
    }
  }
}
function snapshot(path: string) {
  const data = store.get(path);
  return { exists: data !== undefined, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined) };
}
function ref(path: string) {
  return {
    path,
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const doc = opts?.merge ? store.get(path) ?? {} : {};
      applyMergeSet(doc, data);
      store.set(path, doc);
    },
    update: async (data: Record<string, unknown>) => {
      const doc = store.get(path);
      if (!doc) throw new Error("NOT_FOUND");
      applyUpdate(doc, data);
    },
  };
}
const fakeDb = {
  collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
  runTransaction: (fn: (txn: any) => Promise<any>, options?: { maxAttempts?: number }) => {
    transactionOptions.push(options);
    const attempt = async () => {
      // Honors maxAttempts the way the SDK does: re-runs the function only while attempts remain.
      const maxAttempts = options?.maxAttempts ?? 5;
      for (let n = 1; ; n++) {
        transactionAttempts += 1;
        if (failNextTransaction) {
          const e = failNextTransaction;
          failNextTransaction = null;
          throw e;
        }
        const writes: Array<() => void> = [];
        const result = await fn({
          get: async (r: { path: string }) => snapshot(r.path),
          update: (r: { path: string }, data: Record<string, unknown>) =>
            writes.push(() => {
              const doc = store.get(r.path);
              if (!doc) throw new Error("NOT_FOUND");
              applyUpdate(doc, data);
            }),
          set: (r: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
            writes.push(() => {
              const doc = opts?.merge ? store.get(r.path) ?? {} : {};
              applyMergeSet(doc, data);
              store.set(r.path, doc);
            }),
        });
        writes.forEach((w) => w()); // atomic commit
        if (commitThenThrowOnce) {
          // Commit landed but the client saw an error.
          commitThenThrowOnce = false;
          if (n < maxAttempts) continue;
          throw Object.assign(new Error("DEADLINE_EXCEEDED after commit"), { code: 4 });
        }
        return result;
      }
    };
    if (transactionDelay === null) return attempt();
    if (transactionDelay === "never") {
      // Never settles on its own; the test may release it later via releaseHeldTransaction().
      return new Promise((resolve, reject) => {
        releaseHeldTransaction = () => attempt().then(resolve, reject);
      });
    }
    const delay = transactionDelay;
    return new Promise((resolve, reject) => setTimeout(() => attempt().then(resolve, reject), delay));
  },
};

jest.mock("@/lib/firebase/admin", () => ({ adminDb: fakeDb, FIREBASE_PROJECT_ID: "test-project" }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { applyAdaptiveRetryAccounting } from "@/lib/firestore/adaptiveRetryAccounting";
import { incrementUserTokenUsage } from "@/lib/firestore/userTokens";
import { AdaptiveRetryUsageSink, AdaptiveRetryUsageV1 } from "@/lib/adaptiveSchema/retryCorrection";
import { ADAPTIVE_RETRY_ACCOUNTING_WAIT_MS } from "@/lib/adaptiveSchema/retryBudget";

const apply = (args: Omit<Parameters<typeof applyAdaptiveRetryAccounting>[0], "foregroundWaitMs"> & { foregroundWaitMs?: number }) =>
  applyAdaptiveRetryAccounting({ foregroundWaitMs: ADAPTIVE_RETRY_ACCOUNTING_WAIT_MS, ...args });

const BOTH_OK = { completeRunSucceeded: true, primaryUserAccountingSucceeded: true };

/** The run document exactly as completeRun() leaves it for a 2-model panel (claude 50 + perplexity 30 = 80). */
function seedCompletedRun(runId = "run-1") {
  store.set(`runs/${runId}`, {
    status: "complete",
    tokenUsage: {
      byModel: { claude: { promptTokens: 30, completionTokens: 20, totalTokens: 50 }, perplexity: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } },
      totals: { promptTokens: 50, completionTokens: 30, totalTokens: 80 },
    },
    totalTokens: 80,
    tokensByModel: { claude: 50, perplexity: 30 },
    tokensByProvider: { anthropic: 50, perplexity: 30 },
  });
}

function usageOf(records: Array<[number, any, any]>): AdaptiveRetryUsageV1 {
  const sink = new AdaptiveRetryUsageSink();
  for (const [slot, modelId, usage] of records) sink.record(slot, modelId, usage);
  return sink.freeze()!;
}

const TWO_RETRIES = () =>
  usageOf([
    [0, "claude", { promptTokens: 20, completionTokens: 10, totalTokens: 30 }],
    [1, "perplexity", { promptTokens: 60, completionTokens: 39, totalTokens: 99 }],
  ]);

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

beforeEach(() => {
  store.clear();
  failNextTransaction = null;
  commitThenThrowOnce = false;
  transactionAttempts = 0;
  transactionOptions = [];
  transactionDelay = null;
  releaseHeldTransaction = null;
});

describe("run-level supplemental accounting", () => {
  it("no retry → no write at all", async () => {
    seedCompletedRun();
    const before = JSON.stringify(store.get("runs/run-1"));
    expect(await apply({ runId: "run-1", uid: "u1", usage: null, gates: BOTH_OK })).toEqual({ status: "no_retry_calls" });
    expect(JSON.stringify(store.get("runs/run-1"))).toBe(before);
    expect(transactionAttempts).toBe(0);
  });

  it("two parallel retries aggregate exactly into totals and providers; per-model primary records untouched", async () => {
    seedCompletedRun();
    store.set("users/u1", { tokensUsedCurrentPeriod: 80 });
    const result = await apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK });
    expect(result).toEqual({ status: "applied", userCounter: "applied" });
    const run = store.get("runs/run-1")!;
    expect(run.totalTokens).toBe(80 + 129);
    expect(run.tokenUsage.totals).toEqual({ promptTokens: 50 + 80, completionTokens: 30 + 49, totalTokens: 209 });
    expect(run.tokensByProvider).toEqual({ anthropic: 80, perplexity: 129 });
    // Primary per-model records describe the original panel only.
    expect(run.tokensByModel).toEqual({ claude: 50, perplexity: 30 });
    expect(run.tokenUsage.byModel.claude.totalTokens).toBe(50);
    // Invariants.
    expect(run.totalTokens).toBe(sum(run.tokensByModel) + run.adaptiveRetryUsage.totals.totalTokens);
    expect(sum(run.tokensByProvider)).toBe(run.totalTokens);
    expect(run.tokenUsage.totals.totalTokens).toBe(run.totalTokens);
    expect(run.adaptiveRetryUsage).toMatchObject({ schemaVersion: 1, calls: 2, usageUnavailableCalls: 0, userCounter: "applied" });
    expect(store.get("users/u1")!.tokensUsedCurrentPeriod).toBe(80 + 129);
  });

  it("creates a provider key the primary run never had", async () => {
    seedCompletedRun();
    await apply({
      runId: "run-1",
      uid: "u1",
      usage: usageOf([[0, "grok", { promptTokens: 5, completionTokens: 5, totalTokens: 14, reasoningTokens: 4 }]]),
      gates: BOTH_OK,
    });
    const run = store.get("runs/run-1")!;
    expect(run.tokensByProvider).toEqual({ anthropic: 50, perplexity: 30, xai: 14 });
    expect(run.tokenUsage.totals).toEqual({ promptTokens: 55, completionTokens: 35, totalTokens: 94, reasoningTokens: 4 });
  });

  it("usage unavailable (guard timeout) → marker records the call, no token increment, no user write", async () => {
    seedCompletedRun();
    store.set("users/u1", { tokensUsedCurrentPeriod: 80 });
    const result = await apply({ runId: "run-1", uid: "u1", usage: usageOf([[0, "perplexity", null]]), gates: BOTH_OK });
    expect(result).toEqual({ status: "applied", userCounter: "no_reported_usage" });
    const run = store.get("runs/run-1")!;
    expect(run.totalTokens).toBe(80);
    expect(run.tokensByProvider).toEqual({ anthropic: 50, perplexity: 30 });
    expect(run.adaptiveRetryUsage).toMatchObject({ calls: 1, usageUnavailableCalls: 1, totals: { totalTokens: 0 }, userCounter: "no_reported_usage" });
    expect(store.get("users/u1")!.tokensUsedCurrentPeriod).toBe(80);
  });

  it("primary completeRun not confirmed → nothing written (no partial totals on a running doc)", async () => {
    store.set("runs/run-1", { status: "running" });
    const result = await apply({
      runId: "run-1",
      uid: "u1",
      usage: TWO_RETRIES(),
      gates: { completeRunSucceeded: false, primaryUserAccountingSucceeded: false },
    });
    expect(result).toEqual({ status: "skipped_primary_run_unconfirmed" });
    expect(store.get("runs/run-1")).toEqual({ status: "running" });
    expect(store.has("users/u1")).toBe(false);
  });

  it("idempotent: a second application is a no-op", async () => {
    seedCompletedRun();
    store.set("users/u1", { tokensUsedCurrentPeriod: 80 });
    const usage = TWO_RETRIES();
    await apply({ runId: "run-1", uid: "u1", usage, gates: BOTH_OK });
    expect(await apply({ runId: "run-1", uid: "u1", usage, gates: BOTH_OK })).toEqual({ status: "already_applied" });
    expect(store.get("runs/run-1")!.totalTokens).toBe(209);
    expect(store.get("users/u1")!.tokensUsedCurrentPeriod).toBe(209);
  });

  it("runs the transaction with maxAttempts: 1 — no SDK retry loop in the foreground", async () => {
    seedCompletedRun();
    await apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK });
    expect(transactionOptions).toEqual([{ maxAttempts: 1 }]);
    expect(transactionAttempts).toBe(1);
  });

  it("a commit that landed but surfaced an error is reported as failed, never retried, and any re-entry is a no-op (marker)", async () => {
    seedCompletedRun();
    store.set("users/u1", { tokensUsedCurrentPeriod: 80 });
    commitThenThrowOnce = true;
    const result = await apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK });
    expect(result).toEqual({ status: "failed" });
    expect(transactionAttempts).toBe(1);
    expect(store.get("runs/run-1")!.totalTokens).toBe(209);
    expect(await apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK })).toEqual({ status: "already_applied" });
    expect(store.get("runs/run-1")!.totalTokens).toBe(209);
    expect(store.get("users/u1")!.tokensUsedCurrentPeriod).toBe(209);
  });

  it("a missing run document writes nothing", async () => {
    expect(await apply({ runId: "run-x", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK })).toEqual({ status: "run_missing" });
    expect(store.size).toBe(0);
  });

  it("a failing transaction resolves to failed, never throws, and leaves primary accounting intact", async () => {
    seedCompletedRun();
    store.set("users/u1", { tokensUsedCurrentPeriod: 80 });
    failNextTransaction = Object.assign(new Error("UNAVAILABLE"), { code: 14 });
    await expect(apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK })).resolves.toEqual({ status: "failed" });
    expect(store.get("runs/run-1")!.totalTokens).toBe(80);
    expect(store.get("users/u1")!.tokensUsedCurrentPeriod).toBe(80);
  });
});

describe("user-level supplemental accounting", () => {
  it("primary 0 + retry > 0: retry usage still counted when the primary user accounting succeeded", async () => {
    store.set("runs/run-1", { status: "complete", totalTokens: 0, tokenUsage: { totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }, tokensByModel: { perplexity: 0 } });
    // Real helper, primary total 0: its zero branch initializes the field without adding.
    await incrementUserTokenUsage("u-zero", 0);
    expect(store.get("users/u-zero")!.tokensUsedCurrentPeriod).toBe(0);
    const result = await apply({
      runId: "run-1",
      uid: "u-zero",
      usage: usageOf([[0, "perplexity", { promptTokens: 60, completionTokens: 39, totalTokens: 99 }]]),
      gates: BOTH_OK,
    });
    expect(result).toEqual({ status: "applied", userCounter: "applied" });
    expect(store.get("users/u-zero")!.tokensUsedCurrentPeriod).toBe(99);
    expect(store.get("runs/run-1")!.totalTokens).toBe(99);
  });

  it("primary user accounting failed → run accounted, user increment skipped and recorded", async () => {
    seedCompletedRun();
    store.set("users/u1", { tokensUsedCurrentPeriod: 500 });
    const result = await apply({
      runId: "run-1",
      uid: "u1",
      usage: TWO_RETRIES(),
      gates: { completeRunSucceeded: true, primaryUserAccountingSucceeded: false },
    });
    expect(result).toEqual({ status: "applied", userCounter: "skipped_primary_unconfirmed" });
    expect(store.get("runs/run-1")!.totalTokens).toBe(209);
    expect(store.get("runs/run-1")!.adaptiveRetryUsage.userCounter).toBe("skipped_primary_unconfirmed");
    expect(store.get("users/u1")!.tokensUsedCurrentPeriod).toBe(500);
  });

  it("free-user non-regression: no billingCycleStart → counter = primary + retry (the reset branch is never re-entered)", async () => {
    seedCompletedRun();
    store.set("users/free", { tokensUsedCurrentPeriod: 12345 }); // stale prior-run value; no billingCycleStart
    // Primary: the real helper's documented (out-of-scope) reset sets the counter to this run's 80.
    await incrementUserTokenUsage("free", 80);
    expect(store.get("users/free")!.tokensUsedCurrentPeriod).toBe(80);
    await apply({ runId: "run-1", uid: "free", usage: TWO_RETRIES(), gates: BOTH_OK });
    expect(store.get("users/free")!.tokensUsedCurrentPeriod).toBe(80 + 129);
  });

  it("paid user in period: counter = before + primary + retry", async () => {
    seedCompletedRun();
    const now = new Date();
    store.set("users/paid", {
      tokensUsedCurrentPeriod: 6000,
      billingCycleStart: new Date(now.getTime() - 24 * 3600 * 1000).toISOString(),
      billingInterval: "month",
    });
    await incrementUserTokenUsage("paid", 80);
    await apply({ runId: "run-1", uid: "paid", usage: TWO_RETRIES(), gates: BOTH_OK });
    expect(store.get("users/paid")!.tokensUsedCurrentPeriod).toBe(6000 + 80 + 129);
  });
});

describe("bounded foreground wait (fake timers — no real sleeps)", () => {
  afterEach(() => jest.useRealTimers());

  async function settle(ms: number) {
    await jest.advanceTimersByTimeAsync(ms);
  }

  it("a transaction that never settles releases the caller at the wait bound with foreground_wait_expired; no second transaction; a late commit applies at most once", async () => {
    jest.useFakeTimers();
    seedCompletedRun();
    store.set("users/u1", { tokensUsedCurrentPeriod: 80 });
    transactionDelay = "never";
    let outcome: unknown = "pending";
    const pending = apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK }).then((r) => (outcome = r));
    await settle(ADAPTIVE_RETRY_ACCOUNTING_WAIT_MS - 1);
    expect(outcome).toBe("pending");
    await settle(1);
    await pending;
    expect(outcome).toEqual({ status: "foreground_wait_expired" });
    expect(transactionOptions).toHaveLength(1); // nothing restarted
    expect(store.get("runs/run-1")!.totalTokens).toBe(80); // not (yet) applied — and not reported as failed

    // The abandoned transaction is not cancelled: if it later commits, it applies exactly once.
    await releaseHeldTransaction!();
    expect(store.get("runs/run-1")!.totalTokens).toBe(209);
    expect(store.get("users/u1")!.tokensUsedCurrentPeriod).toBe(209);
    transactionDelay = null;
    expect(await apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK })).toEqual({ status: "already_applied" });
    expect(store.get("runs/run-1")!.totalTokens).toBe(209);
    expect(store.get("users/u1")!.tokensUsedCurrentPeriod).toBe(209);
  });

  it("resolving 1 ms before the bound is applied", async () => {
    jest.useFakeTimers();
    seedCompletedRun();
    transactionDelay = 9_999;
    const pending = apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK, foregroundWaitMs: 10_000 });
    await settle(10_000);
    expect(await pending).toEqual({ status: "applied", userCounter: "applied" });
  });

  it("resolving exactly at the bound is applied (its timer was scheduled first; timers fire in order)", async () => {
    jest.useFakeTimers();
    seedCompletedRun();
    transactionDelay = 10_000;
    const pending = apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK, foregroundWaitMs: 10_000 });
    await settle(10_000);
    expect(await pending).toEqual({ status: "applied", userCounter: "applied" });
  });

  it("resolving 1 ms after the bound is foreground_wait_expired; the late commit still lands once", async () => {
    jest.useFakeTimers();
    seedCompletedRun();
    transactionDelay = 10_001;
    const pending = apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK, foregroundWaitMs: 10_000 });
    await settle(10_000);
    expect(await pending).toEqual({ status: "foreground_wait_expired" });
    expect(store.get("runs/run-1")!.totalTokens).toBe(80);
    await settle(1);
    expect(store.get("runs/run-1")!.totalTokens).toBe(209);
    expect(transactionOptions).toHaveLength(1);
  });

  it("a rejecting transaction inside the bound is failed (not expired)", async () => {
    jest.useFakeTimers();
    seedCompletedRun();
    failNextTransaction = Object.assign(new Error("ABORTED"), { code: 10 });
    transactionDelay = 500;
    const pending = apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK });
    await settle(500);
    expect(await pending).toEqual({ status: "failed" });
  });

  it("already_applied inside the bound is reported as such", async () => {
    jest.useFakeTimers();
    seedCompletedRun();
    await apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK });
    transactionDelay = 100;
    const pending = apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK });
    await settle(100);
    expect(await pending).toEqual({ status: "already_applied" });
  });

  it.each([0, -5_000, 999, Number.NaN])("insufficient remaining budget (wait %p ms) → no attempt is started", async (wait) => {
    seedCompletedRun();
    expect(await apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK, foregroundWaitMs: wait })).toEqual({
      status: "skipped_insufficient_budget",
    });
    expect(transactionOptions).toHaveLength(0);
    expect(store.get("runs/run-1")!.totalTokens).toBe(80);
  });

  it("the minimum wait (1 000 ms) still attempts", async () => {
    seedCompletedRun();
    expect(await apply({ runId: "run-1", uid: "u1", usage: TWO_RETRIES(), gates: BOTH_OK, foregroundWaitMs: 1_000 })).toEqual({
      status: "applied",
      userCounter: "applied",
    });
  });
});
