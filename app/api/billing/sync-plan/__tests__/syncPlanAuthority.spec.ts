/**
 * Phase BILLING-WEBHOOK-B1-C7 — THE LAST AUTOMATIC BILLING WRITER.
 *
 * C6 unified the webhook and request-time reconciliation onto one customer-set
 * authority contract, then found a third writer still outside it: the
 * self-serve plan-sync endpoint. It is not a quiet admin tool. The billing
 * page invokes it automatically on the post-checkout redirect, and any
 * authenticated user can invoke it for their own account. It carried the old
 * rule — list ten subscriptions, ignore `has_more`, sort by `created`, take
 * the newest — so it could resolve, on the very next page load, exactly the
 * ambiguity the other two writers had explicitly refused.
 *
 * It also called the plan-change usage reset unconditionally, which made it
 * the BILLING-USAGE-Q1 exploit: an authenticated user could zero their own
 * monthly run counter by asking the product to re-check their plan. Those two
 * defects live in the same request handler and are corrected together.
 *
 * THE RULE THIS SPEC PINS. Billing synchronization owns Stripe identity, plan,
 * cadence and billing-cycle facts. It does not own run usage. Only the
 * calendar-month quota transition may reset usage.
 */

process.env.STRIPE_PRICE_3_MODELS = "price_lite_m";
process.env.STRIPE_3_MODELS_ANNUAL = "price_lite_y";
process.env.STRIPE_PRICE_5_MODELS = "price_full_m";
process.env.STRIPE_5_MODELS_ANNUAL = "price_full_y";

jest.mock("@/lib/env", () => ({
  STRIPE_PRICE_3_MODELS: "price_lite_m",
  STRIPE_3_MODELS_ANNUAL: "price_lite_y",
  STRIPE_PRICE_5_MODELS: "price_full_m",
  STRIPE_5_MODELS_ANNUAL: "price_full_y",
}));

type Sub = Record<string, unknown> & { id: string; customer: string; status: string; created: number };

let live: Sub[] = [];
let listFails = false;
let listFailsOnCall = 0;
let customerMissing = false;
let listCalls = 0;

const subscriptionsList = jest.fn(async (args: { customer?: string; starting_after?: string; limit?: number }) => {
  listCalls += 1;
  if (listFails) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  if (listFailsOnCall === listCalls) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  if (customerMissing) throw Object.assign(new Error("No such customer"), { code: "resource_missing", statusCode: 404 });
  const all = live.filter((s) => s.customer === args.customer);
  const limit = args.limit ?? 10;
  let start = 0;
  if (args.starting_after) start = all.findIndex((s) => s.id === args.starting_after) + 1;
  return { data: all.slice(start, start + limit), has_more: start + limit < all.length };
});
const customersRetrieve = jest.fn(async () => {
  if (customerMissing) throw Object.assign(new Error("No such customer"), { code: "resource_missing", statusCode: 404 });
  return { id: "cus_mine", deleted: false, metadata: {} };
});
jest.mock("@/lib/stripe/client", () => ({
  stripe: {
    customers: { retrieve: (...a: unknown[]) => customersRetrieve(...(a as [])) },
    subscriptions: { list: (...a: unknown[]) => subscriptionsList(...(a as [{ customer?: string }])) },
  },
}));

let storedDoc: Record<string, unknown> = {};
const writes: Record<string, unknown>[] = [];
const docHandle = {
  get: async () => ({ exists: true, data: () => storedDoc }),
  set: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
  update: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => docHandle }) },
  firebaseAdmin: {
    firestore: {
      Timestamp: { now: () => "TS_NOW", fromDate: (d: Date) => `TS_${d.toISOString()}` },
      FieldValue: { delete: () => "DELETE" },
    },
  },
}));

let authUid: string | null = "uid_customer";
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: async () =>
    authUid ? { status: "authenticated", uid: authUid, source: "bearer" } : { status: "unauthenticated", reason: "missing_credentials" },
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { POST } from "../route";

