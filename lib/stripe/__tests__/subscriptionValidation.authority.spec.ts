/**
 * Phase BILLING-WEBHOOK-B1-C6 — REQUEST-TIME AUTHORITY.
 *
 * The C5-R1 exact-head review proved that PR #145's central guarantee did not
 * survive contact with normal operation. The webhook correctly refuses to
 * choose between two plan-bearing subscriptions B and C; the very next
 * ordinary paid request then ran `validateUserSubscription`, which had its
 * OWN selection rule — `limit: 10`, sort by `created`, take the newest — and
 * persisted one of them as authority. With equal creation timestamps the
 * winner flipped with Stripe's array order, reintroducing exactly the
 * delivery-order dependence this PR exists to remove.
 *
 * The same truncated listing was independently destructive: ten newer
 * throwaway subscriptions filled the only page, the authoritative
 * subscription was never seen, and a paying customer was downgraded to free.
 *
 * These are not webhook tests. They pin the contract of the path that runs on
 * `/api/run-panel`, `/api/verify-claim`, the workspace run and verification
 * routes, `/api/user/usage` and `/api/billing/validate-subscription`.
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

type Sub = Record<string, unknown> & { id: string; customer: string; status: string; created: number };

/** Insertion-ordered, so a test can control the order Stripe "returns". */
let live: Sub[] = [];
let listFails = false;
/** Fail only the Nth call (1-based), to model a mid-pagination outage. */
let listFailsOnCall = 0;
let customerMissing = false;
let listCalls = 0;

const subscriptionsList = jest.fn(async (args: { customer?: string; starting_after?: string; limit?: number }) => {
  listCalls += 1;
  if (listFails) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  if (listFailsOnCall === listCalls) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  if (customerMissing) throw Object.assign(new Error("No such customer"), { code: "resource_missing", statusCode: 404 });
  const all = live.filter((s) => s.customer === args.customer);
  const limit = args.limit ?? 10;
  let start = 0;
  if (args.starting_after) start = all.findIndex((s) => s.id === args.starting_after) + 1;
  const data = all.slice(start, start + limit);
  return { data, has_more: start + limit < all.length };
});
jest.mock("@/lib/stripe/client", () => ({
  stripe: { subscriptions: { list: (...a: unknown[]) => subscriptionsList(...(a as [{ customer?: string }])) } },
}));

let storedDoc: Record<string, unknown> = {};
const writes: Record<string, unknown>[] = [];
const docHandle = {
  get: async () => ({ exists: true, data: () => storedDoc }),
  set: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
  update: async (d: Record<string, unknown>) => { writes.push(d); storedDoc = { ...storedDoc, ...d }; },
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => docHandle }) },
  firebaseAdmin: {
    firestore: {
      Timestamp: { now: () => "TS_NOW", fromDate: (d: Date) => `TS_${d.toISOString()}` },
      FieldValue: { delete: () => "DELETE" },
    },
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { logger } from "@/lib/logger";
import { validateUserSubscription } from "../subscriptionValidation";

const UID = "uid_customer";
const MINE = "cus_mine";
const FOREIGN = "cus_foreign";
const A = "sub_A_dead";
const B = "sub_B_lite_monthly";
const C = "sub_C_full_annual";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);

