/**
 * Phase BILLING-WEBHOOK-B1-C1 — field ownership between the quota system and
 * the billing reconciliation paths.
 *
 * `billingCycleStart` / `currentPeriodEnd` are STRIPE billing-cycle facts,
 * derived from the plan-bearing subscription item and written only by the
 * reconciliation paths. The quota system owns `usageMonth`.
 *
 * The exact-head review of PR #145 found the calendar-month quota rollover
 * rewriting `billingCycleStart` with the current time as an ISO string — for
 * annual customers too. That clobbered the canonical item-level period within
 * a month of it being persisted AND changed its stored type, quietly undoing
 * the fix it shipped alongside. These tests pin the ownership boundary.
 */

jest.mock("@/lib/env", () => ({
  STRIPE_PRICE_3_MODELS: "price_lite_m",
  STRIPE_3_MODELS_ANNUAL: "price_lite_y",
  STRIPE_PRICE_5_MODELS: "price_full_m",
  STRIPE_5_MODELS_ANNUAL: "price_full_y",
}));

/** Everything the quota transaction wrote, merged in order. */
let storedDoc: Record<string, unknown> = {};
const txnUpdates: Record<string, unknown>[] = [];
const docRef = { id: "users/uid1" };
const txn = {
  get: async () => ({ exists: true, data: () => storedDoc }),
  update: (_ref: unknown, data: Record<string, unknown>) => {
    txnUpdates.push(data);
    storedDoc = { ...storedDoc, ...data };
  },
};
const updateOutsideTxn = jest.fn(async () => undefined);
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({ doc: () => ({ ...docRef, get: async () => ({ exists: true, data: () => storedDoc }), update: (...a: unknown[]) => updateOutsideTxn(...(a as [])), set: async () => undefined }) }),
    runTransaction: async (fn: (t: typeof txn) => Promise<unknown>) => fn(txn),
  },
}));
jest.mock("firebase-admin/firestore", () => ({ FieldValue: { increment: (n: number) => `INC(${n})`, delete: () => "DELETE" } }));

import { checkAndIncrementUsageForRun } from "../usageCheck";

/** The canonical annual period a reconciliation path would have persisted. */
const CANONICAL_START = { __type: "Timestamp", iso: "2026-08-02T02:33:35.000Z" };
const CANONICAL_END = { __type: "Timestamp", iso: "2027-08-02T02:33:35.000Z" };
const thisMonth = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
};

function seed(args: { usageMonth: string; runsThisMonth: number; billingInterval: "month" | "year" }) {
  storedDoc = {
    plan: "full",
    planFromStripe: "5_models",
    subscriptionStatus: "active",
    subscriptionStatusFromStripe: "active",
    monthlyLimit: 150,
    maxModelsPerRun: 5,
    totalRuns: 100,
    billingInterval: args.billingInterval,
    billingCycleStart: CANONICAL_START,
    currentPeriodEnd: CANONICAL_END,
    usageMonth: args.usageMonth,
    runsThisMonth: args.runsThisMonth,
  };
}

beforeEach(() => {
  txnUpdates.length = 0;
  updateOutsideTxn.mockClear();
});

describe("quota rollover does not own Stripe billing-cycle fields", () => {
  it("REGRESSION (annual): a calendar-month rollover resets usage and leaves the canonical annual period untouched", async () => {
    seed({ usageMonth: "2026-01", runsThisMonth: 149, billingInterval: "year" });
    const res = await checkAndIncrementUsageForRun("uid1", 5);

    expect(res.allowed).toBe(true);
    // Usage rolled over.
    expect(storedDoc.usageMonth).toBe(thisMonth());
    expect(storedDoc.runsThisMonth).toBe(1);
    // Stripe facts untouched — same value AND same type.
    expect(storedDoc.billingCycleStart).toBe(CANONICAL_START);
    expect(storedDoc.currentPeriodEnd).toBe(CANONICAL_END);
    for (const write of txnUpdates) {
      expect(write).not.toHaveProperty("billingCycleStart");
      expect(write).not.toHaveProperty("currentPeriodEnd");
      expect(write).not.toHaveProperty("billingInterval");
    }
  });

  it("REGRESSION (monthly): same ownership boundary for a monthly subscription", async () => {
    seed({ usageMonth: "2026-01", runsThisMonth: 3, billingInterval: "month" });
    await checkAndIncrementUsageForRun("uid1", 3);

    expect(storedDoc.usageMonth).toBe(thisMonth());
    expect(storedDoc.billingCycleStart).toBe(CANONICAL_START);
    expect(storedDoc.billingInterval).toBe("month");
    for (const write of txnUpdates) expect(write).not.toHaveProperty("billingCycleStart");
  });

  it("an in-month increment touches neither the period nor the month marker's value", async () => {
    seed({ usageMonth: thisMonth(), runsThisMonth: 10, billingInterval: "year" });
    await checkAndIncrementUsageForRun("uid1", 2);

    expect(storedDoc.runsThisMonth).toBe("INC(1)");
    expect(storedDoc.billingCycleStart).toBe(CANONICAL_START);
    for (const write of txnUpdates) expect(write).not.toHaveProperty("billingCycleStart");
  });

  it("an annual billing period does not suppress monthly quota renewal", async () => {
    // Stripe period runs Aug 2026 → Aug 2027, but the stored usage month is old.
    seed({ usageMonth: "2026-08", runsThisMonth: 150, billingInterval: "year" });
    const res = await checkAndIncrementUsageForRun("uid1", 5);
    // Quota renewed on the calendar month despite being mid annual period.
    expect(res.allowed).toBe(true);
    expect(storedDoc.runsThisMonth).toBe(1);
  });
});