const UID = "uid_customer";
const MINE = "cus_mine";
const A = "sub_A_dead";
const B = "sub_B_lite_monthly";
const C = "sub_C_full_annual";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string; priceId?: string; interval?: "month" | "year"; customer?: string; created?: number }): Sub {
  return {
    id: args.id,
    customer: args.customer ?? MINE,
    status: args.status ?? "active",
    created: args.created ?? 1,
    metadata: { firebaseUid: UID },
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: args.priceId ?? "price_full_y", recurring: { interval: args.interval ?? "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Sub;
}
const subB = (created = 100) => sub({ id: B, priceId: "price_lite_m", interval: "month", created });
const subC = (created = 200) => sub({ id: C, priceId: "price_full_y", interval: "year", created });

async function syncPlan(body: Record<string, unknown> = {}) {
  const req = { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}

/** Every usage counter a run consumes. None of them belongs to billing sync. */
const USAGE = { usageMonth: "2026-09", runsThisMonth: 7, videoRunsThisMonth: 4, tokensUsedCurrentPeriod: 120_000, totalRuns: 210 };
const usageOf = (d: Record<string, unknown>) => ({
  usageMonth: d.usageMonth, runsThisMonth: d.runsThisMonth, videoRunsThisMonth: d.videoRunsThisMonth,
  tokensUsedCurrentPeriod: d.tokensUsedCurrentPeriod, totalRuns: d.totalRuns,
});
const billingOf = (d: Record<string, unknown>) => ({
  plan: d.plan, billingInterval: d.billingInterval,
  subscriptionId: d.stripeSubscriptionId, subscriptionStatus: d.subscriptionStatus,
});
const ambiguityRecords = () =>
  (logger.error as jest.Mock).mock.calls.filter((c) => (c[1] as { code?: string })?.code === "multiple_entitlement_subscriptions");

function reset() {
  live = []; writes.length = 0; listCalls = 0;
  subscriptionsList.mockClear(); customersRetrieve.mockClear();
  listFails = false; listFailsOnCall = 0; customerMissing = false; authUid = UID;
  (logger.error as jest.Mock).mockClear();
  (logger.warn as jest.Mock).mockClear();
  storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year", ...USAGE };
}
beforeEach(reset);

// ---------------------------------------------------------------------------
// BILLING-USAGE-Q1
// ---------------------------------------------------------------------------

describe("C7 P1 — BILLING-USAGE-Q1: self-sync must not be a usage reset", () => {
  it("REGRESSION: the exploit — an authenticated user cannot zero their own run counter", async () => {
    live = [subC()];
    await syncPlan();
    expect(storedDoc.runsThisMonth).toBe(7);
  });

  it("REGRESSION: no usage counter of any kind is touched", async () => {
    live = [subC()];
    await syncPlan();
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("REGRESSION: five repeated self-syncs cannot grind usage down", async () => {
    live = [subC()];
    for (let i = 0; i < 5; i++) await syncPlan();
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("REGRESSION: concurrent self-syncs cannot lower usage", async () => {
    live = [subC()];
    await Promise.all([syncPlan(), syncPlan(), syncPlan(), syncPlan()]);
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("REGRESSION: the zero-candidate downgrade does not reset usage either", async () => {
    live = [sub({ id: A, status: "canceled" })];
    await syncPlan();
    expect(storedDoc.plan).toBe("free");
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("REGRESSION: the ambiguous case does not reset usage", async () => {
    live = [subB(), subC()];
    await syncPlan();
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("a past_due user's usage is untouched", async () => {
    const c = subC(); c.status = "past_due";
    live = [c];
    await syncPlan();
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("an annual user's usage is untouched", async () => {
    storedDoc = { ...storedDoc, plan: "lite", billingInterval: "month" };
    live = [subC()];
    await syncPlan();
    expect(storedDoc.plan).toBe("full");
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("REGRESSION: no write from this route ever contains a usage field", async () => {
    live = [subC()];
    await syncPlan();
    live = [sub({ id: A, status: "canceled" })];
    await syncPlan();
    for (const w of writes) {
      for (const key of ["runsThisMonth", "usageMonth", "videoRunsThisMonth", "tokensUsedCurrentPeriod", "totalRuns"]) {
        expect(w).not.toHaveProperty(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AUTHORITY
// ---------------------------------------------------------------------------

describe("C7 P1 — self-sync must not resolve what the other writers refused", () => {
  it("REGRESSION: two plan-bearing candidates are ambiguous — no authority write", async () => {
    live = [subB(), subC()];
    const before = { ...storedDoc };
    await syncPlan();
    expect(writes).toHaveLength(0);
    expect(storedDoc).toEqual(before);
  });

  it("REGRESSION: reversing Stripe's array order gives a byte-identical result", async () => {
    live = [subB(), subC()];
    await syncPlan();
    const forward = { ...storedDoc };
    reset();
    live = [subC(), subB()];
    await syncPlan();
    expect(storedDoc).toEqual(forward);
  });

  it("REGRESSION: equal creation timestamps produce no winner, in either order", async () => {
    live = [subB(500), subC(500)];
    await syncPlan();
    expect(storedDoc.stripeSubscriptionId).toBe(A);
    reset();
    live = [subC(500), subB(500)];
    await syncPlan();
    expect(storedDoc.stripeSubscriptionId).toBe(A);
  });

  it("REGRESSION: a candidate is not selected merely because it is already stored", async () => {
    storedDoc = { ...storedDoc, stripeSubscriptionId: B, plan: "lite", billingInterval: "month" };
    live = [subB(), subC()];
    await syncPlan();
    expect(writes).toHaveLength(0);
    expect(storedDoc.stripeSubscriptionId).toBe(B);
  });

  it("REGRESSION: with no stored subscription, neither candidate is arbitrarily bound", async () => {
    delete storedDoc.stripeSubscriptionId;
    live = [subB(), subC()];
    await syncPlan();
    expect(writes).toHaveLength(0);
    expect(storedDoc.stripeSubscriptionId).toBeUndefined();
  });

  it("the refusal is observable under the shared classification", async () => {
    live = [subB(), subC()];
    await syncPlan();
    const records = ambiguityRecords();
    expect(records).toHaveLength(1);
    expect(records[0][1]).toMatchObject({
      code: "multiple_entitlement_subscriptions",
      path: "self_serve_plan_sync",
      stripeCustomerId: MINE,
      uid: UID,
      storedSubscriptionId: A,
      candidateCount: 2,
      resolution: "no_mutation_ambiguous_subscription_set",
    });
  });

  it("the response does not claim a plan was selected", async () => {
    live = [subB(), subC()];
    const { status, body } = await syncPlan();
    expect(status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(body)).not.toContain(B);
    expect(JSON.stringify(body)).not.toContain(C);
    expect(body.success).not.toBe(true);
  });

  it("the ambiguity record carries no secret or payment detail", async () => {
    live = [subB(), subC()];
    await syncPlan();
    expect(JSON.stringify(ambiguityRecords()[0])).not.toMatch(/sk_live|sk_test|whsec_|card|payment_method/i);
  });
});

describe("C7 P1 — self-sync enumerates exhaustively", () => {
  it("REGRESSION: ten irrelevant subscriptions must not hide the authoritative one", async () => {
    storedDoc = { ...storedDoc, plan: "lite", billingInterval: "month" };
    live = [...Array.from({ length: 10 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled", created: 1000 + i })), subC(1)];
    await syncPlan();
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(C);
  });

  it("REGRESSION: the authoritative subscription is found beyond the first PAGE", async () => {
    storedDoc = { ...storedDoc, plan: "lite", billingInterval: "month" };
    live = [...Array.from({ length: 100 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled", created: 1000 + i })), subC(1)];
    await syncPlan();
    expect(subscriptionsList.mock.calls.length).toBeGreaterThan(1);
    expect(storedDoc.stripeSubscriptionId).toBe(C);
  });

  it("B on page one and C on page two is ambiguity, not a page-one win", async () => {
    live = [subB(1), ...Array.from({ length: 99 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled", created: 1000 + i })), subC(2)];
    await syncPlan();
    expect(writes).toHaveLength(0);
    expect(ambiguityRecords()).toHaveLength(1);
  });

  it("zero is concluded only after the listing is exhausted", async () => {
    live = Array.from({ length: 150 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled", created: 1000 + i }));
    await syncPlan();
    expect(subscriptionsList.mock.calls.length).toBeGreaterThan(1);
    expect(storedDoc.plan).toBe("free");
  });

  it("REGRESSION: a failure fetching page two must not conclude no-subscription", async () => {
    live = [...Array.from({ length: 100 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled", created: 1000 + i })), subC(1)];
    listFailsOnCall = 2;
    const { status } = await syncPlan();
    expect(status).toBeGreaterThanOrEqual(500);
    expect(writes).toHaveLength(0);
    expect(storedDoc.plan).toBe("full");
  });
});

describe("C7 — self-sync dependency failures never fall back destructively", () => {
  it("a Stripe outage preserves billing state and usage", async () => {
    listFails = true;
    const { status } = await syncPlan();
    expect(status).toBeGreaterThanOrEqual(500);
    expect(writes).toHaveLength(0);
    expect(storedDoc.plan).toBe("full");
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("REGRESSION: a definitively missing customer is not authority to downgrade", async () => {
    customerMissing = true;
    await syncPlan();
    expect(writes).toHaveLength(0);
    expect(storedDoc.plan).toBe("full");
  });

  it("a healthy retry after an outage converges", async () => {
    listFails = true;
    await syncPlan();
    listFails = false;
    live = [subC()];
    storedDoc = { ...storedDoc, plan: "lite", billingInterval: "month" };
    const { status } = await syncPlan();
    expect(status).toBe(200);
    expect(storedDoc.stripeSubscriptionId).toBe(C);
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });
});

describe("C7 — the legitimate post-checkout flow still works", () => {
  it("a free user with exactly one new subscription is upgraded", async () => {
    storedDoc = { plan: "free", stripeCustomerId: MINE, ...USAGE };
    live = [subC()];
    const { status, body } = await syncPlan();
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(billingOf(storedDoc)).toEqual({ plan: "full", billingInterval: "year", subscriptionId: C, subscriptionStatus: "active" });
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("a stale local subscription is replaced by the one current candidate", async () => {
    live = [sub({ id: A, status: "canceled" }), subC()];
    storedDoc = { ...storedDoc, plan: "lite", billingInterval: "month" };
    await syncPlan();
    expect(storedDoc.stripeSubscriptionId).toBe(C);
  });

  it("syncing twice is idempotent", async () => {
    storedDoc = { plan: "free", stripeCustomerId: MINE, ...USAGE };
    live = [subC()];
    await syncPlan();
    const first = { ...storedDoc };
    await syncPlan();
    expect(billingOf(storedDoc)).toEqual(billingOf(first));
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("REGRESSION: the canonical item-level period is used, never the current time", async () => {
    storedDoc = { plan: "free", stripeCustomerId: MINE, ...USAGE };
    live = [subC()];
    await syncPlan();
    expect(storedDoc.billingCycleStart).toBe(`TS_${new Date(AUG_2_2026 * 1000).toISOString()}`);
  });

  it("a lone past_due subscription keeps its billing identity", async () => {
    const c = subC(); c.status = "past_due";
    live = [c];
    storedDoc = { ...storedDoc, plan: "lite", billingInterval: "month" };
    await syncPlan();
    expect(storedDoc.stripeSubscriptionId).toBe(C);
    expect(storedDoc.subscriptionStatus).toBe("past_due");
  });
});

describe("C7 — security: self-sync confers no authority a user could steer", () => {
  it("a user cannot sync another account", async () => {
    live = [subC()];
    const { status } = await syncPlan({ targetUid: "someone_else" });
    expect(status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("REGRESSION: a caller-supplied Stripe customer id cannot steer reconciliation", async () => {
    live = [sub({ id: "sub_foreign", customer: "cus_foreign" })];
    await syncPlan({ stripeCustomerId: "cus_foreign", customerId: "cus_foreign" });
    expect(subscriptionsList.mock.calls.every((c) => (c[0] as { customer?: string })?.customer === MINE)).toBe(true);
    expect(storedDoc.stripeCustomerId).toBe(MINE);
  });

  it("REGRESSION: a caller-supplied subscription id cannot become authority", async () => {
    live = [sub({ id: A, status: "canceled" }), subC()];
    storedDoc = { ...storedDoc, plan: "lite", billingInterval: "month" };
    await syncPlan({ subscriptionId: A });
    expect(storedDoc.stripeSubscriptionId).toBe(C);
  });

  it("an unauthenticated caller is rejected and writes nothing", async () => {
    authUid = null;
    live = [subC()];
    const { status } = await syncPlan();
    expect(status).toBe(401);
    expect(writes).toHaveLength(0);
  });
});

describe("C7 — the admin override survives self-sync", () => {
  const OVERRIDE = { override: { active: true } };

  it("exactly one candidate reconciles and the override is untouched", async () => {
    storedDoc = { ...storedDoc, plan: "lite", billingInterval: "month", ...OVERRIDE };
    live = [subC()];
    await syncPlan();
    expect(storedDoc.stripeSubscriptionId).toBe(C);
    expect((storedDoc as { override?: { active?: boolean } }).override?.active).toBe(true);
  });

  it("ambiguity writes nothing and leaves the override intact", async () => {
    storedDoc = { ...storedDoc, ...OVERRIDE };
    live = [subB(), subC()];
    await syncPlan();
    expect(writes).toHaveLength(0);
    expect((storedDoc as { override?: { active?: boolean } }).override?.active).toBe(true);
  });

  it("REGRESSION: an override blocks the zero-candidate downgrade", async () => {
    storedDoc = { ...storedDoc, ...OVERRIDE };
    live = [sub({ id: A, status: "canceled" })];
    await syncPlan();
    expect(storedDoc.plan).toBe("full");
  });

  it("a dependency failure leaves an overridden user untouched", async () => {
    storedDoc = { ...storedDoc, ...OVERRIDE };
    listFails = true;
    await syncPlan();
    expect(writes).toHaveLength(0);
    expect(storedDoc.plan).toBe("full");
  });
});
