/**
 * Phase BILLING-WEBHOOK-B1-C4 — the customer-set resolver.
 *
 * The multiple-entitlement outcome is TERMINAL: the route acknowledges it and
 * changes nothing, so the log it emits is the only signal an operator ever
 * gets. That makes the candidate ids part of the contract, not a convenience,
 * and they are asserted here rather than only through the route.
 */

jest.mock("@/lib/env", () => ({
  STRIPE_PRICE_3_MODELS: "price_lite_m",
  STRIPE_3_MODELS_ANNUAL: "price_lite_y",
  STRIPE_PRICE_5_MODELS: "price_full_m",
  STRIPE_5_MODELS_ANNUAL: "price_full_y",
}));

import { resolveCustomerSubscriptionAuthority, verifyCustomerIdentity } from "../customerSubscriptionAuthority";

const sub = (id: string, status = "active") => ({ id, status, items: { data: [{ id: "si_" + id, price: { id: "price_full_y", recurring: { interval: "year", interval_count: 1 } } }] } });
const stripeWith = (pages: Array<{ data: unknown[]; has_more: boolean }>) => {
  let i = 0;
  return { subscriptions: { list: jest.fn(async () => pages[i++] ?? { data: [], has_more: false }) } } as never;
};

describe("resolveCustomerSubscriptionAuthority", () => {
  it("no entitlement-bearing subscription", async () => {
    const r = await resolveCustomerSubscriptionAuthority({ stripe: stripeWith([{ data: [sub("s1", "canceled")], has_more: false }]), verifiedCustomerId: "cus_1" });
    expect(r).toEqual({ kind: "no_entitlement" });
  });

  it("exactly one", async () => {
    const r = await resolveCustomerSubscriptionAuthority({ stripe: stripeWith([{ data: [sub("s1"), sub("s2", "canceled")], has_more: false }]), verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("exactly_one");
  });

  it("REGRESSION: two candidates are ambiguous AND report both ids for the operator", async () => {
    const r = await resolveCustomerSubscriptionAuthority({ stripe: stripeWith([{ data: [sub("s1"), sub("s2")], has_more: false }]), verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("multiple_entitlements");
    if (r.kind !== "multiple_entitlements") return;
    expect(r.count).toBe(2);
    expect(r.subscriptionIds).toEqual(["s1", "s2"]);
  });

  it("REGRESSION: a candidate on a LATER page is still found", async () => {
    const r = await resolveCustomerSubscriptionAuthority({
      stripe: stripeWith([{ data: [sub("s1")], has_more: true }, { data: [sub("s2")], has_more: false }]),
      verifiedCustomerId: "cus_1",
    });
    expect(r.kind).toBe("multiple_entitlements");
  });

  it("an unverified customer is never enumerated", async () => {
    const stripe = stripeWith([{ data: [sub("s1")], has_more: false }]);
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: null });
    expect(r).toEqual({ kind: "unverified_customer" });
    expect((stripe as unknown as { subscriptions: { list: jest.Mock } }).subscriptions.list).not.toHaveBeenCalled();
  });
});

describe("verifyCustomerIdentity", () => {
  it("a stored binding wins and a mismatch is refused", () => {
    expect(verifyCustomerIdentity({ storedCustomerId: "c1", eventCustomerId: "c1", destructive: false })).toEqual({ ok: true, verifiedCustomerId: "c1" });
    expect(verifyCustomerIdentity({ storedCustomerId: "c1", eventCustomerId: "c2", destructive: false })).toEqual({ ok: false, reason: "association_conflict" });
  });

  it("REGRESSION: a deletion may never bootstrap a binding, but a non-destructive event may", () => {
    expect(verifyCustomerIdentity({ storedCustomerId: null, eventCustomerId: "c2", destructive: true })).toEqual({ ok: false, reason: "no_verified_customer" });
    expect(verifyCustomerIdentity({ storedCustomerId: null, eventCustomerId: "c2", destructive: false })).toEqual({ ok: true, verifiedCustomerId: "c2" });
  });
});
