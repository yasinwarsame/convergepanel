/**
 * Phase BILLING-ANNUAL-MIG-B1 — `calculateEffectiveEntitlement()`, the
 * resolver the run-quota gate consults.
 *
 * Two defects are covered here:
 *   1. it required `status === "active"` exactly, so the corrective
 *      migration's compensating trial would have dropped a paying customer
 *      to free limits;
 *   2. it resolved the plan only from `planFromStripe`, a field the
 *      canonical webhook sync path never writes.
 */

jest.mock("@/lib/env", () => ({
  STRIPE_PRICE_3_MODELS: "price_lite_m",
  STRIPE_3_MODELS_ANNUAL: "price_lite_y",
  STRIPE_PRICE_5_MODELS: "price_full_m",
  STRIPE_5_MODELS_ANNUAL: "price_full_y",
}));
jest.mock("@/lib/firebase/admin", () => ({ adminDb: null }));

import { calculateEffectiveEntitlement } from "../entitlements";

const FULL = { runLimitMonthly: 150, maxModelsPerRun: 5 };
const FREE = { runLimitMonthly: 8, maxModelsPerRun: 2 };

describe("calculateEffectiveEntitlement — status contract", () => {
  it("active + admin-synced Full grants Full", () => {
    const e = calculateEffectiveEntitlement({ planFromStripe: "5_models", subscriptionStatusFromStripe: "active" });
    expect(e).toMatchObject({ plan: "5_models", source: "stripe", ...FULL });
  });

  it("REGRESSION: trialing + admin-synced Full still grants Full", () => {
    const e = calculateEffectiveEntitlement({ planFromStripe: "5_models", subscriptionStatusFromStripe: "trialing" });
    expect(e).toMatchObject({ plan: "5_models", source: "stripe", ...FULL });
  });

  it("REGRESSION: trialing + webhook-written plan grants Full — the exact state the corrective migration produces", () => {
    const e = calculateEffectiveEntitlement({ plan: "full", subscriptionStatus: "trialing" });
    expect(e).toMatchObject({ plan: "5_models", source: "stripe", ...FULL });
  });

  it("active + webhook-written plan grants Full without any admin sync ever having run", () => {
    const e = calculateEffectiveEntitlement({ plan: "full", subscriptionStatus: "active" });
    expect(e).toMatchObject({ plan: "5_models", source: "stripe", ...FULL });
  });

  it("webhook-written lite grants Lite", () => {
    const e = calculateEffectiveEntitlement({ plan: "lite", subscriptionStatus: "trialing" });
    expect(e).toMatchObject({ plan: "3_models", source: "stripe", runLimitMonthly: 80, maxModelsPerRun: 3 });
  });

  it("non-paying statuses never grant a paid plan", () => {
    for (const subscriptionStatus of ["canceled", "incomplete", "incomplete_expired", "unpaid", "paused"]) {
      const e = calculateEffectiveEntitlement({ plan: "full", subscriptionStatus });
      expect(e).toMatchObject({ plan: "free", source: "free", ...FREE });
    }
  });

  it("past_due keeps its pre-existing non-entitling behavior in this resolver", () => {
    const e = calculateEffectiveEntitlement({ plan: "full", subscriptionStatus: "past_due" });
    expect(e).toMatchObject({ plan: "free", source: "free" });
  });

  it("a free plan with an active status is still free", () => {
    expect(calculateEffectiveEntitlement({ plan: "free", subscriptionStatus: "active" })).toMatchObject({ plan: "free", source: "free" });
    expect(calculateEffectiveEntitlement({ planFromStripe: "free", subscriptionStatus: "active" })).toMatchObject({ plan: "free", source: "free" });
  });

  it("no document and no status fail closed", () => {
    expect(calculateEffectiveEntitlement(null)).toMatchObject({ plan: "free", source: "free" });
    expect(calculateEffectiveEntitlement({ plan: "full" })).toMatchObject({ plan: "free", source: "free" });
  });

  it("the admin-synced status field still takes precedence over the webhook one", () => {
    const e = calculateEffectiveEntitlement({ plan: "full", subscriptionStatusFromStripe: "canceled", subscriptionStatus: "active" });
    expect(e).toMatchObject({ plan: "free", source: "free" });
  });

  it("an active admin override still outranks Stripe", () => {
    const e = calculateEffectiveEntitlement({ override: { plan: "5_models", runLimitMonthly: 999, active: true }, plan: "free", subscriptionStatus: "canceled" });
    expect(e).toMatchObject({ plan: "5_models", source: "override", runLimitMonthly: 999 });
  });
});
