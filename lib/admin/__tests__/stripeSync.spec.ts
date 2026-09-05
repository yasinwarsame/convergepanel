/**
 * Phase BILLING-ANNUAL-MIG-B1 — `syncSubscriptionToFirestore()`.
 *
 * Before this phase the admin sync resolved the plan with `priceIdToPlan()`,
 * which consults only the CURRENT checkout price env vars. Running it
 * against the one legacy subscription — whose Price was retired when the
 * env var moved to the corrected yearly Price — wrote `planFromStripe:
 * null` and `plan: "free"`, downgrading a paying customer while Stripe
 * still reported the subscription active. These tests are that regression.
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

const updateMock = jest.fn(async () => undefined);
const getMock = jest.fn(async () => ({ data: () => userDoc }));
let userDoc: Record<string, unknown> = {};

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => ({ update: (...a: unknown[]) => updateMock(...(a as [])), get: () => getMock() }) }) },
}));
jest.mock("firebase-admin/firestore", () => ({ Timestamp: { now: () => "TS_NOW", fromDate: (d: Date) => `TS_${d.toISOString()}` } }));

import type Stripe from "stripe";
import { syncSubscriptionToFirestore } from "../stripeSync";

const LEGACY_RETIRED_PRICE = "price_retired_full_annual_bad";

const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const SEP_2_2026 = Math.floor(Date.UTC(2026, 8, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function subscription(args: { status: string; priceId: string; metadata?: Record<string, string>; interval?: "month" | "year"; itemPeriod?: boolean }): Stripe.Subscription {
  return {
    id: "sub_test",
    status: args.status,
    metadata: args.metadata ?? {},
    current_period_start: SEP_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{
      id: "si_test",
      quantity: 1,
      price: { id: args.priceId, recurring: { interval: args.interval ?? "month", interval_count: 1 } },
      ...(args.itemPeriod === false ? {} : { current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }),
    }] },
  } as unknown as Stripe.Subscription;
}

const written = () => updateMock.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  updateMock.mockClear();
  getMock.mockClear();
  userDoc = {};
});

describe("syncSubscriptionToFirestore — legacy subscription", () => {
  it("REGRESSION: an active legacy subscription on the retired Price stays Full, never downgraded to free", async () => {
    await syncSubscriptionToFirestore("uid1", subscription({ status: "active", priceId: LEGACY_RETIRED_PRICE, metadata: { targetPlan: "full" } }));
    expect(written()).toMatchObject({ planFromStripe: "5_models", subscriptionStatusFromStripe: "active", plan: "full", monthlyLimit: 150, maxModelsPerRun: 5 });
  });

  it("REGRESSION: a trialing legacy subscription — the corrective migration's own state — stays Full", async () => {
    await syncSubscriptionToFirestore("uid1", subscription({ status: "trialing", priceId: LEGACY_RETIRED_PRICE, metadata: { targetPlan: "full" } }));
    expect(written()).toMatchObject({ planFromStripe: "5_models", subscriptionStatusFromStripe: "trialing", plan: "full", maxModelsPerRun: 5 });
  });

  it("a trialing subscription on the CURRENT yearly Price stays Full", async () => {
    await syncSubscriptionToFirestore("uid1", subscription({ status: "trialing", priceId: "price_full_y" }));
    expect(written()).toMatchObject({ planFromStripe: "5_models", plan: "full", maxModelsPerRun: 5 });
  });
});

describe("syncSubscriptionToFirestore — fail-closed", () => {
  it("an unmapped Price with no trusted marker syncs to free", async () => {
    await syncSubscriptionToFirestore("uid1", subscription({ status: "active", priceId: "price_unknown_attacker" }));
    expect(written()).toMatchObject({ planFromStripe: null, plan: "free" });
  });

  it("an unmapped Price with an unknown marker syncs to free", async () => {
    await syncSubscriptionToFirestore("uid1", subscription({ status: "active", priceId: "price_unknown_attacker", metadata: { targetPlan: "enterprise" } }));
    expect(written()).toMatchObject({ planFromStripe: null, plan: "free" });
  });

  it("a canceled subscription syncs to free even with a valid marker", async () => {
    await syncSubscriptionToFirestore("uid1", subscription({ status: "canceled", priceId: LEGACY_RETIRED_PRICE, metadata: { targetPlan: "full" } }));
    expect(written()).toMatchObject({ planFromStripe: null, subscriptionStatusFromStripe: "canceled", plan: "free" });
  });

  it("an active admin override is never overwritten by the Stripe sync", async () => {
    userDoc = { override: { active: true, plan: "5_models" } };
    await syncSubscriptionToFirestore("uid1", subscription({ status: "active", priceId: LEGACY_RETIRED_PRICE, metadata: { targetPlan: "full" } }));
    const w = written();
    expect(w).toMatchObject({ planFromStripe: "5_models" });
    expect(w).not.toHaveProperty("plan");
    expect(w).not.toHaveProperty("entitlements");
  });
});


describe("syncSubscriptionToFirestore — Phase WEBHOOK-B1 canonical billing state", () => {
  it("REGRESSION: persists billingInterval, which this path previously never wrote", async () => {
    await syncSubscriptionToFirestore("uid1", subscription({ status: "active", priceId: "price_full_y", interval: "year" }));
    expect(written()).toMatchObject({ billingInterval: "year", plan: "full" });
  });

  it("REGRESSION: uses the ITEM-level period, not the stale subscription-level one", async () => {
    await syncSubscriptionToFirestore("uid1", subscription({ status: "active", priceId: "price_full_y", interval: "year" }));
    const w = written();
    expect(w.billingCycleStart).toBe(`TS_${new Date(AUG_2_2026 * 1000).toISOString()}`);
    expect(w.billingCycleStart).not.toBe(`TS_${new Date(SEP_2_2026 * 1000).toISOString()}`);
    expect(w.currentPeriodEnd).toBe(`TS_${new Date(AUG_2_2027 * 1000).toISOString()}`);
  });

  it("never writes usage counters", async () => {
    await syncSubscriptionToFirestore("uid1", subscription({ status: "active", priceId: "price_full_y", interval: "year" }));
    const w = written();
    for (const k of ["runsThisMonth", "usageMonth", "videoRunsThisMonth", "tokensUsedCurrentPeriod", "totalRuns"]) {
      expect(w).not.toHaveProperty(k);
    }
  });

  it("running twice produces an identical write set", async () => {
    await syncSubscriptionToFirestore("uid1", subscription({ status: "active", priceId: "price_full_y", interval: "year" }));
    const first = updateMock.mock.calls[0][0];
    updateMock.mockClear();
    await syncSubscriptionToFirestore("uid1", subscription({ status: "active", priceId: "price_full_y", interval: "year" }));
    const second = updateMock.mock.calls[0][0];
    expect(second).toEqual(first);
  });

  it("an ambiguous multi-item subscription syncs to free rather than guessing a plan", async () => {
    const ambiguous = {
      id: "sub_test", status: "active", metadata: {},
      items: { data: [
        { id: "si_a", quantity: 1, price: { id: "price_lite_m", recurring: { interval: "month", interval_count: 1 } } },
        { id: "si_b", quantity: 1, price: { id: "price_full_y", recurring: { interval: "year", interval_count: 1 } } },
      ] },
    } as unknown as Stripe.Subscription;
    await syncSubscriptionToFirestore("uid1", ambiguous);
    expect(written()).toMatchObject({ planFromStripe: null, plan: "free" });
  });
});
