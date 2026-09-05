/**
 * Phase BILLING-WEBHOOK-B1-C6 — THE STRIPE METADATA BACKFILL IS A MUTATION,
 * NOT BOOKKEEPING.
 *
 * The C5-R1 exact-head review proved by execution that both backfill sites
 * wrote the application's `firebaseUid` onto a Stripe subscription BEFORE any
 * of the checks that establish the right to act on it: customer association,
 * stale-event resolution, and customer-set authority. Firestore was correctly
 * refused afterwards in every case, but Stripe had already been mutated — so
 * a stale historical subscription, a FOREIGN customer's subscription carrying
 * a copied uid, and one arbitrary half of an ambiguous pair all received an
 * application identity the application had no authority to write.
 *
 * The contract these tests pin: a subscription receives application identity
 * metadata only after it has been positively established as the ONE
 * authoritative subscription of a verified customer.
 */

process.env.STRIPE_PRICE_3_MODELS = "price_lite_m";
process.env.STRIPE_3_MODELS_ANNUAL = "price_lite_y";
process.env.STRIPE_PRICE_5_MODELS = "price_full_m";
process.env.STRIPE_5_MODELS_ANNUAL = "price_full_y";

jest.mock("@/lib/env", () => ({
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_3_MODELS: "price_lite_m",
  STRIPE_3_MODELS_ANNUAL: "price_lite_y",
  STRIPE_PRICE_5_MODELS: "price_full_m",
  STRIPE_5_MODELS_ANNUAL: "price_full_y",
}));

const constructEvent = jest.fn();
let updateFails = false;
const subscriptionsUpdate = jest.fn(async () => {
  if (updateFails) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  return {};
});
const live = new Map<string, Record<string, unknown>>();
const subscriptionsRetrieve = jest.fn(async (id: string) => {
  const s = live.get(id);
  if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });
  return s;
});
const subscriptionsList = jest.fn(async (args: { customer?: string }) => ({
  data: [...live.values()].filter((s) => s.customer === args.customer),
  has_more: false,
}));
const customersRetrieve = jest.fn(async () => ({ deleted: false, metadata: {} }));
jest.mock("@/lib/stripe/client", () => ({
  stripe: {
    webhooks: { constructEvent: (...a: unknown[]) => constructEvent(...a) },
    customers: { retrieve: (...a: unknown[]) => customersRetrieve(...(a as [])) },
    subscriptions: {
      update: (...a: unknown[]) => subscriptionsUpdate(...(a as [])),
      retrieve: (...a: unknown[]) => subscriptionsRetrieve(...(a as [string])),
      list: (...a: unknown[]) => subscriptionsList(...(a as [{ customer?: string }])),
    },
  },
}));

