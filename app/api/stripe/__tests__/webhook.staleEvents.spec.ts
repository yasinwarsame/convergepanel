/**
 * Phase BILLING-WEBHOOK-B1-C1 — out-of-order and cross-subscription delivery.
 *
 * The exact-head review of PR #145 proved by execution that the webhook had
 * no defence against events describing older state or a different
 * subscription: a delayed `deleted` for a former subscription A downgraded a
 * paying customer on subscription B, a replayed older `updated` regressed the
 * plan, and an `updated` after a `deleted` resurrected a canceled plan. None
 * of it was covered by any test.
 *
 * These cases drive the real exported `POST` handler. The Stripe mock is the
 * source of AUTHORITATIVE state: `subscriptions.retrieve` answers with the
 * subscription as it exists *now*, while the delivered event may carry an
 * older snapshot — exactly the asymmetry that makes stale delivery dangerous.
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
const customersRetrieve = jest.fn(async () => ({ deleted: false, metadata: {} }));
const subscriptionsUpdate = jest.fn(async () => ({}));
const subscriptionsList = jest.fn(async () => ({ data: [] }));
/** Authoritative Stripe state, keyed by subscription id. */
const liveSubscriptions = new Map<string, unknown>();
const subscriptionsRetrieve = jest.fn(async (id: string) => {
  const s = liveSubscriptions.get(id);
  if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
  return s;
});
jest.mock("@/lib/stripe/client", () => ({
  stripe: {
    webhooks: { constructEvent: (...a: unknown[]) => constructEvent(...a) },
    customers: { retrieve: (...a: unknown[]) => customersRetrieve(...(a as [])) },
    subscriptions: {
      update: (...a: unknown[]) => subscriptionsUpdate(...(a as [])),
      retrieve: (...a: unknown[]) => subscriptionsRetrieve(...(a as [string])),
      list: (...a: unknown[]) => subscriptionsList(...(a as [])),
    },
  },
}));

let storedDoc: Record<string, unknown> = {};
const docHandle = {
  get: async () => ({ exists: true, data: () => storedDoc }),
  set: async (d: Record<string, unknown>) => { storedDoc = { ...storedDoc, ...d }; },
  update: async (d: Record<string, unknown>) => { storedDoc = { ...storedDoc, ...d }; },
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => docHandle, where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }) }) },
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
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string; priceId?: string; interval?: "month" | "year" }): Stripe.Subscription {
  return {
    id: args.id,
    customer: "cus_customer",
    status: args.status ?? "active",
    metadata: { firebaseUid: UID, targetPlan: "full" },
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: args.priceId ?? "price_full_y", recurring: { interval: args.interval ?? "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Stripe.Subscription;
}

/** Publish authoritative state for a subscription id. */
const setLive = (s: Stripe.Subscription) => liveSubscriptions.set(s.id, s);

async function deliver(type: string, object: unknown) {
  constructEvent.mockReturnValue({ id: "evt_" + Math.random().toString(36).slice(2), type, data: { object } });
  const req = { text: async () => "{}", headers: { get: (k: string) => (k === "stripe-signature" ? "sig" : null) } } as unknown as NextRequest;
  return (await POST(req)).status;
}

const SUB_A = "sub_A_former";
const SUB_B = "sub_B_current";

beforeEach(() => {
  liveSubscriptions.clear();
  constructEvent.mockReset();
  subscriptionsUpdate.mockClear();
  storedDoc = { email: "c@example.test", stripeCustomerId: "cus_customer", usageMonth: "2026-09", runsThisMonth: 12 };
});

describe("cross-subscription events — a former subscription must never touch the current one", () => {
  beforeEach(() => {
    // The customer is currently on B (Full, annual). A is their old, canceled one.
    storedDoc = { ...storedDoc, stripeSubscriptionId: SUB_B, plan: "full", billingInterval: "year", subscriptionStatus: "active", monthlyLimit: 150, maxModelsPerRun: 5 };
    setLive(sub({ id: SUB_B }));
    setLive(sub({ id: SUB_A, status: "canceled" }));
  });

  it("REGRESSION (the proven downgrade): a delayed deleted for former subscription A leaves current subscription B untouched", async () => {
    const before = { ...storedDoc };
    expect(await deliver("customer.subscription.deleted", sub({ id: SUB_A, status: "canceled" }))).toBe(200);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(SUB_B);
    expect(storedDoc).toEqual(before);
  });

  it("a delayed updated for former subscription A leaves B untouched", async () => {
    const before = { ...storedDoc };
    expect(await deliver("customer.subscription.updated", sub({ id: SUB_A, status: "active", priceId: "price_lite_m", interval: "month" }))).toBe(200);
    expect(storedDoc).toEqual(before);
  });

  it("a delayed invoice.payment_succeeded for former subscription A leaves B untouched", async () => {
    const before = { ...storedDoc };
    expect(await deliver("invoice.payment_succeeded", { id: "in_old", subscription: SUB_A })).toBe(200);
    expect(storedDoc).toEqual(before);
  });

  it("a delayed checkout.session.completed for former subscription A leaves B untouched", async () => {
    const before = { ...storedDoc };
    expect(await deliver("checkout.session.completed", { id: "cs_old", mode: "subscription", subscription: SUB_A, customer: "cus_customer", metadata: { firebaseUid: UID, targetPlan: "full" } })).toBe(200);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(SUB_B);
    expect(storedDoc).toEqual(before);
  });
});

describe("stale state for the CURRENT subscription", () => {
  beforeEach(() => {
    storedDoc = { ...storedDoc, stripeSubscriptionId: SUB_B, plan: "full", billingInterval: "year", subscriptionStatus: "active" };
  });

  it("REGRESSION: a replayed OLDER updated cannot regress plan or cadence — authoritative state wins", async () => {
    setLive(sub({ id: SUB_B, priceId: "price_full_y", interval: "year" }));
    // The event carries the old lite/monthly snapshot; Stripe says Full/annual.
    await deliver("customer.subscription.updated", sub({ id: SUB_B, priceId: "price_lite_m", interval: "month" }));
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.billingInterval).toBe("year");
  });

  it("REGRESSION: an updated arriving AFTER a deletion cannot resurrect a canceled plan", async () => {
    setLive(sub({ id: SUB_B, status: "canceled" }));
    await deliver("customer.subscription.deleted", sub({ id: SUB_B, status: "canceled" }));
    expect(storedDoc.plan).toBe("free");

    // A stale "active" snapshot now arrives for the same subscription.
    await deliver("customer.subscription.updated", sub({ id: SUB_B, status: "active" }));
    expect(storedDoc.plan).toBe("free");
  });

  it("a newer invoice-driven reconcile is not undone by an older updated", async () => {
    setLive(sub({ id: SUB_B, priceId: "price_full_y", interval: "year" }));
    await deliver("invoice.payment_succeeded", { id: "in_new", subscription: SUB_B });
    expect(storedDoc.billingInterval).toBe("year");
    await deliver("customer.subscription.updated", sub({ id: SUB_B, priceId: "price_lite_m", interval: "month" }));
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.billingInterval).toBe("year");
  });
});

