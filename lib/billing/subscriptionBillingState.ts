/**
 * Billing incident BILLING-ANNUAL, Phase WEBHOOK-B1 — the ONE canonical
 * derivation of billing state from a Stripe subscription: which item carries
 * the plan, what cadence it bills at, and what the CURRENT billing period
 * actually is.
 *
 * Three separate synchronization paths (the Stripe webhook, the admin sync,
 * and the request-time reconciliation) each used to derive these values for
 * themselves, and they disagreed. Two of those disagreements caused real,
 * proven defects:
 *
 *   1. PERIOD SOURCE. In Stripe's `flexible` billing mode the authoritative
 *      period lives on the SUBSCRIPTION ITEM. The subscription-level
 *      `current_period_start` can lag behind after an interval change: the
 *      incident subscription simultaneously reported an item period of
 *      2026-08-02 → 2027-08-02 (correct, the annual term the customer paid
 *      for) and a subscription-level start of 2026-09-02 (stale, a remnant of
 *      the defective monthly cadence). Persisting the subscription-level
 *      value records an annual term that starts a month late.
 *
 *   2. ITEM SELECTION. Every path read `items.data[0]` unconditionally. That
 *      is correct for the one-plan-item subscriptions this product creates,
 *      but it is an assumption, not an invariant — and on a malformed or
 *      transitional multi-item subscription it silently resolves whichever
 *      item happens to sort first. This module fails closed instead.
 *
 * Deliberately does NOT decide the plan (that stays in
 * `mapSubscriptionToPlan()`, which owns price-map precedence and the legacy
 * metadata fallback) and does NOT decide entitlement (that stays in
 * `calculateEffectiveEntitlement()`). It answers only "which item, what
 * cadence, which period", and never throws.
 */

import type Stripe from "stripe";
import type { BillingInterval } from "@/lib/plans";
import { getPlanIdFromPriceId } from "./planConfig";

export type BillingStateFailureReason =
  | "no_items"
  | "ambiguous_plan_items"
  | "malformed_item"
  | "unsupported_interval";

export interface SubscriptionBillingState {
  /** The single plan-bearing subscription item. */
  itemId: string;
  priceId: string;
  quantity: number;
  billingInterval: BillingInterval;
  /** Canonical period, item-level first. `null` when Stripe reports neither. */
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Which object the period came from — recorded so tests can pin the precedence. */
  periodSource: "item" | "subscription" | "none";
}

export type SubscriptionBillingStateResult =
  | { ok: true; state: SubscriptionBillingState }
  | { ok: false; reason: BillingStateFailureReason };

type AnyItem = Stripe.SubscriptionItem & {
  current_period_start?: number | null;
  current_period_end?: number | null;
};

/**
 * Pure. Selects the one item that carries the plan.
 *
 * Precedence:
 *   1. Items whose Price is in the CURRENT checkout price map. If more than
 *      one such item exists and they do not all map to the same internal
 *      plan, the subscription is ambiguous and this fails closed rather than
 *      picking a winner — never silently granting the higher plan.
 *   2. No mapped item (e.g. a retired Price, which the legacy metadata
 *      fallback in `mapSubscriptionToPlan()` handles): accept a SINGLE item,
 *      because there is then no ambiguity about which one bills. Two or more
 *      unmapped items cannot be told apart, so that fails closed too.
 */
export function selectPlanBearingItem(subscription: Pick<Stripe.Subscription, "items">): { ok: true; item: AnyItem } | { ok: false; reason: BillingStateFailureReason } {
  const items = (subscription.items?.data ?? []) as AnyItem[];
  if (items.length === 0) return { ok: false, reason: "no_items" };

  const mapped = items.filter((i) => i?.price?.id && getPlanIdFromPriceId(i.price.id));
  if (mapped.length > 0) {
    const distinctPlans = new Set(mapped.map((i) => getPlanIdFromPriceId(i.price.id)));
    if (distinctPlans.size > 1) return { ok: false, reason: "ambiguous_plan_items" };
    // Phase WEBHOOK-B1-C1: candidates that agree on the PLAN can still
    // disagree on cadence, price identity or period. Returning `mapped[0]`
    // then let array order decide the persisted interval and billing period —
    // the exact arbitrariness this selector exists to remove, and a mutation
    // swapping the index survived the previous suite. Equivalence is now
    // explicit: every billing-relevant field must match, or fail closed.
    if (mapped.length > 1 && !allBillingRelevantFieldsEqual(mapped)) {
      return { ok: false, reason: "ambiguous_plan_items" };
    }
    return { ok: true, item: mapped[0] };
  }

  if (items.length > 1) return { ok: false, reason: "ambiguous_plan_items" };
  const only = items[0];
  if (!only?.price?.id) return { ok: false, reason: "malformed_item" };
  return { ok: true, item: only };
}

/**
 * Pure. `true` only when every field ConvergePanel derives billing state from
 * is identical across all candidates, so which one is returned cannot change
 * any persisted value. Price id is included deliberately: two different
 * Prices can share a cadence and period and still differ in amount.
 */
function allBillingRelevantFieldsEqual(items: AnyItem[]): boolean {
  const key = (i: AnyItem) =>
    [
      i.price?.id,
      i.price?.recurring?.interval,
      i.price?.recurring?.interval_count,
      i.current_period_start ?? null,
      i.current_period_end ?? null,
      typeof i.quantity === "number" ? i.quantity : 1,
    ].join("|");
  const first = key(items[0]);
  return items.every((i) => key(i) === first);
}

function toDate(seconds: number | null | undefined): Date | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/**
 * Pure, zero I/O. Never throws — a malformed subscription yields
 * `{ok:false, reason}` and callers persist nothing derived from it.
 *
 * PERIOD PRECEDENCE (frozen — this is the incident fix): the plan-bearing
 * ITEM's `current_period_start`/`current_period_end` win whenever present.
 * The subscription-level fields are consulted only as a fallback for
 * subscriptions that do not expose item-level periods, and `periodSource`
 * records which was used.
 */
export function resolveSubscriptionBillingState(
  subscription: Pick<Stripe.Subscription, "items"> & { current_period_start?: number | null; current_period_end?: number | null }
): SubscriptionBillingStateResult {
  const selected = selectPlanBearingItem(subscription);
  if (!selected.ok) return { ok: false, reason: selected.reason };

  const item = selected.item;
  const recurring = item.price?.recurring;
  const interval = recurring?.interval;
  if (interval !== "month" && interval !== "year") {
    return { ok: false, reason: "unsupported_interval" };
  }

  const itemStart = toDate(item.current_period_start);
  const itemEnd = toDate(item.current_period_end);
  const subStart = toDate(subscription.current_period_start);
  const subEnd = toDate(subscription.current_period_end);

  const usingItemPeriod = itemStart !== null || itemEnd !== null;
  const periodStart = usingItemPeriod ? itemStart : subStart;
  const periodEnd = usingItemPeriod ? itemEnd : subEnd;
  const periodSource: SubscriptionBillingState["periodSource"] = usingItemPeriod
    ? "item"
    : periodStart || periodEnd
      ? "subscription"
      : "none";

  return {
    ok: true,
    state: {
      itemId: item.id,
      priceId: item.price.id,
      quantity: typeof item.quantity === "number" ? item.quantity : 1,
      billingInterval: interval,
      periodStart,
      periodEnd,
      periodSource,
    },
  };
}
