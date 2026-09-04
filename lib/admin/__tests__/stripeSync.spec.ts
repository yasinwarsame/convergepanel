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

function subscription(args: { status: string; priceId: string; metadata?: Record<string, string> }): Stripe.Subscription {
  return {
    id: "sub_test",
    status: args.status,
    metadata: args.metadata ?? {},
    current_period_end: 1_800_000_000,
    items: { data: [{ id: "si_test", price: { id: args.priceId, recurring: { interval: "month" } } }] },
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
