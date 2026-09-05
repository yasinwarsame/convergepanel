/**
 * Phase BILLING-PR145-C8.1 — THE PURCHASE INVARIANT.
 *
 * The C8 exact-head review blocked PR #145 on this: the checkout route
 * upgraded a subscription in place only when it was `active` AND the target
 * was `full` AND the current price was a LITE price. Everything else opened a
 * new Checkout Session, and nothing anywhere cancels the previous
 * subscription. So Full Monthly -> Full Annual — the cadence change at the
 * centre of this incident — left the customer holding TWO live plan-bearing
 * subscriptions.
 *
 * That mattered because of what the rest of this PR does correctly: all three
 * automatic writers refuse an ambiguous subscription set. Before #145 the
 * newest subscription silently won, so the purchase appeared to work (while
 * double-billing). After #145 it is refused, so the plan the customer just
 * paid for never activates. The regression is real and it lands the moment
 * this deploys, because the billing page runs the self-serve sync
 * automatically on the post-checkout redirect.
 *
 * The invariant: a normal purchase must never create a second plan-bearing
 * subscription when a non-terminal one already exists. Fixed HERE, at the path
 * that creates the ambiguity — never by teaching reconciliation to tolerate it.
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

type Sub = Record<string, unknown> & { id: string; customer: string; status: string };

let live: Sub[] = [];
let listFails = false;
let updateFails = false;
let listPagesUnbounded = false;

const sessionsCreate = jest.fn(async () => ({ id: "cs_new", url: "https://checkout.stripe.test/cs_new" }));
const subscriptionsUpdate = jest.fn(async (id: string, body: Record<string, unknown>) => {
  if (updateFails) throw Object.assign(new Error("card_declined"), { type: "StripeCardError" });
  const s = live.find((x) => x.id === id)!;
  const items = body.items as Array<{ id: string; price: string; quantity?: number }>;
  const existing = (s.items as { data: Array<Record<string, unknown>> }).data[0];
  // Faithful to Stripe: the item keeps its identity, its quantity when the
  // caller did not send one, and it still carries its own period.
  (s.items as { data: Array<Record<string, unknown>> }).data = [
    {
      ...existing,
      id: items[0].id,
      quantity: items[0].quantity ?? existing.quantity,
      price: { id: items[0].price, recurring: { interval: items[0].price.endsWith("_y") ? "year" : "month", interval_count: 1 } },
    },
  ];
  return s;
});
const subscriptionsList = jest.fn(async (args: { customer?: string; starting_after?: string; limit?: number }) => {
  if (listFails) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  if (listPagesUnbounded) return { data: [{ id: `noise_${Math.random()}`, customer: args.customer, status: "canceled", items: { data: [] } }], has_more: true };
  const all = live.filter((s) => s.customer === args.customer);
  const limit = args.limit ?? 10;
  let start = 0;
  if (args.starting_after) start = all.findIndex((s) => s.id === args.starting_after) + 1;
  return { data: all.slice(start, start + limit), has_more: start + limit < all.length };
});
const pricesRetrieve = jest.fn(async (id: string) => ({
  id, active: true, recurring: { interval: id.endsWith("_y") ? "year" : "month", interval_count: 1 },
}));
jest.mock("@/lib/stripe/client", () => ({
  stripe: {
    customers: { retrieve: async () => ({ id: "cus_mine", deleted: false, metadata: { firebaseUid: "uid_customer" }, email: "c@example.test" }), create: jest.fn(), update: jest.fn(async () => ({})) },
    prices: { retrieve: (...a: unknown[]) => pricesRetrieve(...(a as [string])) },
    subscriptions: { list: (...a: unknown[]) => subscriptionsList(...(a as [{ customer?: string }])), update: (...a: unknown[]) => subscriptionsUpdate(...(a as [string, Record<string, unknown>])) },
    checkout: { sessions: { create: (...a: unknown[]) => sessionsCreate(...(a as [])) } },
  },
}));

let storedDoc: Record<string, unknown> = {};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => storedDoc }), update: async () => undefined, set: async () => undefined }) }) },
}));
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: async () => ({ status: "authenticated", uid: "uid_customer", source: "bearer" }),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/posthog-server", () => ({ getPostHogClient: () => ({ capture: jest.fn(), flush: jest.fn(async () => undefined) }) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import type { NextRequest } from "next/server";
import { POST } from "../route";
import { resolveCustomerSubscriptionAuthority } from "@/lib/billing/customerSubscriptionAuthority";
import { resolveSubscriptionBillingState } from "@/lib/billing/subscriptionBillingState";
import { mapSubscriptionToPlan } from "@/lib/billing/subscriptionMapper";

const MINE = "cus_mine";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; priceId: string; status?: string; interval?: "month" | "year"; quantity?: number }): Sub {
  return {
    id: args.id, customer: MINE, status: args.status ?? "active", created: 1,
    metadata: { firebaseUid: "uid_customer" },
    current_period_start: AUG_2_2026, current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: args.quantity ?? 1, price: { id: args.priceId, recurring: { interval: args.interval ?? (args.priceId.endsWith("_y") ? "year" : "month"), interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Sub;
}

async function purchase(planId: string, interval: string) {
  const req = { json: async () => ({ planId, interval }), nextUrl: { origin: "https://app.test" }, headers: { get: () => null } } as unknown as NextRequest;
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}

/** The forbidden outcome, in one place. */
const assertNoSecondSubscription = () => {
  expect(sessionsCreate).not.toHaveBeenCalled();
  expect(live.filter((s) => ["active", "trialing", "past_due"].includes(s.status))).toHaveLength(1);
};

