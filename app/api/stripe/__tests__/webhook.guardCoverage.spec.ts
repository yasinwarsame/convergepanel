/**
 * Phase BILLING-WEBHOOK-B1-C8, Parts J and K — two load-bearing behaviours the
 * final review found correct but undiscriminated: mutations neutralising each
 * one survived the entire suite.
 *
 * Neither production behaviour changes here. These tests exist so that the
 * guards cannot be deleted by a future refactor without something going red.
 *
 * PART J — the `no_entitlement` stored-subscription guard. When the customer's
 * set proves no entitlement, the handler corrects only a user still recorded
 * against THIS subscription. The isolating case is a drifted document: a
 * subscription reference present but no customer binding. A foreign event
 * carrying a copied uid then bootstraps its own customer (legitimately, on the
 * non-destructive path), enumerates that foreign customer, finds nothing, and
 * without this guard would downgrade the user AND write the foreign customer
 * id onto their record.
 *
 * PART K — `invoice.payment_succeeded` propagation. C2 and C7 stopped the two
 * checkout branches from converting a dependency failure into a successful
 * acknowledgement. The invoice branch has always been correct, but nothing
 * asserted it, so a regression there would have been silent — and a lost
 * invoice reconciliation is how a renewal fails to extend a paid plan.
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
let retrieveFails: string | null = null;
let docWriteFails = false;
const subscriptionsUpdate = jest.fn(async () => ({}));
const subscriptionsRetrieve = jest.fn(async (id: string) => {
  if (retrieveFails === id || retrieveFails === "*") throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
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
import { logger } from "@/lib/logger";
import { POST } from "../webhook/route";

const UID = "uid_customer";
const MINE = "cus_mine";
const FOREIGN = "cus_foreign";
const B = "sub_B_mine";
const F = "sub_F_foreign";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string; customer?: string }) {
  return {
    id: args.id,
    customer: args.customer ?? MINE,
    status: args.status ?? "active",
    metadata: { firebaseUid: UID, targetPlan: "full" },
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: "price_full_y", recurring: { interval: "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Stripe.Subscription;
}
const setLive = (s: Stripe.Subscription) => live.set(s.id, s as unknown as Record<string, unknown>);

async function deliver(type: string, object: unknown) {
  constructEvent.mockReturnValue({ id: "evt_cov", type, data: { object } });
  const req = { text: async () => "{}", headers: { get: (k: string) => (k === "stripe-signature" ? "sig" : null) } } as unknown as NextRequest;
  return (await POST(req)).status;
}

beforeEach(() => {
  live.clear(); writes.length = 0; constructEvent.mockReset();
  subscriptionsList.mockClear(); subscriptionsUpdate.mockClear();
  retrieveFails = null; docWriteFails = false;
  (logger.warn as jest.Mock).mockClear();
});

describe("C8 Part J — the no-entitlement guard protects a drifted record from a foreign event", () => {
  /**
   * Subscription reference present, customer binding absent — real drift, and
   * the only shape where this guard is the last line. The foreign customer
   * holds nothing, so the resolver returns `no_entitlement` and would
   * otherwise authorise the correction.
   */
  function driftedRecordAndForeignEvent() {
    storedDoc = {
      email: "c@example.test", plan: "full", monthlyLimit: 150, maxModelsPerRun: 5,
      stripeSubscriptionId: B, subscriptionStatus: "active", billingInterval: "year",
    };
    setLive(sub({ id: F, status: "canceled", customer: FOREIGN }));
  }

  it("REGRESSION: the paid plan is preserved", async () => {
    driftedRecordAndForeignEvent();
    const before = { ...storedDoc };

    expect(await deliver("customer.subscription.updated", sub({ id: F, status: "canceled", customer: FOREIGN }))).toBe(200);

    expect(writes).toHaveLength(0);
    expect(storedDoc).toEqual(before);
    expect(storedDoc.plan).toBe("full");
  });

  it("REGRESSION: the foreign customer id is never written onto this user", async () => {
    driftedRecordAndForeignEvent();

    await deliver("customer.subscription.updated", sub({ id: F, status: "canceled", customer: FOREIGN }));

    expect(storedDoc.stripeCustomerId).toBeUndefined();
  });

  it("REGRESSION: the stored subscription reference survives", async () => {
    driftedRecordAndForeignEvent();

    await deliver("customer.subscription.updated", sub({ id: F, status: "canceled", customer: FOREIGN }));

    expect(storedDoc.stripeSubscriptionId).toBe(B);
  });

  it("the refusal is observable and names the offending subscription", async () => {
    driftedRecordAndForeignEvent();

    await deliver("customer.subscription.updated", sub({ id: F, status: "canceled", customer: FOREIGN }));

    const refusals = (logger.warn as jest.Mock).mock.calls
      .filter((c) => String(c[0]).includes("not this user's stored subscription"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0][1]).toMatchObject({ subscriptionId: F });
  });

  it("CONTRAST: an event for the user's OWN stored subscription still corrects it", async () => {
    storedDoc = {
      email: "c@example.test", plan: "full", monthlyLimit: 150, maxModelsPerRun: 5,
      stripeCustomerId: MINE, stripeSubscriptionId: B, subscriptionStatus: "active", billingInterval: "year",
    };
    setLive(sub({ id: B, status: "canceled" }));

    expect(await deliver("customer.subscription.updated", sub({ id: B, status: "canceled" }))).toBe(200);

    expect(storedDoc.plan).toBe("free");
  });
});

describe("C8 Part K — a failed invoice reconciliation is retried, never acknowledged", () => {
  beforeEach(() => {
    storedDoc = {
      email: "c@example.test", plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: B,
      subscriptionStatus: "active", billingInterval: "month",
    };
    setLive(sub({ id: B }));
  });

  it("REGRESSION: a Stripe outage retrieving the invoice's subscription returns a retryable 5xx", async () => {
    retrieveFails = B;
    expect(await deliver("invoice.payment_succeeded", { id: "in_1", subscription: B })).toBeGreaterThanOrEqual(500);
    expect(writes).toHaveLength(0);
  });

  it("REGRESSION: a Firestore write failure during invoice reconciliation returns a retryable 5xx", async () => {
    docWriteFails = true;
    expect(await deliver("invoice.payment_succeeded", { id: "in_1", subscription: B })).toBeGreaterThanOrEqual(500);
  });

  it("the healthy retry converges on the renewed plan", async () => {
    retrieveFails = B;
    expect(await deliver("invoice.payment_succeeded", { id: "in_1", subscription: B })).toBeGreaterThanOrEqual(500);

    retrieveFails = null;
    expect(await deliver("invoice.payment_succeeded", { id: "in_1", subscription: B })).toBe(200);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.billingInterval).toBe("year");
  });

  it("an invoice with no subscription is a deliberate 200 no-op", async () => {
    expect(await deliver("invoice.payment_succeeded", { id: "in_1" })).toBe(200);
    expect(writes).toHaveLength(0);
  });
});
