/**
 * Billing entitlement field consistency.
 *
 * DEFECT: the entitlement resolver (`calculateEffectiveEntitlement`) reads
 * `subscriptionStatusFromStripe` and `planFromStripe` BEFORE
 * `subscriptionStatus` / `plan`, but only the admin "Sync from Stripe" wrote
 * them. Every automatic writer (webhook, /api/billing/sync-plan, request-time
 * reconciliation, subscription deletion) goes through
 * `updateUserPlanInFirestore()`, which wrote only `subscriptionStatus` / `plan`.
 * Once an admin had synced a customer, those stale admin-written fields shadowed
 * every later automatic write: a past_due or canceled subscription kept paid
 * access, and a downgrade kept the higher plan.
 *
 * These tests drive the REAL shared writer and the REAL resolver together: a
 * stored document (carrying stale admin-sync values) is merged with the exact
 * payload the writer sends to Firestore (`set(..., { merge: true })`), and the
 * merged document is resolved.
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

const DELETE = { __sentinel: "DELETE" };
const setMock = jest.fn(async (..._a: unknown[]) => undefined);
const updateMock = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => ({ set: (...a: unknown[]) => setMock(...a), update: (...a: unknown[]) => updateMock(...a) }) }) },
  firebaseAdmin: { firestore: { Timestamp: { now: () => "TS_NOW", fromDate: (d: Date) => `TS_${d.toISOString()}` }, FieldValue: { delete: () => DELETE } } },
}));

import type Stripe from "stripe";
import { mapSubscriptionToPlan, type SubscriptionPlanMapping } from "@/lib/billing/subscriptionMapper";
import { PLAN_CONFIG } from "@/lib/billing/planConfig";
import { calculateEffectiveEntitlement } from "@/lib/admin/entitlements";
import { updateUserPlanInFirestore } from "../webhookHelpers";

type Doc = Record<string, unknown>;

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 30 * 86_400_000).toISOString();

/** A customer an admin previously synced while active on Full: the stale shadowing fields. */
function adminSyncedFullDoc(extra: Doc = {}): Doc {
  return {
    stripeCustomerId: "cus_test",
    stripeSubscriptionId: "sub_test",
    plan: "full",
    subscriptionStatus: "active",
    subscriptionStatusFromStripe: "active",
    planFromStripe: "5_models",
    monthlyLimit: 150,
    maxModelsPerRun: 5,
    runsThisMonth: 37,
    usageMonth: "2026-11",
    videoRunsThisMonth: 2,
    ...extra,
  };
}

function sub(args: { status: string; priceId: string; interval?: "month" | "year"; metadata?: Record<string, string> }): Stripe.Subscription {
  return {
    id: "sub_test",
    customer: "cus_test",
    status: args.status,
    metadata: args.metadata ?? {},
    items: { data: [{ id: "si_test", price: { id: args.priceId, recurring: { interval: args.interval ?? "month" } } }] },
  } as unknown as Stripe.Subscription;
}

/** Firestore `set(data, { merge: true })` semantics for the flat fields used here. */
function merge(stored: Doc, written: Doc): Doc {
  const out: Doc = { ...stored };
  for (const [k, v] of Object.entries(written)) {
    if (v === DELETE) delete out[k];
    else out[k] = v;
  }
  return out;
}

async function write(planMapping: SubscriptionPlanMapping, status: string, interval: "month" | "year" | undefined = "month"): Promise<Doc> {
  setMock.mockClear();
  await updateUserPlanInFirestore({ uid: "uid1", customerId: "cus_test", subscriptionId: "sub_test", planMapping, status, billingInterval: interval });
  expect(setMock).toHaveBeenCalledTimes(1);
  expect(setMock.mock.calls[0][1]).toEqual({ merge: true });
  return setMock.mock.calls[0][0] as Doc;
}

