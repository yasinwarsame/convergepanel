/**
 * Phase BILLING-WEBHOOK-B1-C8, Part L — the quota gate's IN-TRANSACTION
 * re-check.
 *
 * `checkAndIncrementUsageForRun` reads the user once outside the transaction
 * to decide plan and model limits, then re-reads inside the transaction before
 * incrementing. Only that second read is authoritative: between the two, a
 * concurrent request from the same user can commit its own increment, and
 * deciding from the stale first read lets both requests pass a limit that only
 * one of them should have.
 *
 * The final review found the re-check correct but undiscriminated — a mutation
 * that trusts only the pre-transaction read survived the whole suite. This
 * pins it. The quota architecture is deliberately unchanged; only coverage is
 * added.
 */

jest.mock("@/lib/env", () => ({
  STRIPE_PRICE_3_MODELS: "price_lite_m",
  STRIPE_3_MODELS_ANNUAL: "price_lite_y",
  STRIPE_PRICE_5_MODELS: "price_full_m",
  STRIPE_5_MODELS_ANNUAL: "price_full_y",
}));

/** What the PRE-transaction read sees. */
let preTxnDoc: Record<string, unknown> = {};
/** What the IN-transaction read sees — i.e. after a concurrent writer committed. */
let inTxnDoc: Record<string, unknown> = {};
const txnUpdates: Record<string, unknown>[] = [];
let txnGetCalls = 0;

const txn = {
  get: async () => { txnGetCalls += 1; return { exists: true, data: () => inTxnDoc }; },
  update: (_ref: unknown, data: Record<string, unknown>) => { txnUpdates.push(data); },
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: () => ({
        id: "users/uid1",
        get: async () => ({ exists: true, data: () => preTxnDoc }),
        update: async () => undefined,
        set: async () => undefined,
      }),
    }),
    runTransaction: async (fn: (t: typeof txn) => Promise<unknown>) => fn(txn),
  },
}));
jest.mock("firebase-admin/firestore", () => ({ FieldValue: { increment: (n: number) => `INC(${n})`, delete: () => "DELETE" } }));

import { checkAndIncrementUsageForRun } from "../usageCheck";

const thisMonth = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
};
/** A full-plan user; the plan allows 150 runs a month. */
const user = (runsThisMonth: number, usageMonth = thisMonth()) => ({
  plan: "full",
  planFromStripe: "5_models",
  subscriptionStatus: "active",
  subscriptionStatusFromStripe: "active",
  monthlyLimit: 150,
  maxModelsPerRun: 5,
  entitlements: { planEffective: "5_models", runLimitMonthly: 150, source: "stripe" },
  usageMonth,
  runsThisMonth,
});

beforeEach(() => { txnUpdates.length = 0; txnGetCalls = 0; });

describe("C8 Part L — the decision uses the in-transaction read, not the stale one", () => {
  it("REGRESSION: a concurrent writer that reaches the limit between the two reads denies the run", async () => {
    // Pre-transaction: 149 of 150 used, so the gate lets this request proceed.
    preTxnDoc = user(149);
    // A concurrent request commits before our transaction reads: now at the cap.
    inTxnDoc = user(150);

    const result = await checkAndIncrementUsageForRun("uid1", 3);

    expect(result.allowed).toBe(false);
    expect(txnUpdates).toHaveLength(0);
  });

  it("REGRESSION: the transaction actually re-reads rather than reusing the outer snapshot", async () => {
    preTxnDoc = user(0);
    inTxnDoc = user(0);
    await checkAndIncrementUsageForRun("uid1", 3);
    expect(txnGetCalls).toBe(1);
  });

  it("REGRESSION: a concurrent writer well past the limit still denies", async () => {
    preTxnDoc = user(10);
    inTxnDoc = user(400);
    const result = await checkAndIncrementUsageForRun("uid1", 3);
    expect(result.allowed).toBe(false);
    expect(txnUpdates).toHaveLength(0);
  });

  it("the ordinary uncontended case still increments exactly once", async () => {
    preTxnDoc = user(10);
    inTxnDoc = user(10);
    const result = await checkAndIncrementUsageForRun("uid1", 3);
    expect(result.allowed).toBe(true);
    expect(txnUpdates).toHaveLength(1);
    expect(txnUpdates[0]).toMatchObject({ runsThisMonth: "INC(1)", totalRuns: "INC(1)" });
  });

  it("CHARACTERIZATION: the two checks are both fail-closed — the outer one can deny before the transaction is ever opened", async () => {
    // Stale read says the cap is reached, the authoritative read would have
    // allowed it (a new month began). The outer gate denies first, so the
    // transaction never runs. That is conservative in the SAFE direction: the
    // pair can only ever refuse a run, never grant one the authoritative read
    // would have refused. Recorded so the asymmetry is a decision, not a
    // surprise for the next reader.
    preTxnDoc = user(150);
    inTxnDoc = user(150, "2020-01");
    const result = await checkAndIncrementUsageForRun("uid1", 3);
    expect(result.allowed).toBe(false);
    expect(txnGetCalls).toBe(0);
    expect(txnUpdates).toHaveLength(0);
  });

  it("REGRESSION: the in-transaction check can only ever tighten, never loosen", async () => {
    // Outer read allows; authoritative read denies -> denied.
    preTxnDoc = user(0);
    inTxnDoc = user(150);
    expect((await checkAndIncrementUsageForRun("uid1", 3)).allowed).toBe(false);
    expect(txnUpdates).toHaveLength(0);
  });
});