let storedDoc: Record<string, unknown> = {};
const writes: Record<string, unknown>[] = [];
let queryEmpty = true;
let docWriteFails = false;
const docHandle = {
  get: async () => ({ exists: true, data: () => storedDoc }),
  set: async (d: Record<string, unknown>) => {
    if (docWriteFails) throw Object.assign(new Error("UNAVAILABLE"), { code: 14 });
    writes.push(d); storedDoc = { ...storedDoc, ...d };
  },
  update: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: () => docHandle,
      where: () => ({ limit: () => ({ get: async () => ({ empty: queryEmpty, docs: queryEmpty ? [] : [{ id: UID }] }) }) }),
    }),
  },
  firebaseAdmin: {
    firestore: {
      Timestamp: { now: () => "TS_NOW", fromDate: (d: Date) => `TS_${d.toISOString()}` },
      FieldValue: { delete: () => "DELETE" },
    },
  },
}));
jest.mock("@/lib/posthog-server", () => ({ getPostHogClient: () => ({ capture: jest.fn(), flush: jest.fn(async () => undefined) }) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import type Stripe from "stripe";
import type { NextRequest } from "next/server";
import { POST } from "../webhook/route";

const UID = "uid_customer";
const MINE = "cus_mine";
const FOREIGN = "cus_foreign";
const A = "sub_A_dead";
const B = "sub_B_lite_monthly";
const C = "sub_C_full_annual";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string; priceId?: string; interval?: "month" | "year"; customer?: string; uid?: string | null }) {
  const metadata: Record<string, string> = { targetPlan: "full" };
  if (args.uid !== null) metadata.firebaseUid = args.uid ?? UID;
  return {
    id: args.id,
    customer: args.customer ?? MINE,
    status: args.status ?? "active",
    metadata,
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: args.priceId ?? "price_full_y", recurring: { interval: args.interval ?? "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Stripe.Subscription;
}
const setLive = (s: Stripe.Subscription) => live.set(s.id, s as unknown as Record<string, unknown>);
const subB = () => sub({ id: B, priceId: "price_lite_m", interval: "month" });
const subC = () => sub({ id: C, priceId: "price_full_y", interval: "year" });

async function deliver(type: string, object: unknown) {
  constructEvent.mockReturnValue({ id: "evt_" + Math.random().toString(36).slice(2), type, data: { object } });
  const req = { text: async () => "{}", headers: { get: (k: string) => (k === "stripe-signature" ? "sig" : null) } } as unknown as NextRequest;
  return (await POST(req)).status;
}
/** Every Stripe subscription id this delivery wrote metadata to. */
const backfilled = () => subscriptionsUpdate.mock.calls.map((c) => (c as unknown as [string])[0]);

function reset() {
  live.clear(); writes.length = 0; constructEvent.mockReset();
  subscriptionsUpdate.mockClear(); subscriptionsList.mockClear();
  queryEmpty = true; updateFails = false; docWriteFails = false;
}
beforeEach(reset);

describe("C6 P1 — no application identity is written to a subscription we have no authority over", () => {
  it("REGRESSION: a STALE historical subscription is never backfilled while another is authoritative", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: C, plan: "full", subscriptionStatus: "active", billingInterval: "year" };
    queryEmpty = false;
    setLive(sub({ id: A, status: "canceled", uid: null }));
    setLive(subC());

    expect(await deliver("customer.subscription.updated", sub({ id: A, status: "canceled", uid: null }))).toBe(200);

    expect(backfilled()).not.toContain(A);
  });

  it("REGRESSION: a stale CHECKOUT session for a historical subscription does not backfill it", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: C, plan: "full", subscriptionStatus: "active", billingInterval: "year" };
    setLive(sub({ id: A, status: "canceled", uid: null }));
    setLive(subC());

    expect(await deliver("checkout.session.completed", {
      id: "cs_stale", mode: "subscription", subscription: A, customer: MINE,
      metadata: { firebaseUid: UID, targetPlan: "full" },
    })).toBe(200);

    expect(backfilled()).not.toContain(A);
  });

  it("REGRESSION: a FOREIGN customer's subscription carrying a copied uid is never backfilled", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: C, plan: "full", subscriptionStatus: "active", billingInterval: "year" };
    setLive(sub({ id: "sub_foreign", customer: FOREIGN, uid: null }));
    setLive(subC());

    expect(await deliver("checkout.session.completed", {
      id: "cs_foreign", mode: "subscription", subscription: "sub_foreign", customer: FOREIGN,
      metadata: { firebaseUid: UID, targetPlan: "full" },
    })).toBe(200);

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("REGRESSION: a foreign subscription found only by a Firestore customer-id lookup is not backfilled", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: C, plan: "full", subscriptionStatus: "active", billingInterval: "year" };
    queryEmpty = false;
    setLive(sub({ id: "sub_foreign", customer: FOREIGN, uid: null }));
    setLive(subC());

    expect(await deliver("customer.subscription.updated", sub({ id: "sub_foreign", customer: FOREIGN, uid: null }))).toBe(200);

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("REGRESSION: with B and C both plan-bearing, NEITHER is backfilled", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "free", subscriptionStatus: "canceled" };
    queryEmpty = false;
    setLive(sub({ id: A, status: "canceled", uid: null }));
    setLive(sub({ id: B, priceId: "price_lite_m", interval: "month", uid: null }));
    setLive(sub({ id: C, priceId: "price_full_y", interval: "year", uid: null }));

    expect(await deliver("customer.subscription.updated", sub({ id: B, priceId: "price_lite_m", interval: "month", uid: null }))).toBe(200);

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("REGRESSION: a deletion event never writes metadata", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "full", subscriptionStatus: "active" };
    setLive(sub({ id: A, status: "canceled", uid: null }));

    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled", uid: null }))).toBe(200);

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("REGRESSION: an unverifiable association writes no metadata even when the event carries the uid", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: C, plan: "full", subscriptionStatus: "active", billingInterval: "year" };
    setLive(sub({ id: "sub_foreign", customer: FOREIGN, uid: null }));

    expect(await deliver("customer.subscription.updated", sub({ id: "sub_foreign", customer: FOREIGN, uid: null }))).toBe(200);

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });
});

