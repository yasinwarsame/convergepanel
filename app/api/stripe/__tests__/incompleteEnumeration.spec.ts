/**
 * Phase BILLING-WEBHOOK-B1-C8 — incomplete enumeration, through every
 * automatic writer.
 *
 * The resolver-level contract is pinned in
 * lib/billing/__tests__/authorityEnumerationBound.spec.ts. This file proves
 * the part that actually hurt a customer: that no caller converts "we stopped
 * looking" into a destructive write. The reviewer's executed reproduction was
 * a customer with more than a thousand subscriptions whose live annual
 * subscription sat beyond the enumeration bound — request-time reconciliation
 * and self-serve sync both concluded "no entitlement", downgraded them to
 * free, and deleted their subscription reference.
 *
 * Incomplete enumeration is treated the way ambiguity is: a persistent
 * customer-domain condition that retrying identical Stripe state cannot
 * resolve. So the webhook acknowledges it terminally rather than retrying
 * forever, and every path leaves state untouched and says so in a structured
 * record.
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

type Sub = Record<string, unknown> & { id: string; customer: string; status: string };

const constructEvent = jest.fn();
let live: Sub[] = [];
const subscriptionsUpdate = jest.fn(async () => ({}));
const subscriptionsRetrieve = jest.fn(async (id: string) => {
  const s = live.find((x) => x.id === id);
  if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });
  return s;
});
const subscriptionsList = jest.fn(async (args: { customer?: string; starting_after?: string; limit?: number }) => {
  const all = live.filter((s) => s.customer === args.customer);
  const limit = args.limit ?? 10;
  let start = 0;
  if (args.starting_after) start = all.findIndex((s) => s.id === args.starting_after) + 1;
  return { data: all.slice(start, start + limit), has_more: start + limit < all.length };
});
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
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: async () => ({ status: "authenticated", uid: "uid_customer", source: "bearer" }),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

import type Stripe from "stripe";
import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { POST } from "../webhook/route";
import { validateUserSubscription } from "@/lib/stripe/subscriptionValidation";
import { POST as SYNC_PLAN } from "@/app/api/billing/sync-plan/route";

const UID = "uid_customer";
const MINE = "cus_mine";
const LIVE = "sub_live_annual";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string }): Sub {
  return {
    id: args.id,
    customer: MINE,
    status: args.status ?? "active",
    created: 1,
    metadata: { firebaseUid: UID, targetPlan: "full" },
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: "price_full_y", recurring: { interval: "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Sub;
}

/** The reviewer's executed shape: 1000 dead subscriptions, then the live one. */
const beyondTheBound = () => [
  ...Array.from({ length: 1000 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled" })),
  sub({ id: LIVE }),
];

async function deliver(type: string, object: unknown) {
  constructEvent.mockReturnValue({ id: "evt_c8", type, data: { object } });
  const req = { text: async () => "{}", headers: { get: (k: string) => (k === "stripe-signature" ? "sig" : null) } } as unknown as NextRequest;
  return (await POST(req)).status;
}
async function selfSync() {
  const req = { json: async () => ({}), headers: { get: () => null } } as unknown as NextRequest;
  const res = await SYNC_PLAN(req);
  return { status: res.status, body: await res.json() };
}

const USAGE = { usageMonth: "2026-09", runsThisMonth: 7, videoRunsThisMonth: 4, tokensUsedCurrentPeriod: 120_000, totalRuns: 210 };
const usageOf = (d: Record<string, unknown>) => ({
  usageMonth: d.usageMonth, runsThisMonth: d.runsThisMonth, videoRunsThisMonth: d.videoRunsThisMonth,
  tokensUsedCurrentPeriod: d.tokensUsedCurrentPeriod, totalRuns: d.totalRuns,
});
const incompleteRecords = () =>
  (logger.error as jest.Mock).mock.calls.filter((c) => (c[1] as { code?: string })?.code === "authority_enumeration_incomplete");

function seedPaidCustomer() {
  storedDoc = {
    email: "c@example.test", plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: LIVE,
    subscriptionStatus: "active", billingInterval: "year", monthlyLimit: 150, maxModelsPerRun: 5, ...USAGE,
  };
  live = beyondTheBound();
}

beforeEach(() => {
  live = []; writes.length = 0; constructEvent.mockReset();
  subscriptionsList.mockClear(); subscriptionsUpdate.mockClear();
  (logger.error as jest.Mock).mockClear();
  seedPaidCustomer();
});

describe("C8 P1 — no automatic writer may downgrade on an unfinished enumeration", () => {
  it("REGRESSION: request-time reconciliation must not downgrade the paying customer", async () => {
    const before = { ...storedDoc };
    const ok = await validateUserSubscription(UID);
    expect(ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(storedDoc).toEqual(before);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(LIVE);
  });

  it("REGRESSION: self-serve sync must not downgrade, and must not report success", async () => {
    const before = { ...storedDoc };
    const { status, body } = await selfSync();
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.success).not.toBe(true);
    expect(writes).toHaveLength(0);
    expect(storedDoc).toEqual(before);
  });

  it("REGRESSION: a webhook subscription event must not downgrade", async () => {
    const before = { ...storedDoc };
    const status = await deliver("customer.subscription.updated", sub({ id: LIVE }));
    expect(status).toBe(200);
    expect(writes).toHaveLength(0);
    expect(storedDoc).toEqual(before);
  });

  it("REGRESSION: a deletion must not downgrade on an unfinished replacement search", async () => {
    const before = { ...storedDoc };
    const status = await deliver("customer.subscription.deleted", sub({ id: LIVE, status: "canceled" }));
    expect(status).toBe(200);
    expect(writes).toHaveLength(0);
    expect(storedDoc).toEqual(before);
    expect(storedDoc.plan).toBe("full");
  });

  it("REGRESSION: the subscription reference is never cleared", async () => {
    await validateUserSubscription(UID);
    await selfSync();
    await deliver("customer.subscription.updated", sub({ id: LIVE }));
    expect(storedDoc.stripeSubscriptionId).toBe(LIVE);
    expect(storedDoc.stripeSubscriptionId).not.toBe("DELETE");
  });

  it("REGRESSION: no arbitrary candidate from the partial set is adopted", async () => {
    live = [sub({ id: "sub_partial" }), ...beyondTheBound()];
    storedDoc = { ...storedDoc, plan: "lite", billingInterval: "month" };
    await validateUserSubscription(UID);
    await selfSync();
    await deliver("customer.subscription.updated", sub({ id: "sub_partial" }));
    expect(storedDoc.stripeSubscriptionId).not.toBe("sub_partial");
    expect(writes).toHaveLength(0);
  });

  it("REGRESSION: usage stays at 7 through every automatic writer", async () => {
    await validateUserSubscription(UID);
    await selfSync();
    await deliver("customer.subscription.updated", sub({ id: LIVE }));
    await deliver("invoice.payment_succeeded", { id: "in_1", parent: { type: "subscription_details", subscription_details: { subscription: LIVE } } });
    await deliver("customer.subscription.deleted", sub({ id: LIVE, status: "canceled" }));
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("REGRESSION: no Stripe metadata is written under an unfinished enumeration", async () => {
    live = [...beyondTheBound()].map((s) => ({ ...s, metadata: { targetPlan: "full" } }));
    await deliver("customer.subscription.updated", sub({ id: LIVE }));
    await validateUserSubscription(UID);
    await selfSync();
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("all three paths agree, and each says so in a structured record", async () => {
    await validateUserSubscription(UID);
    await selfSync();
    await deliver("customer.subscription.updated", sub({ id: LIVE }));

    const records = incompleteRecords();
    expect(records.length).toBeGreaterThanOrEqual(3);
    const paths = records.map((r) => (r[1] as { path?: string }).path);
    expect(paths).toEqual(expect.arrayContaining(["request_time_reconciliation", "self_serve_plan_sync", "webhook_subscription_change"]));
    for (const r of records) {
      expect(r[1]).toMatchObject({
        code: "authority_enumeration_incomplete",
        stripeCustomerId: MINE,
        uid: UID,
        resolution: "no_mutation_authority_not_proven",
      });
      expect(JSON.stringify(r[1])).not.toMatch(/sk_live|sk_test|whsec_|card|payment_method/i);
    }
  });

  it("the condition is terminal, not an infinite webhook retry", async () => {
    // Retrying identical Stripe state cannot finish the enumeration, so the
    // delivery is acknowledged and the record is the operator's signal —
    // exactly as for an ambiguous subscription set.
    expect(await deliver("customer.subscription.updated", sub({ id: LIVE }))).toBe(200);
    expect(await deliver("customer.subscription.created", sub({ id: LIVE }))).toBe(200);
    expect(await deliver("invoice.payment_succeeded", { id: "in_1", parent: { type: "subscription_details", subscription_details: { subscription: LIVE } } })).toBe(200);
    expect(writes).toHaveLength(0);
  });
});

describe("C8 — a customer inside the bound is completely unaffected", () => {
  it("an ordinary customer still reconciles normally", async () => {
    storedDoc = { email: "c@example.test", plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: "sub_old", subscriptionStatus: "active", billingInterval: "month", ...USAGE };
    live = [sub({ id: "sub_old", status: "canceled" }), sub({ id: LIVE })];

    await validateUserSubscription(UID);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(LIVE);
    expect(usageOf(storedDoc)).toEqual(USAGE);
    expect(incompleteRecords()).toHaveLength(0);
  });

  it("a genuinely empty customer set still downgrades, proving the fix did not disable absence", async () => {
    storedDoc = { email: "c@example.test", plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: "sub_old", subscriptionStatus: "active", billingInterval: "year", ...USAGE };
    live = [sub({ id: "sub_old", status: "canceled" })];

    await validateUserSubscription(UID);
    expect(storedDoc.plan).toBe("free");
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("a large-but-finite customer just inside the bound still resolves", async () => {
    storedDoc = { email: "c@example.test", plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: "sub_old", subscriptionStatus: "active", billingInterval: "month", ...USAGE };
    live = [...Array.from({ length: 900 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled" })), sub({ id: LIVE })];

    await validateUserSubscription(UID);
    expect(storedDoc.stripeSubscriptionId).toBe(LIVE);
    expect(incompleteRecords()).toHaveLength(0);
  });
});