function sub(args: { id: string; status?: string; priceId?: string; interval?: "month" | "year"; customer?: string; created?: number }): Sub {
  return {
    id: args.id,
    customer: args.customer ?? MINE,
    status: args.status ?? "active",
    created: args.created ?? 1,
    metadata: { firebaseUid: UID },
    current_period_start: AUG_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: args.priceId ?? "price_full_y", recurring: { interval: args.interval ?? "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Sub;
}
const subB = (created = 100) => sub({ id: B, priceId: "price_lite_m", interval: "month", created });
const subC = (created = 200) => sub({ id: C, priceId: "price_full_y", interval: "year", created });

/** The billing facts a customer's plan is made of. */
const billingOf = (d: Record<string, unknown>) => ({
  plan: d.plan, billingInterval: d.billingInterval,
  subscriptionId: d.stripeSubscriptionId, subscriptionStatus: d.subscriptionStatus,
});
const ambiguityRecords = () =>
  (logger.error as jest.Mock).mock.calls.filter((c) => (c[1] as { code?: string })?.code === "multiple_entitlement_subscriptions");

function reset() {
  live = []; writes.length = 0; listCalls = 0;
  subscriptionsList.mockClear();
  listFails = false; listFailsOnCall = 0; customerMissing = false;
  (logger.error as jest.Mock).mockClear();
  (logger.warn as jest.Mock).mockClear();
}
beforeEach(reset);

/** Stored A is dead; the customer holds BOTH B and C. The C5-R1 scenario. */
function twoLiveCandidates() {
  storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
  live = [sub({ id: A, status: "canceled" }), subB(), subC()];
}

describe("C6 P1 — an ordinary request must not resolve what the webhook refused to resolve", () => {
  it("REGRESSION: two plan-bearing candidates are ambiguous at request time too — nothing is written", async () => {
    twoLiveCandidates();
    const before = { ...storedDoc };
    await validateUserSubscription(UID);
    expect(writes).toHaveLength(0);
    expect(storedDoc).toEqual(before);
  });

  it("REGRESSION: reversing Stripe's array order gives a byte-identical result", async () => {
    twoLiveCandidates();
    await validateUserSubscription(UID);
    const forward = { ...storedDoc };
    const forwardWrites = writes.length;

    reset();
    twoLiveCandidates();
    live = [live[0], live[2], live[1]];
    await validateUserSubscription(UID);

    expect(storedDoc).toEqual(forward);
    expect(writes).toHaveLength(forwardWrites);
  });

  it("REGRESSION: with EQUAL creation timestamps neither candidate is selected, in either order", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
    live = [subB(500), subC(500)];
    await validateUserSubscription(UID);
    expect(storedDoc.stripeSubscriptionId).toBe(A);
    expect(writes).toHaveLength(0);

    reset();
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
    live = [subC(500), subB(500)];
    await validateUserSubscription(UID);
    expect(storedDoc.stripeSubscriptionId).toBe(A);
    expect(writes).toHaveLength(0);
  });

  it("ambiguity is observable: the same classification the webhook emits, tagged as the request-time path", async () => {
    twoLiveCandidates();
    await validateUserSubscription(UID);
    const records = ambiguityRecords();
    expect(records).toHaveLength(1);
    expect(records[0][1]).toMatchObject({
      code: "multiple_entitlement_subscriptions",
      path: "request_time_reconciliation",
      stripeCustomerId: MINE,
      uid: UID,
      storedSubscriptionId: A,
      candidateCount: 2,
      resolution: "no_mutation_ambiguous_subscription_set",
    });
    expect((records[0][1] as { candidateSubscriptionIds: string[] }).candidateSubscriptionIds.sort()).toEqual([B, C].sort());
  });

  it("the ambiguity record carries no secret and no payment detail", async () => {
    twoLiveCandidates();
    await validateUserSubscription(UID);
    expect(JSON.stringify(ambiguityRecords()[0])).not.toMatch(/sk_live|sk_test|whsec_|card|payment_method/i);
  });
});

describe("C6 P1 — B/C order-invariance matrix", () => {
  const storedVariants: Array<[string, Record<string, unknown>]> = [
    ["stored B", { plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: B, subscriptionStatus: "active", billingInterval: "month" }],
    ["stored C", { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: C, subscriptionStatus: "active", billingInterval: "year" }],
    ["no stored subscription", { plan: "full", stripeCustomerId: MINE, subscriptionStatus: "active", billingInterval: "year" }],
    ["stale dead A", { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" }],
  ];
  const candidateVariants: Array<[string, () => Sub[]]> = [
    ["same plan", () => [sub({ id: B, priceId: "price_full_y", interval: "year", created: 100 }), sub({ id: C, priceId: "price_full_y", interval: "year", created: 200 })]],
    ["different plans", () => [subB(100), subC(200)]],
    ["equal created", () => [subB(500), subC(500)]],
    ["unequal created", () => [subB(1), subC(999)]],
  ];

  for (const [storedName, stored] of storedVariants) {
    for (const [candName, candidates] of candidateVariants) {
      it(`${storedName} + ${candName}: no selection, no mutation, order-invariant`, async () => {
        storedDoc = { ...stored };
        live = candidates();
        await validateUserSubscription(UID);
        const forward = { ...storedDoc };
        expect(writes).toHaveLength(0);

        reset();
        storedDoc = { ...stored };
        live = candidates().reverse();
        await validateUserSubscription(UID);

        expect(storedDoc).toEqual(forward);
        expect(writes).toHaveLength(0);
      });
    }
  }
});

describe("C6 P1 — a truncated first page is not proof of absence", () => {
  it("REGRESSION: ten newer irrelevant subscriptions must not downgrade a paying customer", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: C, subscriptionStatus: "active", billingInterval: "year" };
    live = [
      ...Array.from({ length: 10 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled", created: 1000 + i })),
      subC(1),
    ];
    await validateUserSubscription(UID);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(C);
    expect(writes).toHaveLength(0);
  });

  it("REGRESSION: the authoritative subscription is found beyond the first Stripe PAGE", async () => {
    storedDoc = { plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "month" };
    live = [
      ...Array.from({ length: 100 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled", created: 1000 + i })),
      subC(1),
    ];
    await validateUserSubscription(UID);
    expect(subscriptionsList.mock.calls.length).toBeGreaterThan(1);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(C);
  });

  it("B on page one and C on page two is still ambiguity, not a page-one win", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
    live = [
      subB(1),
      ...Array.from({ length: 99 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled", created: 1000 + i })),
      subC(2),
    ];
    await validateUserSubscription(UID);
    expect(writes).toHaveLength(0);
    expect(ambiguityRecords()).toHaveLength(1);
  });

  it("ZERO candidates is concluded only after the listing is exhausted", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
    live = Array.from({ length: 150 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled", created: 1000 + i }));
    await validateUserSubscription(UID);
    expect(subscriptionsList.mock.calls.length).toBeGreaterThan(1);
    expect(storedDoc.plan).toBe("free");
  });

  it("REGRESSION: a transient failure fetching page two must not conclude no-subscription", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: C, subscriptionStatus: "active", billingInterval: "year" };
    live = [
      ...Array.from({ length: 100 }, (_, i) => sub({ id: `sub_noise_${i}`, status: "canceled", created: 1000 + i })),
      subC(1),
    ];
    listFailsOnCall = 2;
    const ok = await validateUserSubscription(UID);
    expect(ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(storedDoc.plan).toBe("full");
  });
});

describe("C6 — request-time dependency and identity contract", () => {
  it("a transient Stripe failure preserves state and reports failure — it never downgrades", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: C, subscriptionStatus: "active", billingInterval: "year" };
    live = [subC()];
    listFails = true;
    const ok = await validateUserSubscription(UID);
    expect(ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(storedDoc.plan).toBe("full");
  });

  it("REGRESSION: a definitively missing Stripe customer is not positive authority to downgrade", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: C, subscriptionStatus: "active", billingInterval: "year" };
    customerMissing = true;
    const ok = await validateUserSubscription(UID);
    expect(ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(storedDoc.plan).toBe("full");
  });

  it("REGRESSION: a caller-supplied customer id that conflicts with the stored binding is refused", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: C, subscriptionStatus: "active", billingInterval: "year" };
    live = [sub({ id: "sub_foreign", customer: FOREIGN })];
    const ok = await validateUserSubscription(UID, FOREIGN);
    expect(ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(subscriptionsList.mock.calls.some((c) => (c[0] as { customer?: string })?.customer === FOREIGN)).toBe(false);
  });

  it("REGRESSION: with no stored binding, a caller-supplied customer id may not authorise a downgrade", async () => {
    storedDoc = { plan: "full", subscriptionStatus: "active", billingInterval: "year" };
    live = [];
    const ok = await validateUserSubscription(UID, FOREIGN);
    expect(writes).toHaveLength(0);
    expect(storedDoc.plan).toBe("full");
    expect(ok).toBe(true);
  });
});

describe("C6 — exactly one candidate still reconciles", () => {
  it("adopts the only plan-bearing subscription, whatever its position in the list", async () => {
    storedDoc = { plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "month" };
    live = [sub({ id: A, status: "canceled" }), subC()];
    await validateUserSubscription(UID);
    expect(billingOf(storedDoc)).toEqual({ plan: "full", billingInterval: "year", subscriptionId: C, subscriptionStatus: "active" });
  });

  it("writes nothing when local state already matches the single candidate", async () => {
    live = [subC()];
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: C, subscriptionStatus: "active", billingInterval: "year" };
    await validateUserSubscription(UID);
    expect(writes).toHaveLength(0);
  });

  it("downgrades once the customer's whole set is proven to hold nothing plan-bearing", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
    live = [sub({ id: A, status: "canceled" })];
    await validateUserSubscription(UID);
    expect(storedDoc.plan).toBe("free");
  });
});

describe("C6 — past_due is cross-path consistent", () => {
  it("a lone past_due subscription remains the customer's subscription, not an absence", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: C, subscriptionStatus: "active", billingInterval: "year" };
    live = [subC()];
    (live[0] as Sub).status = "past_due";
    await validateUserSubscription(UID);
    expect(storedDoc.plan).toBe("full");
    expect(storedDoc.stripeSubscriptionId).toBe(C);
    expect(storedDoc.subscriptionStatus).toBe("past_due");
  });

  it("past_due B alongside active C is ambiguity, exactly as on the webhook path", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
    const b = subB(); b.status = "past_due";
    live = [b, subC()];
    await validateUserSubscription(UID);
    expect(writes).toHaveLength(0);
    expect(ambiguityRecords()).toHaveLength(1);
  });

  it("active B alongside past_due C is ambiguity", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
    const c = subC(); c.status = "past_due";
    live = [subB(), c];
    await validateUserSubscription(UID);
    expect(writes).toHaveLength(0);
  });

  it("two past_due subscriptions are ambiguity, not a newest-wins pick", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year" };
    const b = subB(); b.status = "past_due";
    const c = subC(); c.status = "past_due";
    live = [b, c];
    await validateUserSubscription(UID);
    expect(writes).toHaveLength(0);
  });
});

