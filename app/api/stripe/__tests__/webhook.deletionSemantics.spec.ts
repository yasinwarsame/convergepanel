/**
 * Phase BILLING-WEBHOOK-B1-C5 — deletion semantics and ambiguity observability.
 *
 * The exact-head review of 5f89d6d2 confirmed the customer-set authority work
 * but found five things this spec pins:
 *
 *  1. The MULTIPLE_ENTITLEMENTS response is a terminal 200 with no mutation, so
 *     Stripe never retries and the structured log is the ONLY durable signal
 *     that a customer needs manual reconciliation. Both ambiguity records could
 *     be deleted with the entire suite still green. Observability is therefore
 *     part of the safety contract, and it is asserted here at the real call
 *     sites.
 *  2. The deletion path's user-id resolution still swallowed dependency errors,
 *     so a transient outage returned 200 and the cancellation was lost.
 *  3. A definitively missing Stripe customer was allowed to authorise a
 *     destructive downgrade. An absent remote lookup is not positive authority.
 *  4. The subscription being deleted was not excluded from its own replacement
 *     set, so a list still reporting it could suppress the downgrade forever.
 *  5. `past_due` accidentally cleared the subscription reference and wrote the
 *     free plan. The pre-existing contract (subscriptionValidation.ts:82,221,
 *     sync-plan/route.ts:140, subscriptionStatus.ts PLAN_BEARING) treats
 *     past_due as still the customer's subscription; entitlement is withheld
 *     separately by the effective-entitlement resolver.
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
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const constructEvent = jest.fn();
const subscriptionsUpdate = jest.fn(async () => ({}));
const live = new Map<string, Record<string, unknown>>();
let customerRetrieveFails = false;
let listFails = false;
let listPages: Array<{ data: unknown[]; has_more: boolean }> | null = null;
const subscriptionsRetrieve = jest.fn(async (id: string) => {
  const s = live.get(id);
  if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });
  return s;
});
let customerMissing = false;
const subscriptionsList = jest.fn(async (args: { customer?: string; starting_after?: string }) => {
  if (listFails) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  if (customerMissing) throw Object.assign(new Error("No such customer"), { code: "resource_missing", statusCode: 404 });
  if (listPages) return listPages[args.starting_after ? 1 : 0] ?? { data: [], has_more: false };
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
      list: (...a: unknown[]) => subscriptionsList(...(a as [{ customer?: string; starting_after?: string }])),
    },
  },
}));

let storedDoc: Record<string, unknown> = {};
const writes: Record<string, unknown>[] = [];
let docReadFails = false;
const docHandle = {
  get: async () => {
    if (docReadFails) throw Object.assign(new Error("DEADLINE_EXCEEDED"), { code: 4 });
    return { exists: true, data: () => storedDoc };
  },
  set: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
  update: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
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

import type Stripe from "stripe";
import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { POST } from "../webhook/route";

const errorLog = logger.error as unknown as jest.Mock;
const UID = "uid_customer";
const MINE = "cus_mine";
const A = "sub_A_deleted";
const B = "sub_B_replacement";
const C = "sub_C_second";
const EVENT_ID = "evt_fixed_for_assertions";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string; priceId?: string; interval?: "month" | "year" }) {
  return {
    id: args.id,
    customer: MINE,
    status: args.status ?? "active",
    metadata: { firebaseUid: UID, targetPlan: "full" },
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: args.priceId ?? "price_full_y", recurring: { interval: args.interval ?? "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Stripe.Subscription;
}
const setLive = (s: Stripe.Subscription) => live.set(s.id, s as unknown as Record<string, unknown>);

async function deliver(type: string, object: unknown) {
  constructEvent.mockReturnValue({ id: EVENT_ID, type, data: { object } });
  const req = { text: async () => "{}", headers: { get: (k: string) => (k === "stripe-signature" ? "sig" : null) } } as unknown as NextRequest;
  return (await POST(req)).status;
}
const ambiguityRecord = () => errorLog.mock.calls.find((c) => (c[1] as { code?: string })?.code === "multiple_entitlement_subscriptions");

beforeEach(() => {
  live.clear(); writes.length = 0; constructEvent.mockReset(); subscriptionsList.mockClear();
  errorLog.mockClear();
  docReadFails = false; customerRetrieveFails = false; listFails = false; customerMissing = false; listPages = null;
  storedDoc = { email: "c@example.test", stripeCustomerId: MINE, stripeSubscriptionId: A, plan: "full", billingInterval: "year", subscriptionStatus: "active", monthlyLimit: 150, maxModelsPerRun: 5 };
});

describe("C5 — ambiguity observability is part of the safety contract", () => {
  it("REGRESSION: the change-path ambiguity record carries everything needed to investigate", async () => {
    setLive(sub({ id: B, priceId: "price_lite_m", interval: "month" }));
    setLive(sub({ id: C }));
    storedDoc = { ...storedDoc, stripeSubscriptionId: B };

    expect(await deliver("customer.subscription.updated", sub({ id: B, priceId: "price_lite_m", interval: "month" }))).toBe(200);

    const record = ambiguityRecord();
    expect(record).toBeDefined();
    const f = record![1] as Record<string, unknown>;
    expect(f.code).toBe("multiple_entitlement_subscriptions");
    expect(f.eventId).toBe(EVENT_ID);
    expect(f.eventType).toBe("customer.subscription.updated");
    expect(f.stripeCustomerId).toBe(MINE);
    expect(f.uid).toBe(UID);
    expect(f.candidateCount).toBe(2);
    expect(f.candidateSubscriptionIds).toEqual(expect.arrayContaining([B, C]));
    expect(f.storedSubscriptionId).toBe(B);
    expect(String(f.resolution)).toContain("no_mutation");
    expect(writes).toHaveLength(0);
    expect(JSON.stringify(f)).not.toMatch(/whsec_|sk_live|sk_test/);
  });

  it("REGRESSION: the deletion-path ambiguity record carries the same context, including the stored subscription", async () => {
    setLive(sub({ id: A, status: "canceled" }));
    setLive(sub({ id: B }));
    setLive(sub({ id: C }));

    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }))).toBe(200);

    const record = ambiguityRecord();
    expect(record).toBeDefined();
    const f = record![1] as Record<string, unknown>;
    expect(f.eventId).toBe(EVENT_ID);
    expect(f.eventType).toBe("customer.subscription.deleted");
    expect(f.storedSubscriptionId).toBe(A);
    expect(f.candidateCount).toBe(2);
    expect(f.candidateSubscriptionIds).toEqual(expect.arrayContaining([B, C]));
    expect(writes).toHaveLength(0);
  });
});

describe("C5 — a deletion's own target is never evidence that entitlement remains", () => {
  it("REGRESSION: A still listed as active is excluded from its own replacement set, so the downgrade proceeds", async () => {
    // Stripe's list can still report the just-deleted subscription.
    setLive(sub({ id: A, status: "active" }));

    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }))).toBe(200);

    expect(storedDoc.plan).toBe("free");
  });

  it("A is excluded but a genuine replacement B blocks the downgrade", async () => {
    setLive(sub({ id: A, status: "active" }));
    setLive(sub({ id: B }));

    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }))).toBe(200);

    expect(storedDoc.plan).toBe("full");
  });

  it("A excluded, B and C remaining is still ambiguity", async () => {
    setLive(sub({ id: A, status: "active" }));
    setLive(sub({ id: B }));
    setLive(sub({ id: C }));
    const before = { ...storedDoc };

    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }))).toBe(200);

    expect(storedDoc).toEqual(before);
    expect(ambiguityRecord()).toBeDefined();
  });

  it("a replacement on a later page is still found after excluding A", async () => {
    listPages = [
      { data: [sub({ id: A, status: "active" }) as unknown as Record<string, unknown>], has_more: true },
      { data: [sub({ id: B }) as unknown as Record<string, unknown>], has_more: false },
    ];

    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }))).toBe(200);

    expect(storedDoc.plan).toBe("full");
  });
});

describe("C5 — a missing customer is not positive authority to downgrade", () => {
  it("REGRESSION: a definitively missing Stripe customer must not authorise a destructive downgrade", async () => {
    customerMissing = true;
    const before = { ...storedDoc };

    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }))).toBe(200);

    expect(storedDoc).toEqual(before);
    expect(storedDoc.plan).toBe("full");
    expect(writes).toHaveLength(0);
  });
});

describe("C5 — deletion dependency failures stay retryable", () => {
  it("REGRESSION: a Stripe outage while resolving the user returns 5xx, not a lost cancellation", async () => {
    const noUid = { ...(sub({ id: A, status: "canceled" }) as unknown as Record<string, unknown>), metadata: {} };
    setLive(noUid as never);
    customerRetrieveFails = true;
    const before = { ...storedDoc };

    expect(await deliver("customer.subscription.deleted", noUid)).toBeGreaterThanOrEqual(500);
    expect(storedDoc).toEqual(before);
  });

  it("a Firestore read failure during deletion returns 5xx", async () => {
    setLive(sub({ id: A, status: "canceled" }));
    docReadFails = true;
    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }))).toBeGreaterThanOrEqual(500);
    expect(writes).toHaveLength(0);
  });

  it("an enumeration failure during deletion returns 5xx", async () => {
    setLive(sub({ id: A, status: "canceled" }));
    listFails = true;
    expect(await deliver("customer.subscription.deleted", sub({ id: A, status: "canceled" }))).toBeGreaterThanOrEqual(500);
    expect(writes).toHaveLength(0);
  });
});

describe("C5 — past_due keeps the subscription, per the pre-existing contract", () => {
  it("REGRESSION: a past_due subscription is still the customer's subscription", async () => {
    // subscriptionValidation.ts:82,221 and sync-plan/route.ts:140 all treat
    // past_due as an active subscription; only effective entitlement is
    // withheld, by the entitlement resolver.
    setLive(sub({ id: A, status: "past_due" }));

    expect(await deliver("customer.subscription.updated", sub({ id: A, status: "past_due" }))).toBe(200);

    expect(storedDoc.stripeSubscriptionId).toBe(A);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.subscriptionStatus).toBe("past_due");
    expect(storedDoc.billingInterval).toBe("year");
  });
});
