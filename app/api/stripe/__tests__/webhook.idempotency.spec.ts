/**
 * Phase BILLING-WEBHOOK-B1 — duplicate-delivery safety for the PRODUCTION
 * Stripe webhook route.
 *
 * Stripe retries deliveries and can re-send events; a webhook handler that is
 * not safe under duplicates is not production-safe. Before this phase every
 * subscription-change delivery called `resetUsageForNewPlan()`, so an
 * ordinary retry handed the customer a fresh month of run quota, and the
 * persisted billing period came from the subscription-level field, which in
 * flexible billing mode can lag an interval change.
 *
 * These tests drive the real exported `POST` handler — no re-implementation of
 * the route's sequence — with only external boundaries mocked, and assert on
 * the accumulated document the route actually hands Firestore.
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
const subscriptionsRetrieve = jest.fn();
/** Phase C4: authority comes from the customer's set, so the list echoes whatever subscription the test delivered. */
let listSubscriptions: unknown[] = [];
const subscriptionsList = jest.fn(async () => ({ data: listSubscriptions, has_more: false }));
jest.mock("@/lib/stripe/client", () => ({
  stripe: {
    webhooks: { constructEvent: (...a: unknown[]) => constructEvent(...a) },
    customers: { retrieve: (...a: unknown[]) => customersRetrieve(...(a as [])) },
    subscriptions: {
      update: (...a: unknown[]) => subscriptionsUpdate(...(a as [])),
      retrieve: (...a: unknown[]) => subscriptionsRetrieve(...(a as [])),
      list: (...a: unknown[]) => subscriptionsList(...(a as [])),
    },
  },
}));

/** The user document, mutated exactly as the route's writes would mutate it. */
let storedDoc: Record<string, unknown> = {};
const writes: Record<string, unknown>[] = [];
const docHandle = {
  get: async () => ({ exists: true, data: () => storedDoc }),
  set: async (data: Record<string, unknown>) => { writes.push(data); storedDoc = { ...storedDoc, ...data }; },
  update: async (data: Record<string, unknown>) => { writes.push(data); storedDoc = { ...storedDoc, ...data }; },
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({ doc: () => docHandle, where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }) }),
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
import { calculateEffectiveEntitlement } from "@/lib/admin/entitlements";
import { POST } from "../webhook/route";

