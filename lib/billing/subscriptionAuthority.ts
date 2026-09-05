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
 * Phase WEBHOOK-B1-C5: the general pairwise decision this module used to
 * export was superseded by `customerSubscriptionAuthority.ts`, which resolves
 * authority from the customer's whole subscription set rather than comparing
 * the stored id against one incoming id. That pairwise rule was removed here
 * once it had no callers; what remains is the deletion rule, which is a
 * different question — not "who is authoritative" but "may THIS cancellation
 * clear THIS reference".
 */

import "server-only";

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
