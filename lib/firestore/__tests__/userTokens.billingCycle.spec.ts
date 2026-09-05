/**
 * Phase BILLING-WEBHOOK-B1-C2 — the sixth fabricated billing-cycle writer.
 *
 * `billingCycleStart` is a Stripe billing fact, derived from the plan-bearing
 * subscription item and written only by the reconciliation paths. Token
 * bookkeeping reads it to decide its own period; it does not own it.
 *
 * The exact-head review found this branch stamping a `Date.now()`-derived
 * value for any user who lacked one. It was guarded by "only if absent", so it
 * could not clobber an existing canonical value — but it could invent one for
 * a paid user whose subscription reports no period, which is exactly the case
 * the reconciliation paths deliberately leave untouched.
 */

jest.mock("@/lib/env", () => ({}));

let storedDoc: Record<string, unknown> = {};
const writes: Record<string, unknown>[] = [];
const docHandle = {
  get: async () => ({ exists: true, data: () => storedDoc }),
  set: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
  update: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => docHandle }) },
}));
jest.mock("firebase-admin/firestore", () => ({
  Timestamp: {
    now: () => ({ toDate: () => new Date() }),
    fromDate: (d: Date) => ({ __fabricated: true, iso: d.toISOString(), toDate: () => d }),
  },
  FieldValue: { serverTimestamp: () => "SERVER_TS", increment: (n: number) => `INC(${n})` },
}));

import { incrementUserTokenUsage } from "../userTokens";

beforeEach(() => {
  writes.length = 0;
});

describe("token bookkeeping does not own billingCycleStart", () => {
  it("REGRESSION: a user with NO billingCycleStart does not get one fabricated from the current time", async () => {
    storedDoc = { plan: "full", billingInterval: "year", tokensUsedCurrentPeriod: 0 };

    await incrementUserTokenUsage("uid1", 1234);

    for (const w of writes) expect(w).not.toHaveProperty("billingCycleStart");
    expect(storedDoc).not.toHaveProperty("billingCycleStart");
  });

  it("REGRESSION: a free user with no billing cycle also gets none fabricated", async () => {
    storedDoc = { plan: "free", tokensUsedCurrentPeriod: 0 };

    await incrementUserTokenUsage("uid1", 500);

    for (const w of writes) expect(w).not.toHaveProperty("billingCycleStart");
  });

  it("token usage itself is still recorded", async () => {
    storedDoc = { plan: "full", billingInterval: "year", tokensUsedCurrentPeriod: 0 };

    const res = await incrementUserTokenUsage("uid1", 777);

    expect(writes.length).toBeGreaterThan(0);
    expect(res.tokensUsedCurrentPeriod).toBeGreaterThan(0);
  });
});
