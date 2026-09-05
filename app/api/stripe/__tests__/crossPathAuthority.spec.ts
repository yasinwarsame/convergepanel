/**
 * Phase BILLING-WEBHOOK-B1-C6 — CROSS-PATH CONVERGENCE.
 *
 * A safe webhook sitting next to an unsafe automatic writer is not a safe
 * system. This spec runs the SAME Stripe and Firestore state through both
 * reconciliation paths — the Stripe delivery and the request-time
 * reconciliation that runs on ordinary paid requests — and requires them to
 * reach the same billing facts, or to refuse in the same way.
 *
 * The core acceptance case is the last one the C5-R1 review broke on: the
 * webhook sees B and C and refuses to choose; the very next ordinary
 * application request must also refuse to choose.
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
import { POST } from "../webhook/route";
import { validateUserSubscription } from "@/lib/stripe/subscriptionValidation";
import { POST as SYNC_PLAN } from "@/app/api/billing/sync-plan/route";

const UID = "uid_customer";
const MINE = "cus_mine";
const A = "sub_A_dead";
const B = "sub_B_lite_monthly";
const C = "sub_C_full_annual";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string; priceId?: string; interval?: "month" | "year"; created?: number }): Sub {
  return {
    id: args.id,
    customer: MINE,
    status: args.status ?? "active",
    created: args.created ?? 1,
    metadata: { firebaseUid: UID, targetPlan: "full" },
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: args.priceId ?? "price_full_y", recurring: { interval: args.interval ?? "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Sub;
}
const subB = () => sub({ id: B, priceId: "price_lite_m", interval: "month", created: 100 });
const subC = () => sub({ id: C, priceId: "price_full_y", interval: "year", created: 200 });

async function deliver(type: string, object: unknown) {
  constructEvent.mockReturnValue({ id: "evt_" + Math.random().toString(36).slice(2), type, data: { object } });
  const req = { text: async () => "{}", headers: { get: (k: string) => (k === "stripe-signature" ? "sig" : null) } } as unknown as NextRequest;
  return (await POST(req)).status;
}

/** The self-serve plan sync, as the billing page invokes it after checkout. */
async function selfSync() {
  const req = { json: async () => ({}), headers: { get: () => null } } as unknown as NextRequest;
  return (await SYNC_PLAN(req)).status;
}

/** The billing facts a customer's plan is made of — everything a bill depends on. */
const billingOf = (d: Record<string, unknown>) => ({
  plan: d.plan,
  billingInterval: d.billingInterval,
  subscriptionId: d.stripeSubscriptionId,
  subscriptionStatus: d.subscriptionStatus,
  monthlyLimit: d.monthlyLimit,
  maxModelsPerRun: d.maxModelsPerRun,
  billingCycleStart: d.billingCycleStart,
  currentPeriodEnd: d.currentPeriodEnd,
});

type Scenario = {
  name: string;
  stored: Record<string, unknown>;
  stripe: () => Sub[];
  /** The subscription the Stripe delivery is about. */
  eventSubject: () => Sub;
};

