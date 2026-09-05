/**
 * Phase BILLING-WEBHOOK-B1-C6 — the deletion identity guard, at the route.
 *
 * The unit spec pins the rule; this pins the WIRING, and does so in the one
 * shape where the customer-set resolver cannot stand in for it. In every
 * previously covered scenario a live replacement subscription existed, so
 * removing the guard changed nothing: the resolver refused the downgrade a
 * stage later for its own reasons. Here the customer holds nothing
 * plan-bearing at all, so the resolver would happily authorise the downgrade
 * — and only the identity guard stops a cancellation of former subscription A
 * from clearing a record that points at subscription B.
 *
 * The guard also returns BEFORE the customer's set is enumerated, which gives
 * it an externally unique signature: with the guard removed, Stripe is
 * consulted; with it in place, Stripe is never asked.
 */

process.env.STRIPE_PRICE_3_MODELS = "price_lite_m";
process.env.STRIPE_3_MODELS_ANNUAL = "price_lite_y";
process.env.STRIPE_PRICE_5_MODELS = "price_full_m";
process.env.STRIPE_5_MODELS_ANNUAL = "price_full_y";

jest.mock("@/lib/env", () => ({
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_3_MODELS: "price_lite_m",
  STRIPE_3_MODELS_ANNUAL: "price_lite_y",
  STRIPE_PRICE_5_MODELS: "price_full_m",
  STRIPE_5_MODELS_ANNUAL: "price_full_y",
}));

const constructEvent = jest.fn();
const live = new Map<string, Record<string, unknown>>();
const subscriptionsUpdate = jest.fn(async () => ({}));
const subscriptionsRetrieve = jest.fn(async (id: string) => {
  const s = live.get(id);
  if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });
  return s;
});
const subscriptionsList = jest.fn(async (args: { customer?: string }) => ({
  data: [...live.values()].filter((s) => s.customer === args.customer),
  has_more: false,
}));
const customersRetrieve = jest.fn(async () => ({ deleted: false, metadata: {} }));
jest.mock("@/lib/stripe/client", () => ({
  stripe: {
    webhooks: { constructEvent: (...a: unknown[]) => constructEvent(...a) },
    customers: { retrieve: (...a: unknown[]) => customersRetrieve(...(a as [])) },
    subscriptions: {
      update: (...a: unknown[]) => subscriptionsUpdate(...(a as [])),
      retrieve: (...a: unknown[]) => subscriptionsRetrieve(...(a as [string])),
      list: (...a: unknown[]) => subscriptionsList(...(a as [{ customer?: string }])),
    },
  },
}));

let storedDoc: Record<string, unknown> = {};
const writes: Record<string, unknown>[] = [];
const docHandle = {
  get: async () => ({ exists: true, data: () => storedDoc }),
  set: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
  update: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: () => docHandle,
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
    }),
  },
  firebaseAdmin: {
    firestore: {
      Timestamp: { now: () => "TS_NOW", fromDate: (d: Date) => `TS_${d.toISOString()}` },
      FieldValue: { delete: () => "DELETE" },
    },
  },
}));
jest.mock("@/lib/posthog-server", () => ({ getPostHogClient: () => ({ capture: jest.fn(), flush: jest.fn(async () => undefined) }) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import type Stripe from "stripe";
import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { POST } from "../webhook/route";

const UID = "uid_customer";
const MINE = "cus_mine";
const A = "sub_A_former";
const B = "sub_B_current";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string; customer?: string }) {
  return {
    id: args.id,
    customer: args.customer ?? MINE,
    status: args.status ?? "active",
    metadata: { firebaseUid: UID, targetPlan: "full" },
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: "price_full_y", recurring: { interval: "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Stripe.Subscription;
}
const setLive = (s: Stripe.Subscription) => live.set(s.id, s as unknown as Record<string, unknown>);

async function deliver(type: string, object: unknown) {
  constructEvent.mockReturnValue({ id: "evt_guard", type, data: { object } });
  const req = { text: async () => "{}", headers: { get: (k: string) => (k === "stripe-signature" ? "sig" : null) } } as unknown as NextRequest;
  return (await POST(req)).status;
}

beforeEach(() => {
  live.clear(); writes.length = 0; constructEvent.mockReset();
  subscriptionsList.mockClear(); subscriptionsUpdate.mockClear();
  (logger.warn as jest.Mock).mockClear();
});

describe("C6 — the deletion identity guard is load-bearing on its own", () => {
  /**
   * The isolating state: the record points at B, the cancellation is for A,
   * and NEITHER is plan-bearing at Stripe. The customer-set resolver would
   * return "no entitlement" and authorise the downgrade. Only the identity
   * guard refuses it.
   */
  function guardIsTheOnlyDefence() {
    storedDoc = {
      email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: B,
      plan: "full", monthlyLimit: 150, maxModelsPerRun: 5, subscriptionStatus: "active", billingInterval: "year",
    };
    setLive(sub({ id: A, status: "canceled" }));
    setLive(sub({ id: B, status: "canceled" }));
  }

  it("REGRESSION: a cancellation of former subscription A must not clear a record pointing at B", async () => {
    guardIsTheOnlyDefence();
    const before = { ...storedDoc };

    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }))).toBe(200);

    expect(writes).toHaveLength(0);
    expect(storedDoc).toEqual(before);
    expect(storedDoc.plan).toBe("full");
  });

  it("REGRESSION: the guard refuses BEFORE the customer's set is enumerated — Stripe is never asked", async () => {
    guardIsTheOnlyDefence();

    await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }));

    expect(subscriptionsList).not.toHaveBeenCalled();
  });

  it("the refusal is observable", async () => {
    guardIsTheOnlyDefence();

    await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }));

    const refusals = (logger.warn as jest.Mock).mock.calls.filter((c) => String(c[0]).includes("not the user's current one"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0][1]).toMatchObject({ subscriptionId: A });
  });

  it("CONTRAST: the same state, but the cancellation names the STORED subscription — the downgrade proceeds", async () => {
    guardIsTheOnlyDefence();

    expect(await deliver("customer.subscription.deleted", sub({ id: B, status: "canceled" }))).toBe(200);

    expect(subscriptionsList).toHaveBeenCalled();
    expect(storedDoc.plan).toBe("free");
  });
});