describe("C6 — the admin override survives the shared-authority refactor", () => {
  const OVERRIDE = { override: { active: true } };

  it("exactly one candidate still reconciles alongside an override", async () => {
    storedDoc = { plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "month", ...OVERRIDE };
    live = [subC()];
    await validateUserSubscription(UID);
    expect(storedDoc.stripeSubscriptionId).toBe(C);
    expect((storedDoc as { override?: { active?: boolean } }).override?.active).toBe(true);
  });

  it("ambiguity writes nothing and leaves the override untouched", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year", ...OVERRIDE };
    live = [subB(), subC()];
    await validateUserSubscription(UID);
    expect(writes).toHaveLength(0);
    expect((storedDoc as { override?: { active?: boolean } }).override?.active).toBe(true);
  });

  it("a past_due candidate reconciles alongside an override", async () => {
    storedDoc = { plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "month", ...OVERRIDE };
    const c = subC(); c.status = "past_due";
    live = [c];
    await validateUserSubscription(UID);
    expect(storedDoc.stripeSubscriptionId).toBe(C);
  });

  it("REGRESSION: an override still blocks the no-entitlement downgrade", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year", ...OVERRIDE };
    live = [sub({ id: A, status: "canceled" })];
    await validateUserSubscription(UID);
    expect(storedDoc.plan).toBe("full");
    expect(writes).toHaveLength(0);
  });

  it("a transient failure leaves an overridden user untouched", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: C, subscriptionStatus: "active", billingInterval: "year", ...OVERRIDE };
    listFails = true;
    await validateUserSubscription(UID);
    expect(writes).toHaveLength(0);
    expect(storedDoc.plan).toBe("full");
  });
});

describe("C6 — request-time reconciliation never touches usage", () => {
  const USAGE = { usageMonth: "2026-09", runsThisMonth: 37, videoRunsThisMonth: 4, tokensUsedCurrentPeriod: 120_000, totalRuns: 210 };
  const usageOf = (d: Record<string, unknown>) => ({
    usageMonth: d.usageMonth, runsThisMonth: d.runsThisMonth, videoRunsThisMonth: d.videoRunsThisMonth,
    tokensUsedCurrentPeriod: d.tokensUsedCurrentPeriod, totalRuns: d.totalRuns,
  });

  it("a reconciling write leaves every usage counter alone", async () => {
    storedDoc = { plan: "lite", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "month", ...USAGE };
    live = [subC()];
    await validateUserSubscription(UID);
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("a downgrade leaves every usage counter alone", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year", ...USAGE };
    live = [sub({ id: A, status: "canceled" })];
    await validateUserSubscription(UID);
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("ambiguity leaves every usage counter alone", async () => {
    storedDoc = { plan: "full", stripeCustomerId: MINE, stripeSubscriptionId: A, subscriptionStatus: "active", billingInterval: "year", ...USAGE };
    live = [subB(), subC()];
    await validateUserSubscription(UID);
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });
});
