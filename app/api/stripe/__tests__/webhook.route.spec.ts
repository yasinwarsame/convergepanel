/**
 * Phase BILLING-ANNUAL-MIG-B1-T1 — regression coverage for the PRODUCTION
 * Stripe webhook route's own wiring.
 *
 * Why this file exists: the independent exact-head review of PR #143 found
 * that breaking canonical plan resolution INSIDE
 * `app/api/stripe/webhook/route.ts` left the entire suite green. The
 * existing integration spec (`lib/stripe/__tests__/webhookHelpers.legacy.spec.ts`)
 * re-implements the route's sequence — map, derive interval, persist — in
 * its own helper, so it proves the helpers behave but never that the route
 * actually calls them. For a billing-incident fix whose corrective Stripe
 * migration will itself emit `customer.subscription.updated`, that wiring is
 * exactly the path that must not silently regress.
 *
 * This spec therefore invokes the real exported `POST` handler and lets the
 * route's own control flow run: signature branch, event switch,
 * `handleSubscriptionChange`, uid resolution, `mapSubscriptionToPlan`,
 * `updateUserPlanInFirestore`. ONLY external boundaries are mocked — Stripe
 * event construction and API reads, Firestore, PostHog, logger. Every
 * billing module under test is the real one, and the document the route
 * hands to Firestore is fed back through the real entitlement resolver, so
 * a break anywhere along that chain fails here.
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
jest.mock("@/lib/stripe/client", () => ({
  stripe: {
    webhooks: { constructEvent: (...a: unknown[]) => constructEvent(...a) },
    customers: { retrieve: (...a: unknown[]) => customersRetrieve(...(a as [])) },
    subscriptions: { update: (...a: unknown[]) => subscriptionsUpdate(...(a as [])) },
  },
}));

/** Every `set({...}, {merge:true})` the route performs, in order. */
const setCalls: Record<string, unknown>[] = [];
const updateCalls: Record<string, unknown>[] = [];
let storedDoc: Record<string, unknown> = {};

const docHandle = {
  get: async () => ({ exists: true, data: () => storedDoc }),
  set: async (data: Record<string, unknown>) => {
    setCalls.push(data);
    storedDoc = { ...storedDoc, ...data };
  },
  update: async (data: Record<string, unknown>) => {
    updateCalls.push(data);
    storedDoc = { ...storedDoc, ...data };
  },
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
import { calculateEffectiveEntitlement } from "@/lib/admin/entitlements";
import { POST } from "../webhook/route";

/** The retired, defective "Full Annual" Price the one legacy subscription still carries. Deliberately not any configured id. */
const LEGACY_RETIRED_PRICE = "price_retired_full_annual_bad";
const UID = "uid_legacy_customer";

function subscription(args: { status: string; priceId: string; interval: "month" | "year"; metadata?: Record<string, string> }) {
  return {
    id: "sub_test",
    customer: "cus_test",
    status: args.status,
    metadata: { firebaseUid: UID, ...(args.metadata ?? {}) },
    current_period_start: 1_780_000_000,
    items: { data: [{ id: "si_test", price: { id: args.priceId, recurring: { interval: args.interval } } }] },
  } as unknown as Stripe.Subscription;
}

/** Drives the REAL route: a signed `customer.subscription.updated` delivery. */
async function deliverSubscriptionUpdated(sub: Stripe.Subscription) {
  constructEvent.mockReturnValue({ id: "evt_test", type: "customer.subscription.updated", data: { object: sub } });
  const req = {
    text: async () => "{}",
    headers: { get: (k: string) => (k === "stripe-signature" ? "sig_test" : null) },
  } as unknown as NextRequest;
  const res = await POST(req);
  return { status: res.status, persisted: setCalls[0] };
}

beforeEach(() => {
  setCalls.length = 0;
  updateCalls.length = 0;
  storedDoc = { email: "legacy@example.test", stripeCustomerId: "cus_test" };
  constructEvent.mockReset();
  customersRetrieve.mockClear();
  subscriptionsUpdate.mockClear();
});

describe("POST /api/stripe/webhook — production wiring for the legacy annual subscription", () => {
  it("REGRESSION: legacy retired Price + server-written targetPlan + active — the route itself resolves Full and persists it", async () => {
    const { status, persisted } = await deliverSubscriptionUpdated(
      subscription({ status: "active", priceId: LEGACY_RETIRED_PRICE, interval: "month", metadata: { targetPlan: "full" } })
    );

    expect(status).toBe(200);
    expect(persisted).toMatchObject({
      plan: "full",
      subscriptionStatus: "active",
      monthlyLimit: 150,
      maxModelsPerRun: 5,
      stripeSubscriptionId: "sub_test",
    });
    // The persisted document must still read as Full through the real resolver.
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "5_models", source: "stripe", maxModelsPerRun: 5, runLimitMonthly: 150 });
  });

  it("REGRESSION: corrected yearly Price + trialing — the state the Stripe migration produces — persists Full/year/trialing with Full entitlement", async () => {
    const { status, persisted } = await deliverSubscriptionUpdated(
      subscription({ status: "trialing", priceId: "price_full_y", interval: "year", metadata: { targetPlan: "full" } })
    );

    expect(status).toBe(200);
    expect(persisted).toMatchObject({
      plan: "full",
      subscriptionStatus: "trialing",
      billingInterval: "year",
      monthlyLimit: 150,
      maxModelsPerRun: 5,
    });
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "5_models", source: "stripe", maxModelsPerRun: 5, runLimitMonthly: 150 });
  });

  it("an unmapped Price with no trusted marker fails closed through the route", async () => {
    const { status, persisted } = await deliverSubscriptionUpdated(
      subscription({ status: "active", priceId: "price_unknown_attacker", interval: "month" })
    );

    expect(status).toBe(200);
    expect(persisted).toMatchObject({ plan: "free" });
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "free", source: "free" });
  });

  it("a malformed legacy marker on an unmapped Price fails closed through the route", async () => {
    const { persisted } = await deliverSubscriptionUpdated(
      subscription({ status: "active", priceId: "price_unknown_attacker", interval: "month", metadata: { targetPlan: "FULL" } })
    );

    expect(persisted).toMatchObject({ plan: "free" });
  });

  it("a canceled legacy subscription is not rescued by its metadata marker", async () => {
    const { persisted } = await deliverSubscriptionUpdated(
      subscription({ status: "canceled", priceId: LEGACY_RETIRED_PRICE, interval: "month", metadata: { targetPlan: "full" } })
    );

    expect(persisted).toMatchObject({ plan: "free" });
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "free", source: "free" });
  });

  it("rejects a delivery with no Stripe signature, before any persistence", async () => {
    const req = { text: async () => "{}", headers: { get: () => null } } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(setCalls).toHaveLength(0);
  });
});
