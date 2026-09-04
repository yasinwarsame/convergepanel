/**
 * Billing incident BILLING-ANNUAL (Sept 2026), Phase MIG-B1 — the ONE
 * canonical statement of which Stripe subscription statuses may carry a
 * paid ConvergePanel entitlement.
 *
 * Two different status contracts existed before this module, and they
 * disagreed in the way that matters for the pending corrective migration:
 *
 *   - `mapSubscriptionToPlan()` (lib/billing/subscriptionMapper.ts) treated
 *     "active", "trialing" and "past_due" as plan-bearing.
 *   - `calculateEffectiveEntitlement()` (lib/admin/entitlements.ts) — the
 *     resolver the run-quota gate actually consults — required exactly
 *     `status === "active"`.
 *
 * The corrective Stripe repair for the legacy annual subscription replaces
 * the item's Price and attaches a compensating trial ending at the original
 * annual anniversary, which puts the subscription into "trialing" for the
 * remainder of the year the customer already paid for. Under the old
 * entitlement predicate that financially correct repair would have dropped a
 * paying Full-plan customer to free limits.
 *
 * DELIBERATE ASYMMETRY (do not "harmonize" these two sets without a product
 * decision): "past_due" remains plan-bearing for the mapper, exactly as
 * before, but is NOT added to the entitlement set. Phase MIG-B1's mandate
 * was to unblock the trial-based migration, not to change what happens when
 * a renewal payment fails — a customer whose payment is failing keeps
 * whatever entitlement policy they had before this change.
 */

import type Stripe from "stripe";

/** Statuses under which a subscription still maps to its paid plan (limits, labels, local `plan` field). Unchanged from the mapper's original set. */
const PLAN_BEARING_STATUSES: ReadonlySet<string> = new Set<Stripe.Subscription.Status>(["active", "trialing", "past_due"]);

/**
 * Statuses that may grant paid ENTITLEMENT (run quota, model cap).
 * Narrower than the plan-bearing set on purpose — see the asymmetry note
 * above. "canceled", "incomplete", "incomplete_expired", "unpaid" and
 * "paused" are excluded here and must never be added merely because a
 * subscription's metadata names a paid plan.
 */
const ENTITLEMENT_STATUSES: ReadonlySet<string> = new Set<Stripe.Subscription.Status>(["active", "trialing"]);

/** Pure. `true` when a subscription in this status should still resolve to its paid plan. */
export function isPlanBearingSubscriptionStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && PLAN_BEARING_STATUSES.has(status);
}

/**
 * Pure. `true` when a subscription in this status may carry paid
 * entitlement. This is the single predicate every paid-entitlement decision
 * must use; no call site may re-derive it with its own string comparison.
 */
export function isEntitlementBearingSubscriptionStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && ENTITLEMENT_STATUSES.has(status);
}
