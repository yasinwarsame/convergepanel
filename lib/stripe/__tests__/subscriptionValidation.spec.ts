/**
 * Phase BILLING-WEBHOOK-B1 — request-time reconciliation
 * (`validateUserSubscription`), the path that runs on ordinary research and
 * claim-verification requests.
 *
 * Before this phase it had three side effects that made it unsafe as a
 * self-healing mechanism: it reset the monthly run counter, it wrote the
 * billing cycle start from `Date.now()`, and it took the period from the
 * subscription-level field, which lags in flexible billing mode.
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

const subscriptionsList = jest.fn();
jest.mock("@/lib/stripe/client", () => ({ stripe: { subscriptions: { list: (...a: unknown[]) => subscriptionsList(...(a as [])) } } }));

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

import type Stripe from "stripe";
import { validateUserSubscription } from "../subscriptionValidation";
import { calculateEffectiveEntitlement } from "@/lib/admin/entitlements";

const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2, 2, 33, 35) / 1000);
const SEP_2_2026 = Math.floor(Date.UTC(2026, 8, 2, 2, 33, 35) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2, 2, 33, 35) / 1000);
const USAGE = { usageMonth: "2026-09", runsThisMonth: 37, videoRunsThisMonth: 4, tokensUsedCurrentPeriod: 120_000, totalRuns: 210 };
const usageOf = (d: Record<string, unknown>) => ({
  usageMonth: d.usageMonth, runsThisMonth: d.runsThisMonth, videoRunsThisMonth: d.videoRunsThisMonth,
  tokensUsedCurrentPeriod: d.tokensUsedCurrentPeriod, totalRuns: d.totalRuns,
});

function subscription(): Stripe.Subscription {
  return {
    id: "sub_incident",
    status: "active",
    created: 1,
    metadata: { targetPlan: "full" },
    current_period_start: SEP_2_2026,
    current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_incident", quantity: 1, price: { id: "price_full_y", recurring: { interval: "year", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Stripe.Subscription;
}

beforeEach(() => {
  writes.length = 0;
  subscriptionsList.mockReset();
  subscriptionsList.mockResolvedValue({ data: [subscription()] });
  // Stale local state: plan right, cadence wrong — the incident customer's shape.
  storedDoc = { plan: "full", stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_incident", subscriptionStatus: "active", billingInterval: "month", ...USAGE };
});

describe("validateUserSubscription — Phase WEBHOOK-B1", () => {
  it("REGRESSION: reconciliation never resets usage counters", async () => {
    await validateUserSubscription("uid1");
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("REGRESSION: corrects a stale monthly interval to year", async () => {
    await validateUserSubscription("uid1");
    expect(storedDoc.billingInterval).toBe("year");
  });

  it("REGRESSION: uses the item-level annual start, never a Date.now()-manufactured one", async () => {
    await validateUserSubscription("uid1");
    expect(storedDoc.billingCycleStart).toBe(`TS_${new Date(AUG_2_2026 * 1000).toISOString()}`);
    expect(storedDoc.billingCycleStart).not.toBe(`TS_${new Date(SEP_2_2026 * 1000).toISOString()}`);
  });

  it("running twice leaves usage and billing state identical", async () => {
    await validateUserSubscription("uid1");
    const first = { ...storedDoc };
    await validateUserSubscription("uid1");
    expect(usageOf(storedDoc)).toEqual(USAGE);
    for (const k of ["plan", "billingInterval", "subscriptionStatus", "billingCycleStart", "currentPeriodEnd"]) {
      expect(storedDoc[k]).toEqual(first[k]);
    }
  });

  it("writes nothing when local state already matches Stripe", async () => {
    // "Matches" includes the resolver's authority fields (billing entitlement
    // field consistency): a document lacking them is reconciled once.
    storedDoc = { ...storedDoc, billingInterval: "year", subscriptionStatusFromStripe: "active", planFromStripe: "5_models" };
    writes.length = 0;
    const before = { ...storedDoc };
    await validateUserSubscription("uid1");
    // Phase C8.1: this test was named for an invariant it never asserted — it
    // checked only the usage counters, so an implementation that rewrote every
    // billing field on every request would have passed it.
    expect(writes).toHaveLength(0);
    expect(storedDoc).toEqual(before);
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("an ambiguous multi-item subscription is not reconciled at all", async () => {
    subscriptionsList.mockResolvedValue({ data: [{
      id: "sub_incident", status: "active", created: 1, metadata: {},
      items: { data: [
        { id: "si_a", quantity: 1, price: { id: "price_lite_m", recurring: { interval: "month", interval_count: 1 } } },
        { id: "si_b", quantity: 1, price: { id: "price_full_y", recurring: { interval: "year", interval_count: 1 } } },
      ] },
    }] });
    const before = { ...storedDoc };
    await validateUserSubscription("uid1");
    expect(storedDoc).toEqual(before);
  });
});

describe("validateUserSubscription — heals documents already shadowed by stale admin-sync authority", () => {
  const withStatus = (status: string, priceId = "price_full_y") => {
    const s = subscription() as unknown as { status: string; items: { data: { price: { id: string } }[] } };
    s.status = status;
    s.items.data[0].price.id = priceId;
    return s as unknown as Stripe.Subscription;
  };

  it("A: plan/status already past_due but stale FromStripe active/5_models → reconciled, paid access removed", async () => {
    subscriptionsList.mockResolvedValue({ data: [withStatus("past_due")] });
    storedDoc = { ...storedDoc, billingInterval: "year", subscriptionStatus: "past_due", subscriptionStatusFromStripe: "active", planFromStripe: "5_models" };
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "5_models" }); // precondition: shadowed
    await validateUserSubscription("uid1");
    expect(writes).toHaveLength(1);
    expect(storedDoc.subscriptionStatusFromStripe).toBe("past_due");
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "free", source: "free" });
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });

  it("B: plan already lite but stale planFromStripe 5_models → reconciled to 3_models", async () => {
    subscriptionsList.mockResolvedValue({ data: [withStatus("active", "price_lite_y")] });
    storedDoc = { ...storedDoc, plan: "lite", billingInterval: "year", subscriptionStatusFromStripe: "active", planFromStripe: "5_models" };
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "5_models" }); // precondition: shadowed
    await validateUserSubscription("uid1");
    expect(storedDoc.planFromStripe).toBe("3_models");
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "3_models", source: "stripe" });
  });

  it("C: plan free (canceled) but stale planFromStripe 5_models is not skipped → authority cleared", async () => {
    subscriptionsList.mockResolvedValue({ data: [withStatus("canceled")] });
    storedDoc = { ...storedDoc, plan: "free", subscriptionStatus: "canceled", subscriptionStatusFromStripe: "active", planFromStripe: "5_models" };
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "5_models" }); // precondition: shadowed
    await validateUserSubscription("uid1");
    expect(subscriptionsList).toHaveBeenCalled();
    expect(storedDoc.planFromStripe).toBeNull();
    expect(storedDoc.subscriptionStatusFromStripe).toBe("canceled");
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "free", source: "free" });
  });

  const STALE_FREE = { plan: "free", subscriptionStatus: "canceled", subscriptionStatusFromStripe: "active", planFromStripe: "5_models" };

  it("free doc with stale paid authority under an ACTIVE override is skipped (no Stripe call, no write)", async () => {
    storedDoc = { ...storedDoc, ...STALE_FREE, override: { active: true, plan: "5_models", runLimitMonthly: 150, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } };
    await validateUserSubscription("uid1");
    expect(subscriptionsList).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("free doc with stale paid authority under an EXPIRED override is reconciled", async () => {
    subscriptionsList.mockResolvedValue({ data: [withStatus("canceled")] });
    storedDoc = { ...storedDoc, ...STALE_FREE, override: { active: true, plan: "5_models", runLimitMonthly: 150, expiresAt: new Date(Date.now() - 86_400_000).toISOString() } };
    await validateUserSubscription("uid1");
    expect(storedDoc.planFromStripe).toBeNull();
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "free", source: "free" });
  });

  it("free doc with stale paid authority but NO customer binding: no Stripe call, no write (documented limit)", async () => {
    const { stripeCustomerId: _drop, ...rest } = { ...storedDoc, ...STALE_FREE };
    storedDoc = rest;
    await validateUserSubscription("uid1");
    expect(subscriptionsList).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("free doc with stale paid authority and a single ACTIVE Stripe subscription is reconciled to the paid plan Stripe reports", async () => {
    storedDoc = { ...storedDoc, ...STALE_FREE, billingInterval: "year" };
    await validateUserSubscription("uid1");
    expect(storedDoc).toMatchObject({ plan: "full", subscriptionStatus: "active", subscriptionStatusFromStripe: "active", planFromStripe: "5_models" });
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "5_models", source: "stripe" });
  });

  it("admin-sync past_due shape (plan free, planFromStripe 3_models, past_due) converges and stays unentitled", async () => {
    subscriptionsList.mockResolvedValue({ data: [withStatus("past_due", "price_lite_y")] });
    storedDoc = { ...storedDoc, plan: "free", subscriptionStatus: "past_due", subscriptionStatusFromStripe: "past_due", planFromStripe: "3_models", billingInterval: "year" };
    await validateUserSubscription("uid1");
    expect(storedDoc).toMatchObject({ plan: "lite", subscriptionStatusFromStripe: "past_due", planFromStripe: "3_models" });
    expect(calculateEffectiveEntitlement(storedDoc as never)).toMatchObject({ plan: "free", source: "free" });
    writes.length = 0;
    await validateUserSubscription("uid1");
    expect(writes).toHaveLength(0);
  });

  it("a plain free document (no paid authority) is still skipped without a Stripe call", async () => {
    storedDoc = { plan: "free", stripeCustomerId: "cus_x", planFromStripe: null, ...USAGE };
    await validateUserSubscription("uid1");
    expect(subscriptionsList).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("a never-admin-synced paid document gains the authority fields once, then is stable", async () => {
    storedDoc = { ...storedDoc, billingInterval: "year" };
    await validateUserSubscription("uid1");
    expect(writes).toHaveLength(1);
    expect(storedDoc).toMatchObject({ subscriptionStatusFromStripe: "active", planFromStripe: "5_models" });
    writes.length = 0;
    await validateUserSubscription("uid1");
    expect(writes).toHaveLength(0);
    expect(usageOf(storedDoc)).toEqual(USAGE);
  });
});