/** The webhook / reconciliation path: map the authoritative subscription, then persist (route.ts reconcileAuthoritativeSubscription). */
async function syncSubscription(stored: Doc, s: Stripe.Subscription): Promise<{ written: Doc; doc: Doc }> {
  const interval = s.items.data[0]?.price.recurring?.interval === "year" ? "year" : "month";
  const written = await write(mapSubscriptionToPlan(s), s.status, interval);
  return { written, doc: merge(stored, written) };
}

/** The deletion and no_entitlement paths: a literal free mapping persisted as "canceled" (route.ts handleSubscriptionDeleted / no_entitlement). */
const FREE_MAPPING: SubscriptionPlanMapping = { planId: "free", monthlyLimit: PLAN_CONFIG.free.monthlyLimit, maxModelsPerRun: PLAN_CONFIG.free.maxModels, isActive: false };

beforeEach(() => {
  setMock.mockClear();
  updateMock.mockClear();
});

describe("write shape: the shared writer persists the resolver's authority fields", () => {
  it.each([
    ["full", "price_full_m", "5_models"],
    ["lite", "price_lite_m", "3_models"],
  ])("%s plan (price %s) → planFromStripe %s, statusFromStripe = status", async (_label, priceId, expected) => {
    const { written } = await syncSubscription({}, sub({ status: "active", priceId }));
    expect(written.subscriptionStatusFromStripe).toBe("active");
    expect(written.planFromStripe).toBe(expected);
    expect(written.subscriptionStatus).toBe("active");
  });

  it("free mapping → planFromStripe null (never the string 'free')", async () => {
    const written = await write(FREE_MAPPING, "canceled");
    expect(written).toHaveProperty("planFromStripe", null);
    expect(written.subscriptionStatusFromStripe).toBe("canceled");
    expect(written.plan).toBe("free");
  });

  it("never writes usage, quota-rollover, override or entitlement-cache fields", async () => {
    const { written } = await syncSubscription({}, sub({ status: "active", priceId: "price_full_m" }));
    for (const k of ["runsThisMonth", "usageMonth", "videoRunsThisMonth", "override", "entitlements"]) expect(written).not.toHaveProperty(k);
  });
});

describe("stale admin-synced authority no longer shadows automatic reconciliation", () => {
  it("CONTROL: the stale document alone resolves to paid Full (the defect's precondition)", () => {
    expect(calculateEffectiveEntitlement(adminSyncedFullDoc() as never)).toMatchObject({ plan: "5_models", source: "stripe" });
  });

  it("REGRESSION: stale active → past_due loses paid access", async () => {
    const { doc } = await syncSubscription(adminSyncedFullDoc(), sub({ status: "past_due", priceId: "price_full_m" }));
    expect(doc.subscriptionStatusFromStripe).toBe("past_due");
    expect(calculateEffectiveEntitlement(doc as never)).toMatchObject({ plan: "free", source: "free" });
  });

  it("REGRESSION: stale active → past_due on an unrecognized legacy price with targetPlan also loses paid access", async () => {
    const { doc } = await syncSubscription(adminSyncedFullDoc(), sub({ status: "past_due", priceId: "price_legacy_2usd", metadata: { targetPlan: "full" } }));
    expect(calculateEffectiveEntitlement(doc as never)).toMatchObject({ plan: "free", source: "free" });
  });

  it("REGRESSION: stale active → canceled (deletion path) loses paid access", async () => {
    const doc = merge(adminSyncedFullDoc(), await write(FREE_MAPPING, "canceled"));
    expect(doc.planFromStripe).toBeNull();
    expect(doc).not.toHaveProperty("stripeSubscriptionId");
    expect(calculateEffectiveEntitlement(doc as never)).toMatchObject({ plan: "free", source: "free" });
  });

  it("REGRESSION: stale active → unpaid loses paid access", async () => {
    const { doc } = await syncSubscription(adminSyncedFullDoc(), sub({ status: "unpaid", priceId: "price_full_m" }));
    expect(doc.subscriptionStatusFromStripe).toBe("unpaid");
    expect(calculateEffectiveEntitlement(doc as never)).toMatchObject({ plan: "free", source: "free" });
  });

  it("REGRESSION: active downgrade Full → Lite resolves to the current 3-model plan, not the stale 5-model plan", async () => {
    const { doc } = await syncSubscription(adminSyncedFullDoc(), sub({ status: "active", priceId: "price_lite_m" }));
    expect(doc.planFromStripe).toBe("3_models");
    expect(calculateEffectiveEntitlement(doc as never)).toMatchObject({ plan: "3_models", source: "stripe", maxModelsPerRun: 3 });
  });
});

