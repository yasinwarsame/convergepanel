/**
 * Phase BILLING-ANNUAL-MIG-B1 — the canonical Stripe status contract.
 * The deliberate asymmetry between the two sets ("past_due" is plan-bearing
 * but NOT entitlement-bearing) is asserted here so a future "harmonization"
 * has to change a test that states the reason.
 */

import { isEntitlementBearingSubscriptionStatus, isPlanBearingSubscriptionStatus } from "../subscriptionStatus";

describe("subscription status contract", () => {
  it("treats active and trialing as entitlement-bearing", () => {
    expect(isEntitlementBearingSubscriptionStatus("active")).toBe(true);
    expect(isEntitlementBearingSubscriptionStatus("trialing")).toBe(true);
  });

  it("REGRESSION: trialing is entitlement-bearing — the corrective annual migration parks the paid customer in a compensating trial", () => {
    expect(isEntitlementBearingSubscriptionStatus("trialing")).toBe(true);
  });

  it("never grants entitlement for non-paying statuses", () => {
    for (const status of ["canceled", "incomplete", "incomplete_expired", "unpaid", "paused"]) {
      expect(isEntitlementBearingSubscriptionStatus(status)).toBe(false);
    }
  });

  it("keeps past_due plan-bearing but NOT entitlement-bearing (unchanged policy)", () => {
    expect(isPlanBearingSubscriptionStatus("past_due")).toBe(true);
    expect(isEntitlementBearingSubscriptionStatus("past_due")).toBe(false);
  });

  it("fails closed on absent or non-string statuses", () => {
    for (const status of [null, undefined, "", "ACTIVE", "Active"]) {
      expect(isEntitlementBearingSubscriptionStatus(status as never)).toBe(false);
      expect(isPlanBearingSubscriptionStatus(status as never)).toBe(false);
    }
  });
});
