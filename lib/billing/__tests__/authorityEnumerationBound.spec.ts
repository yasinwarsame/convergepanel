/**
 * Phase BILLING-WEBHOOK-B1-C8 — "WE STOPPED LOOKING" IS NOT "NONE EXISTS".
 *
 * The final exact-head review of ebbc3c9 found the one correctness defect
 * inside code this PR introduced. `resolveCustomerSubscriptionAuthority`
 * bounds enumeration at a fixed number of pages. When the loop exits by
 * exhausting that counter while Stripe still reports `has_more: true`, the
 * partially inspected set was treated as the complete set — so an empty
 * partial set became `no_entitlement`, and a paying customer whose live
 * subscription sat beyond the bound was downgraded to free with their
 * subscription reference deleted.
 *
 * That is a destructive fail-open, and it directly contradicts the invariant
 * this module exists to enforce and states in its own header: ABSENCE MUST BE
 * PROVEN. A bound is a limit on our willingness to look; it is not evidence
 * about the customer.
 *
 * The correction keeps a finite bound — an unbounded loop against a misbehaving
 * pagination cursor is its own outage — but makes stopping early an EXPLICIT
 * outcome that no caller may read as absence, as uniqueness, or as permission
 * to write.
 */

jest.mock("@/lib/env", () => ({
  STRIPE_PRICE_3_MODELS: "price_lite_m",
  STRIPE_3_MODELS_ANNUAL: "price_lite_y",
  STRIPE_PRICE_5_MODELS: "price_full_m",
  STRIPE_5_MODELS_ANNUAL: "price_full_y",
}));

import { resolveCustomerSubscriptionAuthority } from "../customerSubscriptionAuthority";

const sub = (id: string, status = "active") => ({
  id,
  status,
  items: { data: [{ id: "si_" + id, price: { id: "price_full_y", recurring: { interval: "year", interval_count: 1 } } }] },
});

/**
 * A faithful Stripe pagination mock: honours `limit`, seeks by `starting_after`,
 * and derives `has_more` from what remains.
 */
function stripeOver(all: Array<ReturnType<typeof sub>>) {
  const list = jest.fn(async (args: { starting_after?: string; limit?: number }) => {
    const limit = args.limit ?? 10;
    let start = 0;
    if (args.starting_after) start = all.findIndex((s) => s.id === args.starting_after) + 1;
    const data = all.slice(start, start + limit);
    return { data, has_more: start + limit < all.length };
  });
  return { stripe: { subscriptions: { list } } as never, list };
}

/** 1000 non-candidates fill every page up to the bound; the live one sits beyond it. */
const noiseThenLive = (noise: number) => [
  ...Array.from({ length: noise }, (_, i) => sub(`sub_noise_${i}`, "canceled")),
  sub("sub_live_annual"),
];

describe("C8 P1 — reaching the safety bound is not proof of absence", () => {
  it("REGRESSION: the bound is reached with has_more still true — the result must not be no_entitlement", async () => {
    const { stripe } = stripeOver(noiseThenLive(1000));
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" });
    expect(r.kind).not.toBe("no_entitlement");
  });

  it("REGRESSION: it must not be reported as exactly_one from a partial set either", async () => {
    const all = [
      sub("sub_partial_candidate"),
      ...Array.from({ length: 1200 }, (_, i) => sub(`sub_noise_${i}`, "canceled")),
      sub("sub_live_annual"),
    ];
    const { stripe } = stripeOver(all);
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" });
    expect(r.kind).not.toBe("exactly_one");
    expect(r.kind).not.toBe("no_entitlement");
  });

  it("the outcome is an explicit incomplete-enumeration result", async () => {
    const { stripe } = stripeOver(noiseThenLive(1000));
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("enumeration_incomplete");
  });

  it("the incomplete result carries enough context for an operator to act", async () => {
    const { stripe } = stripeOver(noiseThenLive(1000));
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" });
    if (r.kind !== "enumeration_incomplete") throw new Error("expected enumeration_incomplete");
    expect(r.pagesFetched).toBeGreaterThan(0);
    expect(r.reason).toBe("page_limit_reached");
  });

  it("the bound is finite: the resolver stops rather than paging forever", async () => {
    const { stripe, list } = stripeOver(noiseThenLive(100_000));
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("enumeration_incomplete");
    expect(list.mock.calls.length).toBeLessThanOrEqual(64);
  });
});

describe("C8 P1 — a cursor that does not advance fails closed", () => {
  it("REGRESSION: a pagination cursor stuck on the same id must not loop forever, and must not be absence", async () => {
    // Stripe misbehaving: always the same page, always has_more.
    const list = jest.fn(async () => ({ data: [sub("sub_stuck", "canceled")], has_more: true }));
    const stripe = { subscriptions: { list } } as never;
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("enumeration_incomplete");
    expect(r.kind === "enumeration_incomplete" && r.reason).toBe("cursor_not_advancing");
    expect(list.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("REGRESSION: a page with has_more true but no usable cursor is incomplete, not exhausted", async () => {
    const list = jest.fn(async () => ({ data: [{ status: "canceled", items: { data: [] } }], has_more: true }));
    const stripe = { subscriptions: { list } } as never;
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("enumeration_incomplete");
  });
});

describe("C8 — normal pagination is untouched", () => {
  it("a candidate on a later page is still found, and the set is exhausted", async () => {
    const { stripe } = stripeOver([...Array.from({ length: 150 }, (_, i) => sub(`n${i}`, "canceled")), sub("sub_B")]);
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("exactly_one");
  });

  it("B on an early page and C on a later one is still ambiguity", async () => {
    const { stripe } = stripeOver([sub("sub_B"), ...Array.from({ length: 150 }, (_, i) => sub(`n${i}`, "canceled")), sub("sub_C")]);
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("multiple_entitlements");
  });

  it("zero is still concluded when Stripe genuinely reports the set is exhausted", async () => {
    const { stripe } = stripeOver(Array.from({ length: 250 }, (_, i) => sub(`n${i}`, "canceled")));
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("no_entitlement");
  });

  it("an empty customer is still no_entitlement, not incomplete", async () => {
    const { stripe } = stripeOver([]);
    const r = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" });
    expect(r.kind).toBe("no_entitlement");
  });

  it("a transient failure mid-pagination is still a dependency failure, not absence and not incomplete", async () => {
    let call = 0;
    const list = jest.fn(async () => {
      call += 1;
      if (call === 2) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
      return { data: Array.from({ length: 100 }, (_, i) => sub(`n${i}`, "canceled")), has_more: true };
    });
    const stripe = { subscriptions: { list } } as never;
    await expect(resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: "cus_1" })).rejects.toMatchObject({ dependency: "stripe" });
  });
});
