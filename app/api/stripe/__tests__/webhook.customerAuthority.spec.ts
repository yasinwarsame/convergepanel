/**
 * Phase BILLING-WEBHOOK-B1-C3 — authority comes from the customer's
 * authoritative Stripe state, never from which webhook arrived first.
 *
 * The exact-head review of e642ef09 proved the remaining P0 by execution:
 * with the stored subscription dead and TWO entitlement-bearing subscriptions
 * live at Stripe, delivering one event first made the customer lite/monthly
 * and delivering the other first made them full/annual — permanently, because
 * the winner then blocked the loser as "stored subscription still active".
 * Identical Stripe state, opposite billing outcomes, decided by delivery
 * order alone. That is the exact failure class this PR exists to remove.
 *
 * Two further proven defects are covered here:
 *   - a deletion whose only link to the user is event metadata could downgrade
 *     a paying customer AND bind a foreign Stripe customer id to them, when
 *     the local binding was incomplete. A deletion may remove authority; it
 *     may never create identity.
 *   - user-id resolution still coerced dependency errors to null one stage
 *     ahead of the typed contract, so a Stripe outage there returned 200 and
 *     Stripe never retried.
 *
 * There is no documented ConvergePanel rule for choosing between two
 * concurrent entitlement-bearing subscriptions, and the incidental heuristics
 * in the codebase disagree with each other, so multiple candidates are treated
 * as an explicit unsupported state: preserve existing state, change nothing.
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
const subscriptionsUpdate = jest.fn(async () => ({}));
const live = new Map<string, Record<string, unknown>>();
let retrieveFails: string | null = null;
let listFails = false;
let customerRetrieveFails = false;
const subscriptionsRetrieve = jest.fn(async (id: string) => {
  if (retrieveFails === id || retrieveFails === "*") throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  const s = live.get(id);
  if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });
  return s;
});
const subscriptionsList = jest.fn(async (args: { customer?: string }) => {
  if (listFails) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  return { data: [...live.values()].filter((s) => s.customer === args.customer), has_more: false };
});
const customersRetrieve = jest.fn(async () => {
  if (customerRetrieveFails) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  return { deleted: false, metadata: {} };
});
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
let queryEmpty = true;
const docHandle = {
  get: async () => ({ exists: true, data: () => storedDoc }),
  set: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
  update: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: () => docHandle,
      where: () => ({ limit: () => ({ get: async () => ({ empty: queryEmpty, docs: [] }) }) }),
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
import { POST } from "../webhook/route";

const UID = "uid_customer";
const MINE = "cus_mine";
const FOREIGN = "cus_foreign";
const A = "sub_A_dead";
const B = "sub_B_lite_monthly";
const C = "sub_C_full_annual";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string; priceId?: string; interval?: "month" | "year"; customer?: string; uid?: string | null }) {
  const metadata: Record<string, string> = { targetPlan: "full" };
  if (args.uid !== null) metadata.firebaseUid = args.uid ?? UID;
  return {
    id: args.id,
    customer: args.customer ?? MINE,
    status: args.status ?? "active",
    metadata,
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: args.priceId ?? "price_full_y", recurring: { interval: args.interval ?? "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Stripe.Subscription;
}
const setLive = (s: Stripe.Subscription) => live.set(s.id, s as unknown as Record<string, unknown>);
const subB = () => sub({ id: B, priceId: "price_lite_m", interval: "month" });
const subC = () => sub({ id: C, priceId: "price_full_y", interval: "year" });

async function deliver(type: string, object: unknown) {
  constructEvent.mockReturnValue({ id: "evt_" + Math.random().toString(36).slice(2), type, data: { object } });
  const req = { text: async () => "{}", headers: { get: (k: string) => (k === "stripe-signature" ? "sig" : null) } } as unknown as NextRequest;
  return (await POST(req)).status;
}
/** The billing facts a customer's plan is made of. */
const billingOf = (d: Record<string, unknown>) => ({ plan: d.plan, billingInterval: d.billingInterval, subscriptionId: d.stripeSubscriptionId, customerId: d.stripeCustomerId });

function reset() {
  live.clear(); writes.length = 0; constructEvent.mockReset(); subscriptionsUpdate.mockClear(); subscriptionsList.mockClear();
  retrieveFails = null; listFails = false; customerRetrieveFails = false; queryEmpty = true;
}
beforeEach(reset);

