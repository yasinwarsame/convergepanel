/**
 * Phase BILLING-WEBHOOK-B1-C7 — THE LAST LOST-EVENT PATH.
 *
 * `checkout.session.completed` can arrive without a subscription id on the
 * session. The handler then looks the subscription up by customer — and
 * wrapped that lookup in a catch that logged and fell through to
 * `{ received: true }`. A Stripe timeout there was therefore reported to
 * Stripe as a successful delivery, so it was never retried, and a brand-new
 * customer's only checkout event was lost permanently. Request-time
 * reconciliation cannot repair them: it returns early for a free plan.
 *
 * C2 fixed exactly this shape on the primary checkout branch. This is the
 * sibling branch it missed. The invariant is unchanged: a transient
 * dependency failure is not a successful delivery.
 *
 * A checkout that is genuinely not a subscription purchase is a different
 * thing — conclusively nothing to reconcile — and stays a deliberate 200.
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
const live = new Map<string, Record<string, unknown>>();
let listFails = false;
let docWriteFails = false;
const subscriptionsUpdate = jest.fn(async () => ({}));
const subscriptionsRetrieve = jest.fn(async (id: string) => {
  const s = live.get(id);
  if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });
  return s;
});
const subscriptionsList = jest.fn(async (args: { customer?: string }) => {
  if (listFails) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  return { data: [...live.values()].filter((s) => s.customer === args.customer), has_more: false };
});
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
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
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
const C = "sub_C_full_annual";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string }) {
  return {
    id: args.id,
    customer: MINE,
    status: args.status ?? "active",
    metadata: { firebaseUid: UID, targetPlan: "full" },
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: "price_full_y", recurring: { interval: "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Stripe.Subscription;
}
const setLive = (s: Stripe.Subscription) => live.set(s.id, s as unknown as Record<string, unknown>);

async function deliver(object: unknown) {
  constructEvent.mockReturnValue({ id: "evt_checkout", type: "checkout.session.completed", data: { object } });
  const req = { text: async () => "{}", headers: { get: (k: string) => (k === "stripe-signature" ? "sig" : null) } } as unknown as NextRequest;
  return (await POST(req)).status;
}

beforeEach(() => {
  live.clear(); writes.length = 0; constructEvent.mockReset();
  subscriptionsList.mockClear(); subscriptionsUpdate.mockClear();
  listFails = false; docWriteFails = false;
  storedDoc = { email: "c@example.test", plan: "free" };
});

describe("C7 P1 — a transient failure in the checkout fallback is not a successful delivery", () => {
  it("REGRESSION: a Stripe outage during the customer lookup returns a retryable 5xx, not 200", async () => {
    listFails = true;
    expect(await deliver({ id: "cs_1", mode: "subscription", customer: MINE, metadata: { firebaseUid: UID } })).toBeGreaterThanOrEqual(500);
    expect(writes).toHaveLength(0);
  });

  it("REGRESSION: a Firestore write failure while reconciling the fallback subscription returns 5xx", async () => {
    setLive(sub({ id: C }));
    docWriteFails = true;
    expect(await deliver({ id: "cs_1", mode: "subscription", customer: MINE, metadata: { firebaseUid: UID } })).toBeGreaterThanOrEqual(500);
  });

  it("the retry after the outage converges on the correct plan", async () => {
    setLive(sub({ id: C }));
    listFails = true;
    expect(await deliver({ id: "cs_1", mode: "subscription", customer: MINE, metadata: { firebaseUid: UID } })).toBeGreaterThanOrEqual(500);

    listFails = false;
    expect(await deliver({ id: "cs_1", mode: "subscription", customer: MINE, metadata: { firebaseUid: UID } })).toBe(200);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(C);
  });

  it("a duplicate successful fallback delivery converges", async () => {
    setLive(sub({ id: C }));
    await deliver({ id: "cs_1", mode: "subscription", customer: MINE, metadata: { firebaseUid: UID } });
    const first = { ...storedDoc };
    expect(await deliver({ id: "cs_1", mode: "subscription", customer: MINE, metadata: { firebaseUid: UID } })).toBe(200);
    expect(storedDoc.plan).toBe(first.plan);
    expect(storedDoc.stripeSubscriptionId).toBe(first.stripeSubscriptionId);
  });
});

describe("C7 — conclusively-nothing-to-do checkouts stay a deliberate 200", () => {
  it("a customer with genuinely no subscriptions is a safe no-op", async () => {
    expect(await deliver({ id: "cs_1", mode: "subscription", customer: MINE, metadata: { firebaseUid: UID } })).toBe(200);
    expect(writes).toHaveLength(0);
  });

  it("a one-time payment checkout is not a subscription event", async () => {
    expect(await deliver({ id: "cs_1", mode: "payment", customer: MINE, metadata: { firebaseUid: UID } })).toBe(200);
    expect(subscriptionsList).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("a session with no customer at all is a safe no-op", async () => {
    expect(await deliver({ id: "cs_1", mode: "subscription", metadata: { firebaseUid: UID } })).toBe(200);
    expect(writes).toHaveLength(0);
  });
});
