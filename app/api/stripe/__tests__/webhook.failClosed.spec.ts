/**
 * Phase BILLING-WEBHOOK-B1-C2 — "absence must be proven; failure must
 * propagate."
 *
 * The exact-head review of 7f1ee13 proved that the identity guard added in C1
 * is defeated by a single transient dependency failure, because every lookup
 * caught its error and coerced it to `null` — making "Firestore could not be
 * read" indistinguishable from "this user has no stored subscription". It
 * also proved that handlers swallow reconciliation failures and let the route
 * answer 200, so Stripe never retries and the reconciliation is lost forever.
 *
 * Three states must stay distinct:
 *   ABSENT              — proven: the value really is not there.
 *   NOT AUTHORITATIVE   — proven: the value exists but this event is stale.
 *   DEPENDENCY FAILED   — unknown: we could not determine either of the above.
 *
 * Only the first two may authorise a write or a safe 2xx no-op. The third must
 * propagate as a retryable 5xx and must never mutate billing state.
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
const customersRetrieve = jest.fn(async () => ({ deleted: false, metadata: {} }));
const subscriptionsUpdate = jest.fn(async () => ({}));
const liveSubscriptions = new Map<string, unknown>();
/** Overridable per test so a specific retrieve can be made to fail. */
let retrieveImpl: (id: string) => Promise<unknown> = async (id) => {
  const s = liveSubscriptions.get(id);
  if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
  return s;
};
const subscriptionsRetrieve = jest.fn((id: string) => retrieveImpl(id));
/** Phase C3: authority comes from the customer's set, so the default list mirrors live Stripe state. */
let listImpl: (args?: { customer?: string }) => Promise<{ data: unknown[]; has_more?: boolean }> = async (args) => ({
  data: [...liveSubscriptions.values()].filter((s) => (s as { customer?: string }).customer === args?.customer),
  has_more: false,
});
const subscriptionsList = jest.fn((args: { customer?: string }) => listImpl(args));
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
/** When set, the user-document read throws — a transient Firestore failure. */
let docReadFails = false;
/** When set, the user-document write throws. */
let docWriteFails = false;
const docHandle = {
  get: async () => {
    if (docReadFails) throw Object.assign(new Error("DEADLINE_EXCEEDED"), { code: 4 });
    return { exists: true, data: () => storedDoc };
  },
  set: async (d: Record<string, unknown>) => {
    if (docWriteFails) throw Object.assign(new Error("UNAVAILABLE"), { code: 14 });
    writes.push(d);
    storedDoc = { ...storedDoc, ...d };
  },
  update: async (d: Record<string, unknown>) => {
    if (docWriteFails) throw Object.assign(new Error("UNAVAILABLE"), { code: 14 });
    writes.push(d);
    storedDoc = { ...storedDoc, ...d };
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => docHandle, where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }) }) },
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
const SUB_A = "sub_A_former";
const SUB_B = "sub_B_current";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string; priceId?: string; interval?: "month" | "year"; customer?: string }): Stripe.Subscription {
  return {
    id: args.id,
    customer: args.customer ?? "cus_mine",
    status: args.status ?? "active",
    metadata: { firebaseUid: UID, targetPlan: "full" },
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: args.priceId ?? "price_full_y", recurring: { interval: args.interval ?? "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Stripe.Subscription;
}
const setLive = (s: Stripe.Subscription) => liveSubscriptions.set(s.id, s);

async function deliver(type: string, object: unknown) {
  constructEvent.mockReturnValue({ id: "evt_" + Math.random().toString(36).slice(2), type, data: { object } });
  const req = { text: async () => "{}", headers: { get: (k: string) => (k === "stripe-signature" ? "sig" : null) } } as unknown as NextRequest;
  return (await POST(req)).status;
}

/** A paying customer, currently on subscription B. */
const PAID_ON_B = {
  email: "c@example.test", stripeCustomerId: "cus_mine", stripeSubscriptionId: SUB_B,
  plan: "full", billingInterval: "year", subscriptionStatus: "active", monthlyLimit: 150, maxModelsPerRun: 5,
};

beforeEach(() => {
  liveSubscriptions.clear();
  writes.length = 0;
  constructEvent.mockReset();
  subscriptionsUpdate.mockClear();
  subscriptionsList.mockClear();
  docReadFails = false;
  docWriteFails = false;
  retrieveImpl = async (id) => {
    const s = liveSubscriptions.get(id);
    if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
    return s;
  };
  listImpl = async (args) => ({
    data: [...liveSubscriptions.values()].filter((s) => (s as { customer?: string }).customer === args?.customer),
    has_more: false,
  });
  storedDoc = { ...PAID_ON_B };
});

describe("P0 — a transient dependency failure must never look like absent state", () => {
  it("CASE 1: Firestore read failure during a historical deletion must not downgrade, and must return a retryable 5xx", async () => {
    setLive(sub({ id: SUB_A, status: "canceled" }));
    const before = { ...storedDoc };
    docReadFails = true;

    const status = await deliver("customer.subscription.deleted", sub({ id: SUB_A, status: "canceled" }));

    expect(status).toBeGreaterThanOrEqual(500);
    expect(storedDoc).toEqual(before);
    expect(writes).toHaveLength(0);
  });

  it("CASE 2: Firestore read failure during an update must not write and must return a retryable 5xx", async () => {
    setLive(sub({ id: SUB_A, status: "active", priceId: "price_lite_m", interval: "month" }));
    const before = { ...storedDoc };
    docReadFails = true;

    const status = await deliver("customer.subscription.updated", sub({ id: SUB_A, status: "active", priceId: "price_lite_m", interval: "month" }));

    expect(status).toBeGreaterThanOrEqual(500);
    expect(storedDoc).toEqual(before);
    expect(writes).toHaveLength(0);
  });

  it("CASE 3: failing to establish the customer's subscription set must not hand authority to the incoming one", async () => {
    // Phase C3: authority now comes from the customer's set rather than a
    // pairwise stored-vs-incoming comparison, so the dependency that must not
    // fail open is the set lookup itself.
    setLive(sub({ id: SUB_A, status: "active", priceId: "price_lite_m", interval: "month" }));
    listImpl = async () => { throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" }); };
    const before = { ...storedDoc };

    const status = await deliver("customer.subscription.updated", sub({ id: SUB_A, status: "active", priceId: "price_lite_m", interval: "month" }));

    expect(status).toBeGreaterThanOrEqual(500);
    expect(storedDoc).toEqual(before);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(SUB_B);
  });

  it("CASE 4: an ordinary current-subscription event with a failing Firestore read does not mutate and can be retried", async () => {
    setLive(sub({ id: SUB_B }));
    docReadFails = true;
    expect(await deliver("customer.subscription.updated", sub({ id: SUB_B }))).toBeGreaterThanOrEqual(500);
    expect(writes).toHaveLength(0);

    // Dependency recovers; the retry succeeds.
    docReadFails = false;
    expect(await deliver("customer.subscription.updated", sub({ id: SUB_B }))).toBe(200);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.billingInterval).toBe("year");
  });
});

describe("P1 — transient failures must be retryable, not acknowledged", () => {
  it("a transient Stripe failure while establishing the customer's set on subscription.updated returns 5xx", async () => {
    // Phase C4: the change path no longer re-reads the event's own
    // subscription — authority comes from the customer's set — so the Stripe
    // dependency that must stay retryable is that enumeration.
    listImpl = async () => { throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" }); };
    expect(await deliver("customer.subscription.updated", sub({ id: SUB_B }))).toBeGreaterThanOrEqual(500);
    expect(writes).toHaveLength(0);
  });

  it("a Firestore WRITE failure on subscription.updated returns 5xx", async () => {
    setLive(sub({ id: SUB_B }));
    docWriteFails = true;
    expect(await deliver("customer.subscription.updated", sub({ id: SUB_B }))).toBeGreaterThanOrEqual(500);
  });

  it("a Firestore WRITE failure on subscription.deleted returns 5xx", async () => {
    setLive(sub({ id: SUB_B, status: "canceled" }));
    docWriteFails = true;
    expect(await deliver("customer.subscription.deleted", sub({ id: SUB_B, status: "canceled" }))).toBeGreaterThanOrEqual(500);
  });

  it("a Stripe retrieve failure on checkout.session.completed returns 5xx", async () => {
    retrieveImpl = async () => { throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" }); };
    const status = await deliver("checkout.session.completed", { id: "cs_1", mode: "subscription", subscription: SUB_B, customer: "cus_mine", metadata: { firebaseUid: UID, targetPlan: "full" } });
    expect(status).toBeGreaterThanOrEqual(500);
  });

  it("a conclusively stale event is still a safe 200 no-op, not a 5xx", async () => {
    setLive(sub({ id: SUB_B }));
    setLive(sub({ id: SUB_A, status: "canceled" }));
    const before = { ...storedDoc };
    expect(await deliver("customer.subscription.deleted", sub({ id: SUB_A, status: "canceled" }))).toBe(200);
    expect(storedDoc).toEqual(before);
  });
});

describe("P1 — deletion with no stored subscription id must prove no replacement exists", () => {
  beforeEach(() => {
    storedDoc = { email: "c@example.test", stripeCustomerId: "cus_mine", plan: "full", monthlyLimit: 150, maxModelsPerRun: 5, billingInterval: "year" };
  });

  it("must NOT downgrade when the Stripe customer still has an entitlement-bearing subscription", async () => {
    setLive(sub({ id: SUB_A, status: "canceled" }));
    setLive(sub({ id: SUB_B, status: "active" }));
    listImpl = async () => ({ data: [sub({ id: SUB_B, status: "active" })] });

    expect(await deliver("customer.subscription.deleted", sub({ id: SUB_A, status: "canceled" }))).toBe(200);

    expect(storedDoc.plan).toBe("full");
  });

  it("may downgrade once Stripe confirms no entitlement-bearing replacement exists", async () => {
    setLive(sub({ id: SUB_A, status: "canceled" }));
    listImpl = async () => ({ data: [sub({ id: SUB_A, status: "canceled" })] });

    expect(await deliver("customer.subscription.deleted", sub({ id: SUB_A, status: "canceled" }))).toBe(200);

    expect(storedDoc.plan).toBe("free");
  });

  it("must NOT downgrade when the replacement search fails transiently — it returns 5xx instead", async () => {
    setLive(sub({ id: SUB_A, status: "canceled" }));
    listImpl = async () => { throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" }); };

    expect(await deliver("customer.subscription.deleted", sub({ id: SUB_A, status: "canceled" }))).toBeGreaterThanOrEqual(500);
    expect(storedDoc.plan).toBe("full");
  });

  it("must NOT downgrade when several entitlement-bearing candidates exist — no arbitrary choice", async () => {
    setLive(sub({ id: SUB_A, status: "canceled" }));
    listImpl = async () => ({ data: [sub({ id: "sub_X", status: "active" }), sub({ id: "sub_Y", status: "active" })] });

    expect(await deliver("customer.subscription.deleted", sub({ id: SUB_A, status: "canceled" }))).toBe(200);
    expect(storedDoc.plan).toBe("full");
  });
});

describe("P1 — customer/user association is a security boundary", () => {
  it("an event from a FOREIGN Stripe customer must not mutate the user or rewrite the stored customer id", async () => {
    const foreign = sub({ id: SUB_B, customer: "cus_someone_else" });
    setLive(foreign);
    const before = { ...storedDoc };

    expect(await deliver("customer.subscription.updated", foreign)).toBe(200);

    expect(storedDoc.stripeCustomerId).toBe("cus_mine");
    expect(storedDoc).toEqual(before);
  });

  it("a foreign customer carrying a copied uid in metadata must not bind or mutate that user", async () => {
    const foreign = sub({ id: "sub_foreign", customer: "cus_attacker" });
    setLive(foreign);
    listImpl = async () => ({ data: [] });
    const before = { ...storedDoc };

    expect(await deliver("customer.subscription.updated", foreign)).toBe(200);

    expect(storedDoc).toEqual(before);
  });

  it("a genuinely new customer with no stored binding is still bound normally", async () => {
    storedDoc = { email: "new@example.test", plan: "free" };
    setLive(sub({ id: SUB_B, customer: "cus_new" }));

    expect(await deliver("customer.subscription.updated", sub({ id: SUB_B, customer: "cus_new" }))).toBe(200);

    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeCustomerId).toBe("cus_new");
  });
});