describe("legitimate transitions still work", () => {
  it("a first subscription is adopted when the user has none stored", async () => {
    setLive(sub({ id: SUB_B }));
    await deliver("customer.subscription.created", sub({ id: SUB_B }));
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(SUB_B);
  });

  it("REPLACEMENT: a new active subscription B replaces a stored subscription A that is no longer entitlement-bearing", async () => {
    storedDoc = { ...storedDoc, stripeSubscriptionId: SUB_A, plan: "free", subscriptionStatus: "canceled" };
    setLive(sub({ id: SUB_A, status: "canceled" }));
    setLive(sub({ id: SUB_B, status: "active" }));
    await deliver("customer.subscription.created", sub({ id: SUB_B, status: "active" }));
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(SUB_B);
  });

  it("a cancellation of the CURRENT subscription still downgrades", async () => {
    storedDoc = { ...storedDoc, stripeSubscriptionId: SUB_B, plan: "full" };
    setLive(sub({ id: SUB_B, status: "canceled" }));
    await deliver("customer.subscription.deleted", sub({ id: SUB_B, status: "canceled" }));
    expect(storedDoc.plan).toBe("free");
  });

  it("a duplicate deletion of the current subscription converges", async () => {
    storedDoc = { ...storedDoc, stripeSubscriptionId: SUB_B, plan: "full" };
    setLive(sub({ id: SUB_B, status: "canceled" }));
    await deliver("customer.subscription.deleted", sub({ id: SUB_B, status: "canceled" }));
    const afterFirst = { ...storedDoc };
    await deliver("customer.subscription.deleted", sub({ id: SUB_B, status: "canceled" }));
    expect(storedDoc).toEqual(afterFirst);
  });

  it("a deletion for a user with no stored subscription still downgrades (nothing to protect)", async () => {
    storedDoc = { ...storedDoc, plan: "full" };
    setLive(sub({ id: SUB_A, status: "canceled" }));
    await deliver("customer.subscription.deleted", sub({ id: SUB_A, status: "canceled" }));
    expect(storedDoc.plan).toBe("free");
  });
});

describe("stale events and an active admin override", () => {
  beforeEach(() => {
    storedDoc = { ...storedDoc, stripeSubscriptionId: SUB_B, plan: "full", override: { active: true, plan: "5_models", runLimitMonthly: 150 } };
    setLive(sub({ id: SUB_B }));
    setLive(sub({ id: SUB_A, status: "canceled" }));
  });

  it("a stale deletion for a former subscription does not disturb the override or current state", async () => {
    const before = { ...storedDoc };
    await deliver("customer.subscription.deleted", sub({ id: SUB_A, status: "canceled" }));
    expect(storedDoc).toEqual(before);
  });

  it("a stale update for a former subscription does not disturb the override or current state", async () => {
    const before = { ...storedDoc };
    await deliver("customer.subscription.updated", sub({ id: SUB_A, status: "active", priceId: "price_lite_m", interval: "month" }));
    expect(storedDoc).toEqual(before);
  });

  it("cancelling the CURRENT subscription records the downgrade but leaves the override intact", async () => {
    setLive(sub({ id: SUB_B, status: "canceled" }));
    await deliver("customer.subscription.deleted", sub({ id: SUB_B, status: "canceled" }));
    expect(storedDoc.plan).toBe("free");
    expect(storedDoc.override).toEqual({ active: true, plan: "5_models", runLimitMonthly: 150 });
  });
});