const UID = "uid_incident_customer";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const SEP_2_2026 = Math.floor(Date.UTC(2026, 8, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

/** The exact live shape after the corrective migration: correct item period, stale subscription-level start. */
function incidentSubscription(overrides: Partial<{ status: string; priceId: string; interval: "month" | "year" }> = {}) {
  return {
    id: "sub_incident",
    customer: "cus_incident",
    status: overrides.status ?? "active",
    metadata: { firebaseUid: UID, targetPlan: "full" },
    current_period_start: SEP_2_2026,
    current_period_end: AUG_2_2027,
    items: {
      data: [{
        id: "si_incident",
        quantity: 1,
        price: { id: overrides.priceId ?? "price_full_y", recurring: { interval: overrides.interval ?? "year", interval_count: 1 } },
        current_period_start: AUG_2_2026,
        current_period_end: AUG_2_2027,
      }],
    },
  } as unknown as Stripe.Subscription;
}

async function deliver(type: string, object: unknown) {
  // Phase WEBHOOK-B1-C1: the route re-reads authoritative state; unless a test
  // overrides it, that read returns the same object the event carried.
  if ((object as { id?: string })?.id && (object as { items?: unknown })?.items) {
    subscriptionsRetrieve.mockResolvedValue(object);
    listSubscriptions = [object];
  }
  constructEvent.mockReturnValue({ id: "evt_" + Math.random().toString(36).slice(2), type, data: { object } });
  const req = { text: async () => "{}", headers: { get: (k: string) => (k === "stripe-signature" ? "sig" : null) } } as unknown as NextRequest;
  const res = await POST(req);
  return res.status;
}

/** The usage state a real customer would already have accumulated this month. */
const USAGE = { usageMonth: "2026-09", runsThisMonth: 37, videoRunsThisMonth: 4, tokensUsedCurrentPeriod: 120_000, totalRuns: 210 };
const usageOf = (d: Record<string, unknown>) => ({
  usageMonth: d.usageMonth, runsThisMonth: d.runsThisMonth, videoRunsThisMonth: d.videoRunsThisMonth,
  tokensUsedCurrentPeriod: d.tokensUsedCurrentPeriod, totalRuns: d.totalRuns,
});

beforeEach(() => {
  writes.length = 0;
  storedDoc = { email: "customer@example.test", stripeCustomerId: "cus_incident", stripeSubscriptionId: "sub_incident", override: { active: true, plan: "5_models", runLimitMonthly: 150 }, ...USAGE };
  constructEvent.mockReset();
  subscriptionsRetrieve.mockReset();
  subscriptionsRetrieve.mockResolvedValue(incidentSubscription());
  listSubscriptions = [incidentSubscription()];
  subscriptionsUpdate.mockClear();
});

describe("webhook duplicate delivery — usage must never reset", () => {
  it("REGRESSION: customer.subscription.updated does not touch usage counters", async () => {
    expect(await deliver("customer.subscription.updated", incidentSubscription())).toBe(200);
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("REGRESSION: the SAME subscription.updated delivered twice leaves usage and billing state identical", async () => {
    await deliver("customer.subscription.updated", incidentSubscription());
    const afterFirst = { ...storedDoc };
    await deliver("customer.subscription.updated", incidentSubscription());
    expect(usageOf(storedDoc)).toEqual(USAGE);
    for (const k of ["plan", "billingInterval", "subscriptionStatus", "monthlyLimit", "maxModelsPerRun", "billingCycleStart", "currentPeriodEnd"]) {
      expect(storedDoc[k]).toEqual(afterFirst[k]);
    }
  });

  it("REGRESSION: invoice.payment_succeeded delivered twice does not reset usage", async () => {
    // Phase C8.1: the shape Stripe actually sends on the pinned API version.
    const invoice = { id: "in_1", parent: { type: "subscription_details", subscription_details: { subscription: "sub_incident" } } };
    expect(await deliver("invoice.payment_succeeded", invoice)).toBe(200);
    await deliver("invoice.payment_succeeded", invoice);
    expect(usageOf(storedDoc)).toEqual(USAGE);
    expect(storedDoc.plan).toBe("full");
  });

  it("REGRESSION: checkout.session.completed delivered twice is idempotent and does not reset usage", async () => {
    const session = { id: "cs_1", mode: "subscription", subscription: "sub_incident", customer: "cus_incident", metadata: { firebaseUid: UID, targetPlan: "full" } };
    expect(await deliver("checkout.session.completed", session)).toBe(200);
    const afterFirst = { ...storedDoc };
    await deliver("checkout.session.completed", session);
    expect(usageOf(storedDoc)).toEqual(USAGE);
    expect(storedDoc.plan).toEqual(afterFirst.plan);
    expect(storedDoc.billingInterval).toEqual(afterFirst.billingInterval);
  });
});

describe("webhook canonical billing period", () => {
  it("REGRESSION: persists the ITEM-level annual start, never the stale subscription-level one", async () => {
    await deliver("customer.subscription.updated", incidentSubscription());
    expect(storedDoc.billingCycleStart).toBe(`TS_${new Date(AUG_2_2026 * 1000).toISOString()}`);
    expect(storedDoc.billingCycleStart).not.toBe(`TS_${new Date(SEP_2_2026 * 1000).toISOString()}`);
    expect(storedDoc.currentPeriodEnd).toBe(`TS_${new Date(AUG_2_2027 * 1000).toISOString()}`);
  });

  it("persists billingInterval year for the corrected annual Price", async () => {
    await deliver("customer.subscription.updated", incidentSubscription());
    expect(storedDoc.billingInterval).toBe("year");
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.subscriptionStatus).toBe("active");
  });

  it("persists billingInterval month for a monthly Price", async () => {
    await deliver("customer.subscription.updated", incidentSubscription({ priceId: "price_full_m", interval: "month" }));
    expect(storedDoc.billingInterval).toBe("month");
  });
});

describe("webhook and the active admin override", () => {
  it("REGRESSION: an active admin override survives a subscription update untouched", async () => {
    await deliver("customer.subscription.updated", incidentSubscription());
    expect(storedDoc.override).toEqual({ active: true, plan: "5_models", runLimitMonthly: 150 });
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "5_models", source: "override" });
  });

  it("the override still wins after the base Stripe state is refreshed", async () => {
    await deliver("customer.subscription.updated", incidentSubscription({ status: "canceled" }));
    expect(storedDoc.override).toMatchObject({ active: true });
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ source: "override" });
  });
});

describe("webhook fail-closed paths", () => {
  it("an ambiguous multi-item subscription writes nothing", async () => {
    const ambiguous = {
      ...(incidentSubscription() as unknown as Record<string, unknown>),
      items: { data: [
        { id: "si_a", quantity: 1, price: { id: "price_lite_m", recurring: { interval: "month", interval_count: 1 } } },
        { id: "si_b", quantity: 1, price: { id: "price_full_y", recurring: { interval: "year", interval_count: 1 } } },
      ] },
    };
    expect(await deliver("customer.subscription.updated", ambiguous)).toBe(200);
    expect(writes).toHaveLength(0);
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("customer.subscription.deleted still downgrades to free", async () => {
    expect(await deliver("customer.subscription.deleted", incidentSubscription({ status: "canceled" }))).toBe(200);
    expect(storedDoc.plan).toBe("free");
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("an unsigned delivery is rejected with no persistence", async () => {
    const req = { text: async () => "{}", headers: { get: () => null } } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});

describe("no fabricated billing dates", () => {
  it("REGRESSION: when Stripe reports NO period, billingCycleStart is left untouched — never set to now", async () => {
    const noPeriod = {
      id: "sub_incident", customer: "cus_incident", status: "active",
      metadata: { firebaseUid: UID, targetPlan: "full" },
      items: { data: [{ id: "si_incident", quantity: 1, price: { id: "price_full_y", recurring: { interval: "year", interval_count: 1 } } }] },
    } as unknown as Stripe.Subscription;
    storedDoc = { ...storedDoc, billingCycleStart: "PRESERVED_CANONICAL_VALUE" };

    expect(await deliver("customer.subscription.updated", noPeriod)).toBe(200);

    expect(storedDoc.billingCycleStart).toBe("PRESERVED_CANONICAL_VALUE");
    for (const w of writes) expect(w).not.toHaveProperty("billingCycleStart");
    expect(storedDoc.plan).toBe("full");
  });
});
