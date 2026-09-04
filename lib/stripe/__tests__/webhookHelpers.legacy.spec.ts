/**
 * Phase BILLING-ANNUAL-MIG-B1 — the canonical webhook synchronization path,
 * `mapSubscriptionToPlan()` → `updateUserPlanInFirestore()`.
 *
 * Proves the two subscription shapes that matter for the pending corrective
 * migration write correct local state: the legacy subscription as it exists
 * today (retired Price, active), and the state the migration produces
 * (corrected yearly Price, trialing) — and that the resulting document is
 * one the entitlement resolver still reads as Full.
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

const setMock = jest.fn(async () => undefined);
const updateMock = jest.fn(async () => undefined);
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => ({ set: (...a: unknown[]) => setMock(...(a as [])), update: (...a: unknown[]) => updateMock(...(a as [])) }) }) },
  firebaseAdmin: { firestore: { Timestamp: { now: () => "TS_NOW", fromDate: (d: Date) => `TS_${d.toISOString()}` }, FieldValue: { delete: () => "DELETE" } } },
}));

import type Stripe from "stripe";
import { mapSubscriptionToPlan } from "@/lib/billing/subscriptionMapper";
import { calculateEffectiveEntitlement } from "@/lib/admin/entitlements";
import { updateUserPlanInFirestore } from "../webhookHelpers";

const LEGACY_RETIRED_PRICE = "price_retired_full_annual_bad";

function subscription(args: { status: string; priceId: string; interval: "month" | "year"; metadata?: Record<string, string> }): Stripe.Subscription {
  return {
    id: "sub_test",
    customer: "cus_test",
    status: args.status,
    metadata: args.metadata ?? {},
    current_period_start: 1_780_000_000,
    items: { data: [{ id: "si_test", price: { id: args.priceId, recurring: { interval: args.interval } } }] },
  } as unknown as Stripe.Subscription;
}

/** Mirrors the webhook's own sequence: map, derive interval, persist. */
async function runWebhookSync(sub: Stripe.Subscription) {
  const planMapping = mapSubscriptionToPlan(sub);
  const billingInterval = sub.items.data[0]?.price.recurring?.interval === "year" ? "year" : "month";
  await updateUserPlanInFirestore({
    uid: "uid1",
    customerId: sub.customer as string,
    subscriptionId: sub.id,
    planMapping,
    status: sub.status,
    billingInterval,
    currentPeriodStart: (sub as unknown as { current_period_start: number }).current_period_start,
  });
  return setMock.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  setMock.mockClear();
  updateMock.mockClear();
});

describe("webhook synchronization — legacy annual subscription", () => {
  it("REGRESSION: the legacy subscription as it exists today (retired Price, active) writes canonical Full state", async () => {
    const written = await runWebhookSync(subscription({ status: "active", priceId: LEGACY_RETIRED_PRICE, interval: "month", metadata: { targetPlan: "full" } }));
    expect(written).toMatchObject({ plan: "full", subscriptionStatus: "active", monthlyLimit: 150, maxModelsPerRun: 5 });
    expect(calculateEffectiveEntitlement(written as never)).toMatchObject({ plan: "5_models", maxModelsPerRun: 5 });
  });

  it("REGRESSION: the post-migration state (corrected yearly Price, trialing) writes Full + year and keeps entitlement", async () => {
    const written = await runWebhookSync(subscription({ status: "trialing", priceId: "price_full_y", interval: "year", metadata: { targetPlan: "full" } }));
    expect(written).toMatchObject({ plan: "full", subscriptionStatus: "trialing", billingInterval: "year", monthlyLimit: 150, maxModelsPerRun: 5 });
    expect(calculateEffectiveEntitlement(written as never)).toMatchObject({ plan: "5_models", source: "stripe", maxModelsPerRun: 5, runLimitMonthly: 150 });
  });

  it("an unmapped Price with no trusted marker writes free state and grants no entitlement", async () => {
    const written = await runWebhookSync(subscription({ status: "active", priceId: "price_unknown_attacker", interval: "month" }));
    expect(written).toMatchObject({ plan: "free" });
    expect(calculateEffectiveEntitlement(written as never)).toMatchObject({ plan: "free", source: "free" });
  });
});
