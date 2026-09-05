/**
 * Billing incident BILLING-ANNUAL, Phase WEBHOOK-B1-C1 — the ONE rule for
 * "may this Stripe event write to this user's billing state?".
 *
 * Webhook delivery is not ordered. Stripe can deliver an event describing
 * OLDER state after newer state has already been persisted, and it can
 * deliver events for a subscription the user has long since replaced. The
 * exact-head review of PR #145 proved three failures caused by handlers that
 * trusted `event.data.object` and never compared subscription identity:
 *
 *   - a delayed `customer.subscription.deleted` for a former subscription A
 *     downgraded a paying customer whose current subscription is B, and
 *     cleared B's reference;
 *   - a replayed older `customer.subscription.updated` regressed the plan and
 *     the billing interval;
 *   - an `updated` arriving after a valid `deleted` resurrected a canceled
 *     paid plan.
 *
 * The contract is deliberately NOT "de-duplicate events" — duplicates already
 * converge, and a ledger would not have prevented any of the above. It is:
 *
 *   A Stripe delivery is a signal to reconcile the user's CURRENT
 *   authoritative subscription; it is never permission for an arbitrary
 *   snapshot to overwrite newer application state.
 *
 * Two independent guards implement it:
 *
 *   1. IDENTITY (this module). An event about subscription A may only write
 *      when A is the subscription currently authoritative for that user, or
 *      when the user has none, or when A may legitimately REPLACE the stored
 *      one — and replacement requires proof that the stored subscription is
 *      no longer entitlement-bearing, never merely that a newer event showed
 *      up.
 *
 *   2. FRESHNESS (the caller). Having established identity, the caller
 *      re-reads the subscription from Stripe and persists THAT, so a stale
 *      snapshot cannot regress state even when it passes the identity check.
 *      `invoice.payment_succeeded` already worked this way; the subscription
 *      handlers now do too.
 */

import "server-only";
import { isEntitlementBearingSubscriptionStatus } from "./subscriptionStatus";

export type SubscriptionAuthorityDecision =
  /** The event's subscription is the user's current one, or the user has none. Proceed. */
  | { allowed: true; reason: "current_subscription" | "no_stored_subscription" | "legitimate_replacement" }
  /** The event concerns a subscription that is not authoritative for this user. Persist nothing. */
  | { allowed: false; reason: "stale_historical_subscription" | "stored_subscription_still_active" };

export interface SubscriptionAuthorityInput {
  /** Subscription id the incoming event is about. */
  eventSubscriptionId: string;
  /** Subscription id currently stored on the user document, if any. */
  storedSubscriptionId: string | null | undefined;
  /**
   * Status of the STORED subscription, read back from Stripe by the caller.
   * `null` means the stored subscription could not be retrieved (deleted at
   * Stripe, or a read failure). Only consulted when the ids differ.
   */
  storedSubscriptionStatus?: string | null;
  /** Status of the incoming event's subscription, from authoritative Stripe state. */
  incomingSubscriptionStatus?: string | null;
}

/**
 * Pure, zero I/O.
 *
 * REPLACEMENT RULE (derived from this product's actual flows, not invented):
 * checkout always creates a subscription for a user who may still carry a
 * cancelled one on their document, and the in-place upgrade path reuses the
 * SAME subscription id rather than creating a new one. So the only legitimate
 * `A -> B` transition is one where the stored subscription has stopped being
 * entitlement-bearing and the incoming one is. Both halves are required:
 *
 *   - if the stored subscription is still entitlement-bearing, an event for a
 *     different subscription is historical noise and must not write. This is
 *     what protects a paying customer on B from a delayed deletion of A.
 *   - if the incoming subscription is NOT entitlement-bearing, there is
 *     nothing to adopt; writing would let a stale cancellation of an
 *     abandoned subscription clear a user who has no live subscription
 *     stored either. Fail closed and leave the document alone.
 */
export function decideSubscriptionAuthority(input: SubscriptionAuthorityInput): SubscriptionAuthorityDecision {
  const stored = input.storedSubscriptionId;
  if (!stored) return { allowed: true, reason: "no_stored_subscription" };
  if (stored === input.eventSubscriptionId) return { allowed: true, reason: "current_subscription" };

  // Ids differ: the event is about some other subscription.
  if (isEntitlementBearingSubscriptionStatus(input.storedSubscriptionStatus)) {
    return { allowed: false, reason: "stored_subscription_still_active" };
  }
  if (!isEntitlementBearingSubscriptionStatus(input.incomingSubscriptionStatus)) {
    return { allowed: false, reason: "stale_historical_subscription" };
  }
  return { allowed: true, reason: "legitimate_replacement" };
}

/**
 * Pure, zero I/O. The deletion rule, deliberately stricter than the general
 * one above: a cancellation may only ever clear the subscription it is
 * actually about.
 *
 * There is no replacement branch. A deletion never grants authority — it can
 * only take it away — so an incoming `deleted` for a subscription OTHER than
 * the stored one is always ignored, whatever the stored one's status. That is
 * the guard that protects a paying customer on subscription B from a delayed
 * cancellation of a former subscription A.
 *
 * When the user has NO stored subscription the downgrade is allowed. There is
 * no current subscription to protect, so blocking here would fail OPEN in the
 * more dangerous direction: a document left with a paid `plan` but no
 * subscription reference (drift, or a cleared reference) would keep that paid
 * plan forever because no cancellation could ever apply to it. Allowing it
 * also preserves the pre-existing cancellation behaviour for every ordinary
 * customer, whose reference is written at checkout.
 */
export function mayDeletionDowngrade(args: { deletedSubscriptionId: string; storedSubscriptionId: string | null | undefined }): boolean {
  if (!args.storedSubscriptionId) return true;
  return args.storedSubscriptionId === args.deletedSubscriptionId;
}