describe("P0 — delivery order must not decide which subscription is authoritative", () => {
  /** Stored A is dead; the customer holds BOTH B (lite/monthly) and C (full/annual). */
  function twoLiveCandidates() {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "free", subscriptionStatus: "canceled" };
    setLive(sub({ id: A, status: "canceled" }));
    setLive(subB());
    setLive(subC());
  }

  it("REGRESSION: B-first and C-first converge on the SAME application state", async () => {
    twoLiveCandidates();
    await deliver("customer.subscription.updated", subB());
    await deliver("customer.subscription.updated", subC());
    const bFirst = billingOf(storedDoc);

    reset();
    twoLiveCandidates();
    await deliver("customer.subscription.updated", subC());
    await deliver("customer.subscription.updated", subB());
    const cFirst = billingOf(storedDoc);

    expect(bFirst).toEqual(cFirst);
  });

  it("REGRESSION: a single B event and a single C event converge too", async () => {
    twoLiveCandidates();
    await deliver("customer.subscription.updated", subB());
    const onlyB = billingOf(storedDoc);

    reset();
    twoLiveCandidates();
    await deliver("customer.subscription.updated", subC());
    const onlyC = billingOf(storedDoc);

    expect(onlyB).toEqual(onlyC);
  });

  it("two entitlement-bearing candidates are an unsupported state: nothing is adopted", async () => {
    twoLiveCandidates();
    const before = { ...storedDoc };
    expect(await deliver("customer.subscription.updated", subB())).toBe(200);
    expect(storedDoc).toEqual(before);
    expect(writes).toHaveLength(0);
  });

  it("with NO stored subscription, two candidates are still ambiguous and adopt neither", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, plan: "free" };
    setLive(subB());
    setLive(subC());
    const before = { ...storedDoc };
    expect(await deliver("customer.subscription.updated", subC())).toBe(200);
    expect(storedDoc).toEqual(before);
  });

  it("an invoice event for B while B and C both exist adopts neither", async () => {
    twoLiveCandidates();
    const before = { ...storedDoc };
    expect(await deliver("invoice.payment_succeeded", { id: "in_1", subscription: B })).toBe(200);
    expect(storedDoc).toEqual(before);
  });

  it("a checkout event for C while B and C both exist adopts neither", async () => {
    twoLiveCandidates();
    const before = { ...storedDoc };
    expect(await deliver("checkout.session.completed", { id: "cs_1", mode: "subscription", subscription: C, customer: MINE, metadata: { firebaseUid: UID, targetPlan: "full" } })).toBe(200);
    expect(billingOf(storedDoc)).toEqual(billingOf(before));
  });
});

describe("exactly one entitlement-bearing subscription is adopted deterministically", () => {
  beforeEach(() => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "free", subscriptionStatus: "canceled" };
    setLive(sub({ id: A, status: "canceled" }));
    setLive(subC());
  });

  it("adopts the only live subscription when its own event arrives", async () => {
    expect(await deliver("customer.subscription.updated", subC())).toBe(200);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.billingInterval).toBe("year");
    expect(storedDoc.stripeSubscriptionId).toBe(C);
  });

  it("REGRESSION: an event naming the dead historical A does not restore A", async () => {
    expect(await deliver("customer.subscription.updated", sub({ id: A, status: "canceled" }))).toBe(200);
    expect(storedDoc.stripeSubscriptionId).not.toBe(A);
    expect(storedDoc.plan).not.toBe("full_from_A");
  });
});

describe("P1 — a deletion may remove authority but must never create identity", () => {
  it("REGRESSION: with no stored customer binding, a foreign deletion neither downgrades nor binds", async () => {
    storedDoc = { email: "c@example.test", plan: "full", monthlyLimit: 150, maxModelsPerRun: 5, billingInterval: "year" };
    setLive(sub({ id: A, status: "canceled", customer: FOREIGN }));
    const before = { ...storedDoc };

    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled", customer: FOREIGN }))).toBe(200);

    expect(storedDoc).toEqual(before);
    expect(storedDoc.stripeCustomerId).toBeUndefined();
    expect(storedDoc.plan).toBe("full");
  });

  it("REGRESSION: the replacement search never runs against an unverified customer", async () => {
    storedDoc = { email: "c@example.test", plan: "full" };
    setLive(sub({ id: A, status: "canceled", customer: FOREIGN }));

    await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled", customer: FOREIGN }));

    const listedForeign = subscriptionsList.mock.calls.some((c) => (c[0] as { customer?: string })?.customer === FOREIGN);
    expect(listedForeign).toBe(false);
  });

  it("a deletion for the stored subscription of a bound customer still downgrades", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "full" };
    setLive(sub({ id: A, status: "canceled" }));

    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }))).toBe(200);
    expect(storedDoc.plan).toBe("free");
  });

  it("a deletion never writes a customer id that was not already bound", async () => {
    storedDoc = { email: "c@example.test", stripeSubscriptionId: A, plan: "full" };
    setLive(sub({ id: A, status: "canceled" }));

    await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }));

    for (const w of writes) expect(w.stripeCustomerId).not.toBe(FOREIGN);
  });
});

