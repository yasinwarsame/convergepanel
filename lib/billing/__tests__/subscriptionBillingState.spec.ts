/**
 * Phase BILLING-WEBHOOK-B1 — the canonical billing-state resolver.
 *
 * The period-precedence cases encode the exact live shape observed during the
 * September 2026 Full Annual incident: after the corrective Price change the
 * subscription simultaneously reported a correct ITEM period starting
 * 2026-08-02 and a stale SUBSCRIPTION-level start of 2026-09-02.
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

import { resolveSubscriptionBillingState, selectPlanBearingItem } from "../subscriptionBillingState";

const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const SEP_2_2026 = Math.floor(Date.UTC(2026, 8, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);
const RETIRED_PRICE = "price_retired_full_annual_bad";

function item(args: { id?: string; priceId: string; interval?: "month" | "year"; quantity?: number; start?: number | null; end?: number | null }) {
  return {
    id: args.id ?? "si_1",
    quantity: args.quantity ?? 1,
    price: { id: args.priceId, recurring: { interval: args.interval ?? "year", interval_count: 1 } },
    current_period_start: args.start ?? null,
    current_period_end: args.end ?? null,
  };
}
const sub = (items: unknown[], subStart?: number | null, subEnd?: number | null) =>
  ({ items: { data: items }, current_period_start: subStart ?? null, current_period_end: subEnd ?? null }) as never;

describe("resolveSubscriptionBillingState — period precedence (incident fixture)", () => {
  it("REGRESSION: item-level period wins over a stale subscription-level start", () => {
    const r = resolveSubscriptionBillingState(
      sub([item({ priceId: "price_full_y", start: AUG_2_2026, end: AUG_2_2027 })], SEP_2_2026, AUG_2_2027)
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.periodSource).toBe("item");
    expect(r.state.periodStart?.toISOString()).toBe(new Date(AUG_2_2026 * 1000).toISOString());
    expect(r.state.periodEnd?.toISOString()).toBe(new Date(AUG_2_2027 * 1000).toISOString());
    expect(r.state.billingInterval).toBe("year");
    expect(r.state.quantity).toBe(1);
  });

  it("falls back to the subscription-level period only when the item exposes none", () => {
    const r = resolveSubscriptionBillingState(sub([item({ priceId: "price_full_y", start: null, end: null })], SEP_2_2026, AUG_2_2027));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.periodSource).toBe("subscription");
    expect(r.state.periodStart?.toISOString()).toBe(new Date(SEP_2_2026 * 1000).toISOString());
  });

  it("reports no period rather than inventing one", () => {
    const r = resolveSubscriptionBillingState(sub([item({ priceId: "price_full_m", interval: "month" })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.periodSource).toBe("none");
    expect(r.state.periodStart).toBeNull();
    expect(r.state.periodEnd).toBeNull();
  });

  it("derives the cadence from the selected Price, monthly and yearly alike", () => {
    const y = resolveSubscriptionBillingState(sub([item({ priceId: "price_full_y", interval: "year" })]));
    const m = resolveSubscriptionBillingState(sub([item({ priceId: "price_full_m", interval: "month" })]));
    expect(y.ok && y.state.billingInterval).toBe("year");
    expect(m.ok && m.state.billingInterval).toBe("month");
  });

  it("resolves a RETIRED, unmapped Price when it is the only item", () => {
    const r = resolveSubscriptionBillingState(sub([item({ priceId: RETIRED_PRICE, interval: "month", start: AUG_2_2026, end: SEP_2_2026 })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.priceId).toBe(RETIRED_PRICE);
    expect(r.state.periodSource).toBe("item");
  });
});

describe("resolveSubscriptionBillingState — fail closed", () => {
  it("no items", () => {
    expect(resolveSubscriptionBillingState(sub([]))).toEqual({ ok: false, reason: "no_items" });
  });

  it("REGRESSION: two mapped items for DIFFERENT plans are ambiguous — never resolves to the higher plan", () => {
    const r = resolveSubscriptionBillingState(sub([item({ id: "si_a", priceId: "price_lite_m", interval: "month" }), item({ id: "si_b", priceId: "price_full_y" })]));
    expect(r).toEqual({ ok: false, reason: "ambiguous_plan_items" });
  });

  it("two unmapped items cannot be attributed", () => {
    const r = resolveSubscriptionBillingState(sub([item({ id: "si_a", priceId: "price_unknown_1" }), item({ id: "si_b", priceId: "price_unknown_2" })]));
    expect(r).toEqual({ ok: false, reason: "ambiguous_plan_items" });
  });

  it("REGRESSION: same-plan items that DISAGREE on cadence are ambiguous — array order must not decide the interval", () => {
    const a = item({ id: "si_a", priceId: "price_full_y", interval: "year" });
    const b = item({ id: "si_b", priceId: "price_full_m", interval: "month" });
    expect(resolveSubscriptionBillingState(sub([a, b]))).toEqual({ ok: false, reason: "ambiguous_plan_items" });
    expect(resolveSubscriptionBillingState(sub([b, a]))).toEqual({ ok: false, reason: "ambiguous_plan_items" });
  });

  it("REGRESSION: same-plan, same-price items that disagree on PERIOD are ambiguous", () => {
    const a = item({ id: "si_a", priceId: "price_full_y", start: AUG_2_2026, end: AUG_2_2027 });
    const b = item({ id: "si_b", priceId: "price_full_y", start: SEP_2_2026, end: AUG_2_2027 });
    expect(resolveSubscriptionBillingState(sub([a, b]))).toEqual({ ok: false, reason: "ambiguous_plan_items" });
    expect(resolveSubscriptionBillingState(sub([b, a]))).toEqual({ ok: false, reason: "ambiguous_plan_items" });
  });

  it("truly equivalent duplicate items resolve deterministically regardless of order", () => {
    const a = item({ id: "si_a", priceId: "price_full_y", start: AUG_2_2026, end: AUG_2_2027 });
    const b = item({ id: "si_b", priceId: "price_full_y", start: AUG_2_2026, end: AUG_2_2027 });
    const fwd = resolveSubscriptionBillingState(sub([a, b]));
    const rev = resolveSubscriptionBillingState(sub([b, a]));
    expect(fwd.ok).toBe(true);
    expect(rev.ok).toBe(true);
    if (!fwd.ok || !rev.ok) return;
    const billing = (x: typeof fwd.state) => ({ price: x.priceId, interval: x.billingInterval, start: x.periodStart?.toISOString(), end: x.periodEnd?.toISOString(), qty: x.quantity });
    expect(billing(fwd.state)).toEqual(billing(rev.state));
  });

  it("a mapped item wins over an unrelated unmapped add-on item", () => {
    const r = resolveSubscriptionBillingState(sub([item({ id: "si_addon", priceId: "price_some_addon" }), item({ id: "si_plan", priceId: "price_full_y", start: AUG_2_2026 })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.itemId).toBe("si_plan");
  });

  it("a non-recurring or unsupported interval fails closed", () => {
    const weekly = { id: "si_1", quantity: 1, price: { id: "price_x", recurring: { interval: "week", interval_count: 1 } } };
    const oneOff = { id: "si_1", quantity: 1, price: { id: "price_x" } };
    expect(resolveSubscriptionBillingState(sub([weekly]))).toEqual({ ok: false, reason: "unsupported_interval" });
    expect(resolveSubscriptionBillingState(sub([oneOff]))).toEqual({ ok: false, reason: "unsupported_interval" });
  });

  it("an item with no Price fails closed", () => {
    expect(selectPlanBearingItem({ items: { data: [{ id: "si_1" }] } } as never)).toEqual({ ok: false, reason: "malformed_item" });
  });
});