const SCENARIOS: Scenario[] = [
  {
    name: "1. exactly one candidate B",
    stored: { plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "month" },
    stripe: () => [sub({ id: A, status: "canceled" }), subC()],
    eventSubject: () => subC(),
  },
  {
    name: "2. zero candidates",
    stored: { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" },
    stripe: () => [sub({ id: A, status: "canceled" })],
    eventSubject: () => sub({ id: A, status: "canceled" }),
  },
  {
    name: "3. B and C ambiguity",
    stored: { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" },
    stripe: () => [sub({ id: A, status: "canceled" }), subB(), subC()],
    eventSubject: () => subB(),
  },
  {
    name: "4. stale stored A with a live B",
    stored: { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" },
    stripe: () => [sub({ id: A, status: "canceled" }), subB()],
    eventSubject: () => sub({ id: A, status: "canceled" }),
  },
  {
    name: "5. stale stored A with B and C",
    stored: { plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "month" },
    stripe: () => [sub({ id: A, status: "canceled" }), subB(), subC()],
    eventSubject: () => sub({ id: A, status: "canceled" }),
  },
  {
    name: "6. a lone past_due B",
    stored: { plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "month" },
    stripe: () => [sub({ id: A, status: "canceled" }), { ...subB(), status: "past_due" } as Sub],
    eventSubject: () => ({ ...subB(), status: "past_due" } as Sub),
  },
  {
    name: "7. past_due B alongside active C",
    stored: { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" },
    stripe: () => [{ ...subB(), status: "past_due" } as Sub, subC()],
    eventSubject: () => subC(),
  },
  {
    name: "8. the stored subscription is definitively missing at Stripe, and B exists",
    stored: { plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: "sub_vanished", subscriptionStatus: "active", billingInterval: "month" },
    stripe: () => [subC()],
    eventSubject: () => subC(),
  },
  {
    name: "9. active B alongside past_due C",
    stored: { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" },
    stripe: () => [subB(), { ...subC(), status: "past_due" } as Sub],
    eventSubject: () => subB(),
  },
  {
    name: "10. two past_due subscriptions",
    stored: { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" },
    stripe: () => [{ ...subB(), status: "past_due" } as Sub, { ...subC(), status: "past_due" } as Sub],
    eventSubject: () => ({ ...subB(), status: "past_due" } as Sub),
  },
  {
    name: "11. the only candidate sits beyond the first Stripe page",
    stored: { plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "month" },
    stripe: () => [
      ...Array.from({ length: 100 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled", created: 1000 + i })),
      subC(),
    ],
    eventSubject: () => subC(),
  },
];

beforeEach(() => {
  live = []; writes.length = 0; constructEvent.mockReset();
  subscriptionsList.mockClear(); subscriptionsUpdate.mockClear();
});

describe("C6 — the two automatic writers must not disagree", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: webhook and request-time reach the same billing facts`, async () => {
      storedDoc = { email: "c@example.test", ...scenario.stored };
      live = scenario.stripe();
      await deliver("customer.subscription.updated", scenario.eventSubject());
      const afterWebhook = billingOf(storedDoc);
      const webhookWrote = writes.length > 0;

      storedDoc = { email: "c@example.test", ...scenario.stored };
      live = scenario.stripe();
      writes.length = 0;
      await validateUserSubscription(UID);
      const afterRequest = billingOf(storedDoc);
      const requestWrote = writes.length > 0;

      storedDoc = { email: "c@example.test", ...scenario.stored };
      live = scenario.stripe();
      writes.length = 0;
      await selfSync();
      const afterSelfSync = billingOf(storedDoc);
      const selfSyncWrote = writes.length > 0;

      expect(afterRequest).toEqual(afterWebhook);
      expect(afterSelfSync).toEqual(afterWebhook);
      expect(requestWrote).toBe(webhookWrote);
      expect(selfSyncWrote).toBe(webhookWrote);
    });
  }
});

describe("C6 — the acceptance case: refusal must survive the next ordinary request", () => {
  it("REGRESSION: the webhook refuses B/C, and the very next request must refuse too", async () => {
    storedDoc = { email: "c@example.test", plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
    live = [sub({ id: A, status: "canceled" }), subB(), subC()];

    expect(await deliver("customer.subscription.updated", subB())).toBe(200);
    const afterWebhook = { ...storedDoc };
    expect(writes).toHaveLength(0);

    await validateUserSubscription(UID);

    expect(storedDoc).toEqual(afterWebhook);
    expect(writes).toHaveLength(0);
  });

  it("REGRESSION: a whole burst of ordinary requests still resolves nothing", async () => {
    storedDoc = { email: "c@example.test", plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
    live = [sub({ id: A, status: "canceled" }), subB(), subC()];
    const before = { ...storedDoc };

    await deliver("customer.subscription.updated", subC());
    for (let i = 0; i < 5; i++) await validateUserSubscription(UID);

    expect(storedDoc).toEqual(before);
    expect(writes).toHaveLength(0);
  });

  it("REGRESSION: neither path adopts a candidate once the ambiguity is resolved in Stripe's array order alone", async () => {
    const run = async (order: Sub[]) => {
      storedDoc = { email: "c@example.test", plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
      live = order;
      writes.length = 0;
      await deliver("customer.subscription.updated", subB());
      await validateUserSubscription(UID);
      return { doc: { ...storedDoc }, wrote: writes.length };
    };
    const forward = await run([sub({ id: A, status: "canceled" }), subB(), subC()]);
    const reversed = await run([subC(), subB(), sub({ id: A, status: "canceled" })]);
    expect(reversed).toEqual(forward);
  });
});

describe("C7 — the acceptance case: three automatic writers, one refusal, one usage counter", () => {
  const USAGE = { usageMonth: "2026-09", runsThisMonth: 7, videoRunsThisMonth: 4, tokensUsedCurrentPeriod: 120_000, totalRuns: 210 };
  const usageOf = (d: Record<string, unknown>) => ({
    usageMonth: d.usageMonth, runsThisMonth: d.runsThisMonth, videoRunsThisMonth: d.videoRunsThisMonth,
    tokensUsedCurrentPeriod: d.tokensUsedCurrentPeriod, totalRuns: d.totalRuns,
  });

  const ambiguous = () => {
    storedDoc = {
      email: "c@example.test", plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A,
      subscriptionStatus: "active", billingInterval: "year", ...USAGE,
    };
    live = [sub({ id: A, status: "canceled" }), subB(), subC()];
  };

  /** Every automatic writer, in every order they could actually interleave. */
  const WRITERS: Array<[string, () => Promise<unknown>]> = [
    ["webhook.updated", () => deliver("customer.subscription.updated", subB())],
    ["webhook.invoice", () => deliver("invoice.payment_succeeded", { id: "in_1", subscription: C })],
    ["request-time", () => validateUserSubscription(UID)],
    ["self-sync", () => selfSync()],
    ["post-checkout", () => deliver("checkout.session.completed", { id: "cs_1", mode: "subscription", subscription: C, customer: MINE, metadata: { firebaseUid: UID, targetPlan: "full" } }).then(() => selfSync())],
  ];

  it("REGRESSION: usage stays at 7 and authority stays ambiguous, whatever the order", async () => {
    const orders = [
      [0, 1, 2, 3, 4],
      [4, 3, 2, 1, 0],
      [3, 0, 4, 2, 1],
      [2, 4, 0, 3, 1],
    ];
    for (const order of orders) {
      ambiguous();
      writes.length = 0;
      for (const i of order) await WRITERS[i][1]();

      expect(usageOf(storedDoc)).toEqual(USAGE);
      expect(storedDoc.runsThisMonth).toBe(7);
      expect(storedDoc.stripeSubscriptionId).toBe(A);
      expect(storedDoc.plan).toBe("full");
      expect(writes).toHaveLength(0);
    }
  });

  it("REGRESSION: running every writer twice over still changes nothing", async () => {
    ambiguous();
    const before = { ...storedDoc };
    for (let pass = 0; pass < 2; pass++) for (const [, run] of WRITERS) await run();
    expect(storedDoc).toEqual(before);
  });

  it("CONTRAST: with exactly one subscription the same sequence upgrades, and usage still stays at 7", async () => {
    storedDoc = {
      email: "c@example.test", plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: A,
      subscriptionStatus: "active", billingInterval: "month", ...USAGE,
    };
    live = [sub({ id: A, status: "canceled" }), subC()];

    for (const [, run] of WRITERS) await run();

    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.billingInterval).toBe("year");
    expect(storedDoc.stripeSubscriptionId).toBe(C);
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("REGRESSION: usage is monotonic across a mixed synchronization sequence", async () => {
    storedDoc = {
      email: "c@example.test", plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: A,
      subscriptionStatus: "active", billingInterval: "month", ...USAGE,
    };
    live = [sub({ id: A, status: "canceled" }), subC()];

    for (const [, run] of WRITERS) {
      const before = storedDoc.runsThisMonth as number;
      await run();
      expect(storedDoc.runsThisMonth as number).toBeGreaterThanOrEqual(before);
    }
    expect(storedDoc.runsThisMonth).toBe(7);
  });
});