describe("paid access that should remain", () => {
  it.each(["active", "trialing"])("%s annual Full subscription keeps 5-model access", async (status) => {
    const { doc } = await syncSubscription(adminSyncedFullDoc({ subscriptionStatusFromStripe: "past_due" }), sub({ status, priceId: "price_full_y", interval: "year" }));
    expect(doc.billingInterval).toBe("year");
    expect(calculateEffectiveEntitlement(doc as never)).toMatchObject({ plan: "5_models", source: "stripe", maxModelsPerRun: 5 });
  });

  it.each([
    ["full", "5_models"],
    ["lite", "3_models"],
  ])("active legacy subscription (unrecognized price) with targetPlan=%s keeps %s", async (targetPlan, expected) => {
    const { doc } = await syncSubscription({ subscriptionStatusFromStripe: "canceled", planFromStripe: null }, sub({ status: "active", priceId: "price_legacy_2usd", metadata: { targetPlan } }));
    expect(doc.planFromStripe).toBe(expected);
    expect(calculateEffectiveEntitlement(doc as never)).toMatchObject({ plan: expected, source: "stripe" });
  });
});

describe("admin override precedence is unchanged", () => {
  const override = (expiresAt: string) => ({ override: { active: true, plan: "5_models", runLimitMonthly: 150, expiresAt } });

  it("an unexpired override keeps priority over a past_due reconciliation, and the override is not written", async () => {
    const { written, doc } = await syncSubscription(adminSyncedFullDoc(override(FUTURE)), sub({ status: "past_due", priceId: "price_full_m" }));
    expect(written).not.toHaveProperty("override");
    expect(doc.override).toEqual(override(FUTURE).override);
    expect(calculateEffectiveEntitlement(doc as never)).toMatchObject({ plan: "5_models", source: "override" });
  });

  it("after the override expires, the current Stripe-derived fields decide (past_due → free)", async () => {
    const { doc } = await syncSubscription(adminSyncedFullDoc(override(PAST)), sub({ status: "past_due", priceId: "price_full_m" }));
    expect(calculateEffectiveEntitlement(doc as never)).toMatchObject({ plan: "free", source: "free" });
  });

  it("after the override expires, the current Stripe-derived fields decide (active Lite → 3_models, not the stale 5_models)", async () => {
    const { doc } = await syncSubscription(adminSyncedFullDoc(override(PAST)), sub({ status: "active", priceId: "price_lite_m" }));
    expect(calculateEffectiveEntitlement(doc as never)).toMatchObject({ plan: "3_models", source: "stripe" });
  });
});

describe("idempotency", () => {
  it("repeated reconciliation of the same subscription produces the same document and never resets usage", async () => {
    const stored = adminSyncedFullDoc({ subscriptionStatusFromStripe: "past_due" });
    const s = sub({ status: "active", priceId: "price_full_m" });
    const first = await syncSubscription(stored, s);
    const second = await syncSubscription(first.doc, s);
    expect(second.written).toEqual(first.written);
    expect(second.doc).toEqual(first.doc);
    for (const k of ["runsThisMonth", "usageMonth", "videoRunsThisMonth"]) expect(second.doc[k]).toBe(stored[k]);
    expect(calculateEffectiveEntitlement(second.doc as never)).toMatchObject({ plan: "5_models", source: "stripe" });
  });
});