beforeEach(() => {
  live = []; listFails = false; updateFails = false; listPagesUnbounded = false;
  sessionsCreate.mockClear(); subscriptionsUpdate.mockClear(); subscriptionsList.mockClear();
  storedDoc = { email: "c@example.test", stripeCustomerId: MINE, plan: "full", stripeSubscriptionId: "sub_full_monthly" };
});

describe("C8.1 P1 — a purchase must never create a second plan-bearing subscription", () => {
  it("REGRESSION: Full Monthly -> Full Annual changes the existing subscription in place", async () => {
    live = [sub({ id: "sub_full_monthly", priceId: "price_full_m" })];

    const { status, body } = await purchase("full", "year");

    expect(status).toBe(200);
    expect(body.upgraded).toBe(true);
    assertNoSecondSubscription();
    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: the update supplies the existing ITEM ID, so the price is replaced and not added", async () => {
    live = [sub({ id: "sub_full_monthly", priceId: "price_full_m", quantity: 1 })];

    await purchase("full", "year");

    const [subId, payload] = subscriptionsUpdate.mock.calls[0] as unknown as [string, { items: Array<{ id: string; price: string; quantity?: number }> }];
    expect(subId).toBe("sub_full_monthly");
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].id).toBe("si_sub_full_monthly");
    expect(payload.items[0].price).toBe("price_full_y");
    // and the subscription still has exactly ONE item afterwards
    expect((live[0].items as { data: unknown[] }).data).toHaveLength(1);
  });

  it("REGRESSION: an existing quantity is preserved, not silently forced to 1", async () => {
    live = [sub({ id: "sub_seats", priceId: "price_full_m", quantity: 3 })];
    await purchase("full", "year");
    const payload = (subscriptionsUpdate.mock.calls[0] as unknown as [string, { items: Array<{ quantity?: number }> }])[1];
    expect(payload.items[0].quantity).toBeUndefined();
  });

  it("Full Annual -> Full Monthly is also in place", async () => {
    live = [sub({ id: "sub_full_annual", priceId: "price_full_y" })];
    storedDoc = { ...storedDoc, stripeSubscriptionId: "sub_full_annual" };

    await purchase("full", "month");

    assertNoSecondSubscription();
    expect((subscriptionsUpdate.mock.calls[0] as unknown as [string, { items: Array<{ price: string }> }])[1].items[0].price).toBe("price_full_m");
  });

  it("Lite -> Full still works, preserving the previously supported path", async () => {
    live = [sub({ id: "sub_lite", priceId: "price_lite_m" })];

    const { body } = await purchase("full", "month");

    expect(body.upgraded).toBe(true);
    assertNoSecondSubscription();
  });

  it("Lite Monthly -> Lite Annual is in place (the old rule required planId==='full')", async () => {
    live = [sub({ id: "sub_lite", priceId: "price_lite_m" })];

    await purchase("lite", "year");

    assertNoSecondSubscription();
    expect((subscriptionsUpdate.mock.calls[0] as unknown as [string, { items: Array<{ price: string }> }])[1].items[0].price).toBe("price_lite_y");
  });

  it("REGRESSION: a TRIALING subscription is changed in place, not duplicated", async () => {
    live = [sub({ id: "sub_trial", priceId: "price_full_m", status: "trialing" })];

    await purchase("full", "year");

    assertNoSecondSubscription();
    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: a PAST_DUE subscription is changed in place, not duplicated", async () => {
    live = [sub({ id: "sub_pd", priceId: "price_full_m", status: "past_due" })];

    await purchase("full", "year");

    assertNoSecondSubscription();
  });

  it("REGRESSION: Firestore drift cannot cause a duplicate — live Stripe state decides", async () => {
    // Local state says the user is free with no subscription (exactly what the
    // webhook outage has been producing), but Stripe holds a live one.
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, plan: "free" };
    live = [sub({ id: "sub_full_monthly", priceId: "price_full_m" })];

    await purchase("full", "year");

    assertNoSecondSubscription();
  });
});