describe("C6 — the authoritative subscription is still backfilled, so future lookups keep working", () => {
  it("a legitimate first checkout backfills the one authoritative subscription", async () => {
    storedDoc = { email: "c@example.test", plan: "free" };
    setLive(sub({ id: C, uid: null }));

    expect(await deliver("checkout.session.completed", {
      id: "cs_1", mode: "subscription", subscription: C, customer: MINE,
      metadata: { firebaseUid: UID, targetPlan: "full" },
    })).toBe(200);

    expect(backfilled()).toEqual([C]);
    expect((subscriptionsUpdate.mock.calls[0] as unknown as [string, { metadata: Record<string, string> }])[1].metadata.firebaseUid).toBe(UID);
    expect(storedDoc.plan).toBe("full");
  });

  it("a subscription that already carries the uid is not written again", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: C, plan: "full", subscriptionStatus: "active", billingInterval: "year" };
    setLive(subC());

    await deliver("customer.subscription.updated", subC());

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("a stale trigger backfills the AUTHORITATIVE subscription, never the stale one", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "free", subscriptionStatus: "canceled" };
    queryEmpty = false;
    setLive(sub({ id: A, status: "canceled", uid: null }));
    setLive(sub({ id: C, uid: null }));

    expect(await deliver("customer.subscription.updated", sub({ id: A, status: "canceled", uid: null }))).toBe(200);

    expect(backfilled()).toEqual([C]);
  });

  it("the legacy snake_case key is accepted as already-present identity", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: C, plan: "full", subscriptionStatus: "active", billingInterval: "year" };
    const legacy = sub({ id: C, uid: null }) as unknown as { metadata: Record<string, string> };
    legacy.metadata.firebase_uid = UID;
    setLive(legacy as unknown as Stripe.Subscription);

    await deliver("customer.subscription.updated", legacy as unknown as Stripe.Subscription);

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });
});

describe("C6 — backfill failure policy: optional metadata must not block billing", () => {
  it("a failed metadata write still lets the billing reconciliation complete", async () => {
    storedDoc = { email: "c@example.test", plan: "free" };
    setLive(sub({ id: C, uid: null }));
    updateFails = true;

    expect(await deliver("checkout.session.completed", {
      id: "cs_1", mode: "subscription", subscription: C, customer: MINE,
      metadata: { firebaseUid: UID, targetPlan: "full" },
    })).toBe(200);

    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(C);
  });

  it("a Firestore failure after a successful metadata write stays retryable, and the retry converges", async () => {
    storedDoc = { email: "c@example.test", plan: "free" };
    setLive(sub({ id: C, uid: null }));
    docWriteFails = true;

    expect(await deliver("checkout.session.completed", {
      id: "cs_1", mode: "subscription", subscription: C, customer: MINE,
      metadata: { firebaseUid: UID, targetPlan: "full" },
    })).toBe(500);

    docWriteFails = false;
    expect(await deliver("checkout.session.completed", {
      id: "cs_1", mode: "subscription", subscription: C, customer: MINE,
      metadata: { firebaseUid: UID, targetPlan: "full" },
    })).toBe(200);

    expect(storedDoc.plan).toBe("full");
    for (const id of backfilled()) expect(id).toBe(C);
  });

  it("a duplicate legitimate delivery writes the same idempotent metadata value", async () => {
    storedDoc = { email: "c@example.test", plan: "free" };
    setLive(sub({ id: C, uid: null }));

    await deliver("checkout.session.completed", { id: "cs_1", mode: "subscription", subscription: C, customer: MINE, metadata: { firebaseUid: UID, targetPlan: "full" } });
    await deliver("checkout.session.completed", { id: "cs_1", mode: "subscription", subscription: C, customer: MINE, metadata: { firebaseUid: UID, targetPlan: "full" } });

    for (const call of subscriptionsUpdate.mock.calls) {
      const [id, body] = call as unknown as [string, { metadata: Record<string, string> }];
      expect(id).toBe(C);
      expect(body.metadata.firebaseUid).toBe(UID);
    }
    expect(storedDoc.plan).toBe("full");
  });
});