describe("P1 — dependency failure during user-id resolution must be retryable", () => {
  it("REGRESSION: a Stripe outage while resolving the user returns 5xx, not 200", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, plan: "free" };
    // No uid in metadata, so the handler must consult Stripe for the customer.
    const noUid = sub({ id: C, uid: null });
    setLive(noUid);
    customerRetrieveFails = true;

    const status = await deliver("customer.subscription.updated", noUid);

    expect(status).toBeGreaterThanOrEqual(500);
    expect(writes).toHaveLength(0);
  });
});

describe("definitively-missing subscription reconciles against the customer set", () => {
  it("REGRESSION: A is gone but exactly one live B exists — B becomes authoritative", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "full", billingInterval: "year" };
    setLive(subB()); // only B is live; A is not in the map, so it 404s

    expect(await deliver("customer.subscription.updated", sub({ id: A }))).toBe(200);

    expect(storedDoc.stripeSubscriptionId).toBe(B);
    expect(storedDoc.billingInterval).toBe("month");
  });

  it("A is gone and the customer has nothing entitlement-bearing — state is corrected to free", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "full", billingInterval: "year" };

    expect(await deliver("customer.subscription.updated", sub({ id: A }))).toBe(200);

    expect(storedDoc.plan).toBe("free");
  });

  it("A is gone and the customer-set lookup fails transiently — 5xx, no mutation", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "full" };
    listFails = true;
    const before = { ...storedDoc };

    expect(await deliver("customer.subscription.updated", sub({ id: A }))).toBeGreaterThanOrEqual(500);
    expect(storedDoc).toEqual(before);
  });

  it("A is gone and two candidates exist — ambiguous, nothing changes", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "full", billingInterval: "year" };
    setLive(subB());
    setLive(subC());
    const before = { ...storedDoc };

    expect(await deliver("customer.subscription.updated", sub({ id: A }))).toBe(200);
    expect(storedDoc).toEqual(before);
  });
});

describe("dependency failure during user-id resolution is not papered over by a later lookup", () => {
  it("REGRESSION: a Stripe outage resolving the user fails the delivery even though a Firestore lookup COULD have found them", async () => {
    // Without the typed contract the failure became `firebaseUid = null`, the
    // handler fell through to the next resolution strategy, found the user and
    // answered 200 — masking the outage and persisting a decision made on
    // incomplete information.
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: C, plan: "free" };
    const noUid = sub({ id: C, uid: null });
    setLive(noUid);
    customerRetrieveFails = true;
    queryEmpty = false; // the fallback lookup WOULD succeed

    const status = await deliver("customer.subscription.updated", noUid);

    expect(status).toBeGreaterThanOrEqual(500);
    expect(writes).toHaveLength(0);
  });
});

describe("deletion never adopts a customer id from the event", () => {
  it("REGRESSION: a deletion whose event carries no customer still uses the stored binding, never null", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "full" };
    const noCustomer = { ...(sub({ id: A, status: "canceled" }) as unknown as Record<string, unknown>), customer: null };
    setLive(noCustomer as never);

    expect(await deliver("customer.subscription.deleted", noCustomer)).toBe(200);

    expect(storedDoc.plan).toBe("free");
    expect(storedDoc.stripeCustomerId).toBe(MINE);
    for (const w of writes) expect(w.stripeCustomerId).toBe(MINE);
  });

  it("REGRESSION: the replacement search is scoped to the stored customer, not the event's", async () => {
    storedDoc = { email: "c@example.test", stripeCustomerId: MINE, plan: "full" };
    const mismatched = { ...(sub({ id: A, status: "canceled" }) as unknown as Record<string, unknown>), customer: null };
    setLive(mismatched as never);

    await deliver("customer.subscription.deleted", mismatched);

    for (const call of subscriptionsList.mock.calls) {
      expect((call[0] as { customer?: string })?.customer).toBe(MINE);
    }
  });
});