describe("C8.1 — failure must not fall through into a second subscription", () => {
  it("REGRESSION: an in-place update failure fails the request instead of opening checkout", async () => {
    live = [sub({ id: "sub_full_monthly", priceId: "price_full_m" })];
    updateFails = true;

    const { status, body } = await purchase("full", "year");

    expect(status).toBe(502);
    expect(body.url).toBeUndefined();
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(live).toHaveLength(1);
  });

  it("a transient enumeration failure refuses rather than selling a duplicate", async () => {
    live = [sub({ id: "sub_full_monthly", priceId: "price_full_m" })];
    listFails = true;

    const { status } = await purchase("full", "year");

    expect(status).toBe(503);
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("an incomplete enumeration refuses — not proof the customer has none", async () => {
    listPagesUnbounded = true;

    const { status, body } = await purchase("full", "year");

    expect(status).toBe(409);
    expect(body.code).toBe("authority_enumeration_incomplete");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("REGRESSION: an already-ambiguous customer fails closed — no third subscription, no arbitrary pick", async () => {
    live = [sub({ id: "sub_b", priceId: "price_lite_m" }), sub({ id: "sub_c", priceId: "price_full_y" })];

    const { status, body } = await purchase("full", "month");

    expect(status).toBe(409);
    expect(body.code).toBe("multiple_entitlement_subscriptions");
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("an unidentifiable plan item fails closed rather than guessing", async () => {
    const ambiguous = sub({ id: "sub_multi", priceId: "price_full_m" });
    (ambiguous.items as { data: Array<Record<string, unknown>> }).data.push({
      id: "si_second", quantity: 1, price: { id: "price_lite_m", recurring: { interval: "month", interval_count: 1 } },
    });
    live = [ambiguous];

    const { status } = await purchase("full", "year");

    expect(status).toBe(409);
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });
});

describe("C8.1 — the ordinary paths still work", () => {
  it("a customer with NO plan-bearing subscription still starts checkout normally", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, plan: "free" };
    live = [];

    const { status, body } = await purchase("full", "year");

    expect(status).toBe(200);
    expect(body.url).toContain("checkout.stripe.test");
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("a customer whose only subscription is TERMINAL still starts checkout normally", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, plan: "free" };
    live = [sub({ id: "sub_dead", priceId: "price_full_m", status: "canceled" }), sub({ id: "sub_gone", priceId: "price_lite_m", status: "incomplete_expired" })];

    const { status } = await purchase("full", "year");

    expect(status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: requesting the price the customer already has mutates nothing", async () => {
    live = [sub({ id: "sub_full_annual", priceId: "price_full_y" })];

    const { status, body } = await purchase("full", "year");

    expect(status).toBe(200);
    expect(body.unchanged).toBe(true);
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect((live[0].items as { data: unknown[] }).data).toHaveLength(1);
  });

  it("repeated identical purchase requests stay structurally idempotent", async () => {
    live = [sub({ id: "sub_full_monthly", priceId: "price_full_m" })];

    await purchase("full", "year");
    await purchase("full", "year");
    await purchase("full", "year");

    assertNoSecondSubscription();
    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1); // then the price already matches
    expect((live[0].items as { data: unknown[] }).data).toHaveLength(1);
  });
});

describe("C8.1 PART K — the blocker end to end: purchase then reconcile", () => {
  it("REGRESSION: Full Monthly -> Full Annual leaves a set the hardened resolver accepts", async () => {
    live = [sub({ id: "sub_full_monthly", priceId: "price_full_m" })];

    await purchase("full", "year");

    // Forbidden topology: two plan-bearing subscriptions on one customer.
    expect(live).toHaveLength(1);
    expect(sessionsCreate).not.toHaveBeenCalled();

    // Now feed the resulting Stripe state through the #145 authority resolver.
    const authority = await resolveCustomerSubscriptionAuthority({
      stripe: { subscriptions: { list: subscriptionsList } } as never,
      verifiedCustomerId: MINE,
    });
    expect(authority.kind).toBe("exactly_one");
    if (authority.kind !== "exactly_one") return;

    expect(mapSubscriptionToPlan(authority.subscription).planId).toBe("full");
    const billing = resolveSubscriptionBillingState(authority.subscription as never);
    expect(billing.ok).toBe(true);
    if (!billing.ok) return;
    expect(billing.state.billingInterval).toBe("year");
    expect(billing.state.periodSource).toBe("item");
    expect(billing.state.periodStart?.toISOString()).toBe(new Date(AUG_2_2026 * 1000).toISOString());
  });

  it("CONTRAST: the pre-fix topology would have been refused as ambiguous", async () => {
    // Exactly what the old fall-through produced.
    live = [sub({ id: "sub_full_monthly", priceId: "price_full_m" }), sub({ id: "sub_full_annual", priceId: "price_full_y" })];

    const authority = await resolveCustomerSubscriptionAuthority({
      stripe: { subscriptions: { list: subscriptionsList } } as never,
      verifiedCustomerId: MINE,
    });

    expect(authority.kind).toBe("multiple_entitlements");
  });
});
