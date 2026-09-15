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

/**
 * Phase BILLING-ENTITLEMENT-R3 — the exact Production topology found by the
 * R1 audit and repaired in R2: one customer, six subscriptions from a single
 * repeated-Checkout episode — two canceled the same morning, three later
 * `past_due` after failed renewals, one `active` (the one Firestore stores).
 *
 * The resolver's refusal to pick among the four plan-bearing candidates is
 * what kept that anomaly out of Firestore for nine months. These tests pin
 * that refusal to the real shape, and pin the recovery: once the duplicates
 * are canceled, the lone active subscription is authority with no ceremony.
 */
describe("R3 — three past_due duplicates beside one active (the repaired Production topology)", () => {
  const ACTIVE = "sub_6_active_stored";
  const DUPLICATES = ["sub_3_past_due", "sub_4_past_due", "sub_5_past_due"];
  const EARLY_CANCELED = ["sub_1_canceled", "sub_2_canceled"];
  const beforeRepair = () => [...EARLY_CANCELED.map((id) => sub(id, "canceled")), ...DUPLICATES.map((id) => sub(id, "past_due")), sub(ACTIVE, "active")];
  const afterRepair = () => [...EARLY_CANCELED.map((id) => sub(id, "canceled")), ...DUPLICATES.map((id) => sub(id, "canceled")), sub(ACTIVE, "active")];

  it("REGRESSION: three past_due plus one active is ambiguity with all FOUR ids — active does not silently win", async () => {
    const r = await resolveCustomerSubscriptionAuthority({ stripe: stripeWith([{ data: beforeRepair(), has_more: false }]), verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("multiple_entitlements");
    if (r.kind !== "multiple_entitlements") return;
    expect(r.count).toBe(4);
    expect([...r.subscriptionIds].sort()).toEqual([ACTIVE, ...DUPLICATES].sort());
  });

  it("order invariance: the reversed listing yields the same classification and the same candidate set", async () => {
    const forward = await resolveCustomerSubscriptionAuthority({ stripe: stripeWith([{ data: beforeRepair(), has_more: false }]), verifiedCustomerId: "cus_1" });
    const reversed = await resolveCustomerSubscriptionAuthority({ stripe: stripeWith([{ data: beforeRepair().reverse(), has_more: false }]), verifiedCustomerId: "cus_1" });
    expect(forward.kind).toBe("multiple_entitlements");
    expect(reversed.kind).toBe("multiple_entitlements");
    if (forward.kind !== "multiple_entitlements" || reversed.kind !== "multiple_entitlements") return;
    expect(reversed.count).toBe(forward.count);
    expect([...reversed.subscriptionIds].sort()).toEqual([...forward.subscriptionIds].sort());
  });

  it("the duplicates spread across two Stripe pages are still all counted", async () => {
    const all = beforeRepair();
    const r = await resolveCustomerSubscriptionAuthority({
      stripe: stripeWith([{ data: all.slice(0, 3), has_more: true }, { data: all.slice(3), has_more: false }]),
      verifiedCustomerId: "cus_1",
    });
    expect(r.kind).toBe("multiple_entitlements");
    if (r.kind !== "multiple_entitlements") return;
    expect(r.count).toBe(4);
  });

  it("REGRESSION: once dunning (or the R2 repair) has canceled the three duplicates, the lone active subscription is the sole authority", async () => {
    const r = await resolveCustomerSubscriptionAuthority({ stripe: stripeWith([{ data: afterRepair(), has_more: false }]), verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("exactly_one");
    if (r.kind !== "exactly_one") return;
    expect(r.subscription.id).toBe(ACTIVE);
  });

  it("canceled subscriptions are never candidates, whatever their position in the listing", async () => {
    const r = await resolveCustomerSubscriptionAuthority({ stripe: stripeWith([{ data: afterRepair().reverse(), has_more: false }]), verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("exactly_one");
    if (r.kind !== "exactly_one") return;
    expect(r.subscription.id).toBe(ACTIVE);
  });
});
