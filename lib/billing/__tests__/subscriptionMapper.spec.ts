/**
 * Phase BILLING-ANNUAL-MIG-B1 — `mapSubscriptionToPlan()`, the canonical
 * Stripe-subscription → internal-plan resolver.
 *
 * The incident this covers: the defective monthly-cadence "Full Annual"
 * Price was removed from the checkout price map when the env var moved to
 * the corrected yearly Price, leaving one real, paying subscription whose
 * Price resolves to nothing. It must still resolve to Full through its
 * server-written metadata marker — and an unmapped Price WITHOUT that
 * marker must still fail closed.
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

import type Stripe from "stripe";
import { mapSubscriptionToPlan } from "../subscriptionMapper";

/** The retired, defective Price the one legacy subscription still carries. It is deliberately NOT any of the four configured ids above. */
const LEGACY_RETIRED_PRICE = "price_retired_full_annual_bad";

function subscription(args: { status: string; priceId: string; metadata?: Record<string, string> }): Stripe.Subscription {
  return {
    id: "sub_test",
    status: args.status,
    metadata: args.metadata ?? {},
    items: { data: [{ id: "si_test", price: { id: args.priceId, recurring: { interval: "month" } } }] },
  } as unknown as Stripe.Subscription;
}

describe("mapSubscriptionToPlan — current Price mapping", () => {
  it("active on the current Full yearly Price resolves to Full", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "active", priceId: "price_full_y" }));
    expect(m).toMatchObject({ planId: "full", isActive: true, maxModelsPerRun: 5 });
  });

  it("trialing on the current Full yearly Price resolves to Full", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "trialing", priceId: "price_full_y" }));
    expect(m).toMatchObject({ planId: "full", isActive: true, maxModelsPerRun: 5 });
  });

  it("a recognized current Price wins over a contradictory metadata marker", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "active", priceId: "price_lite_m", metadata: { targetPlan: "full" } }));
    expect(m.planId).toBe("lite");
  });
});

describe("mapSubscriptionToPlan — legacy retired Price", () => {
  it("REGRESSION: active on the retired Price with a valid marker still resolves to Full", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "active", priceId: LEGACY_RETIRED_PRICE, metadata: { targetPlan: "full" } }));
    expect(m).toMatchObject({ planId: "full", isActive: true, maxModelsPerRun: 5 });
  });

  it("REGRESSION: trialing on the retired Price with a valid marker still resolves to Full — the state the corrective migration produces", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "trialing", priceId: LEGACY_RETIRED_PRICE, metadata: { targetPlan: "full" } }));
    expect(m).toMatchObject({ planId: "full", isActive: true, maxModelsPerRun: 5 });
  });

  it("resolves a legacy lite marker to Lite", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "active", priceId: LEGACY_RETIRED_PRICE, metadata: { targetPlan: "lite" } }));
    expect(m).toMatchObject({ planId: "lite", isActive: true, maxModelsPerRun: 3 });
  });
});

describe("mapSubscriptionToPlan — fail-closed cases", () => {
  it("an unmapped Price with NO metadata grants nothing", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "active", priceId: "price_unknown_attacker" }));
    expect(m).toMatchObject({ planId: "free", isActive: false });
  });

  it("an unmapped Price with a MALFORMED marker grants nothing", () => {
    for (const targetPlan of ["FULL", " full", "", "full "]) {
      const m = mapSubscriptionToPlan(subscription({ status: "active", priceId: "price_unknown_attacker", metadata: { targetPlan } }));
      expect(m).toMatchObject({ planId: "free", isActive: false });
    }
  });

  it("an unmapped Price with an UNKNOWN marker grants nothing", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "active", priceId: "price_unknown_attacker", metadata: { targetPlan: "enterprise" } }));
    expect(m).toMatchObject({ planId: "free", isActive: false });
  });

  it("canceled does not become paid merely because metadata names a plan", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "canceled", priceId: LEGACY_RETIRED_PRICE, metadata: { targetPlan: "full" } }));
    expect(m).toMatchObject({ planId: "free", isActive: false });
  });

  it("incomplete and unpaid do not become paid merely because metadata names a plan", () => {
    for (const status of ["incomplete", "incomplete_expired", "unpaid", "paused"]) {
      const m = mapSubscriptionToPlan(subscription({ status, priceId: LEGACY_RETIRED_PRICE, metadata: { targetPlan: "full" } }));
      expect(m).toMatchObject({ planId: "free", isActive: false });
    }
  });

  it("past_due keeps its pre-existing plan-bearing behavior (unchanged by this phase)", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "past_due", priceId: "price_full_y" }));
    expect(m).toMatchObject({ planId: "full", isActive: true });
  });
});

/**
 * Phase BILLING-ENTITLEMENT-R3 — the historical shape the R1 audit found in
 * Production: a MONTHLY Price that is not one of the configured Production
 * Price ids (a legacy test product), carried by subscriptions whose only link
 * to an application plan is the server-written `targetPlan` marker. This is
 * backward compatibility for historical subscriptions: the marker must keep
 * resolving the plan, and its absence must keep failing closed.
 */
describe("R3 — historical unmapped MONTHLY Price with the legacy marker", () => {
  /** Deliberately none of the four configured ids above. */
  const HISTORICAL_TEST_PRICE = "price_historical_monthly_test";

  it("REGRESSION: active on the unmapped monthly Price with targetPlan=full resolves to Full, not free", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "active", priceId: HISTORICAL_TEST_PRICE, metadata: { targetPlan: "full" } }));
    expect(m).toEqual({ planId: "full", isActive: true, maxModelsPerRun: 5, monthlyLimit: 150 });
  });

  it("past_due on that shape stays plan-bearing and still resolves to Full through the marker", () => {
    const m = mapSubscriptionToPlan(subscription({ status: "past_due", priceId: HISTORICAL_TEST_PRICE, metadata: { targetPlan: "full" } }));
    expect(m).toMatchObject({ planId: "full", isActive: true, maxModelsPerRun: 5 });
  });

  it("the same unmapped monthly Price without a valid marker grants nothing", () => {
    expect(mapSubscriptionToPlan(subscription({ status: "active", priceId: HISTORICAL_TEST_PRICE }))).toMatchObject({ planId: "free", isActive: false });
    expect(mapSubscriptionToPlan(subscription({ status: "active", priceId: HISTORICAL_TEST_PRICE, metadata: { firebaseUid: "uid_only" } }))).toMatchObject({ planId: "free", isActive: false });
  });
});
