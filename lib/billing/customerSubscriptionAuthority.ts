/**
 * Billing incident BILLING-ANNUAL, Phase WEBHOOK-B1-C3 — subscription
 * authority resolved from the CUSTOMER'S authoritative Stripe state, never
 * from whichever webhook happened to arrive first.
 *
 * The exact-head review of e642ef09 proved the last order-dependence by
 * execution. Authority was decided pairwise — the stored subscription id
 * against the one id an event named — so with a dead stored subscription and
 * two live entitlement-bearing subscriptions B and C:
 *
 *     B delivered first  -> customer becomes B's plan and cadence
 *     C delivered first  -> customer becomes C's plan and cadence
 *
 * Identical Stripe state, opposite billing outcomes, and permanent: whichever
 * won became the stored subscription and then blocked the other as "stored
 * subscription still active". A PR whose whole purpose is to remove
 * delivery-order dependence cannot leave its own authority selection
 * order-dependent.
 *
 * The fix is to stop asking "does this event outrank what we stored?" and ask
 * "what does this customer's subscription set actually say?" — a question with
 * the same answer whatever order the events arrive in.
 *
 * ON MULTIPLE CANDIDATES. ConvergePanel's product contract is one subscription
 * per customer, and the repository has NO documented rule for choosing between
 * two concurrent entitlement-bearing subscriptions. What it has is a set of
 * incidental heuristics that disagree with each other: two paths sort by
 * `created` and take the newest, three others take `data[0]`. Inventing a
 * ranking during incident remediation would be picking one of those by
 * accident and calling it policy. So more than one candidate is reported as an
 * explicit unsupported state and the caller changes nothing — a state that
 * should not exist is surfaced, not silently resolved.
 */

import "server-only";
import type Stripe from "stripe";
import { logger } from "@/lib/logger";
import { isPlanBearingSubscriptionStatus } from "./subscriptionStatus";
import { stripeLookup } from "./reconciliationOutcome";

export type CustomerSubscriptionAuthority =
  /** The customer's set proves there is no entitlement-bearing subscription. */
  | { kind: "no_entitlement" }
  /** Exactly one supported entitlement-bearing subscription. Reconcile THIS one. */
  | { kind: "exactly_one"; subscription: Stripe.Subscription }
  /** More than one. Unsupported under the one-subscription contract; caller must not choose. */
  | { kind: "multiple_entitlements"; count: number; subscriptionIds: string[] }
  /** The set could not be established because the customer identity is not trusted. */
  | { kind: "unverified_customer" }
  /** Stripe says the customer itself no longer exists. An absent remote lookup is NOT positive authority to strip entitlement. */
  | { kind: "customer_missing" };

/**
 * Enumerates the customer's subscriptions and classifies the result. Never
 * throws for a domain outcome; a transient Stripe failure propagates as a
 * `TransientDependencyError` so the delivery is retried rather than decided
 * on incomplete information.
 *
 * `customerId` MUST already be a verified identity — see the callers. This
 * function will not enumerate a customer that the caller has not established
 * belongs to the user, because doing so would let an event's own claim about
 * its customer drive a decision about someone else's record.
 *
 * Pagination is followed to exhaustion. A truncated first page is not proof of
 * absence, and this module's entire purpose is to answer from the complete
 * set.
 */
export async function resolveCustomerSubscriptionAuthority(args: {
  stripe: Stripe;
  verifiedCustomerId: string | null;
  /**
   * A subscription to leave out of the candidate set — the deletion target.
   * Stripe's list can still report a just-deleted subscription, and letting it
   * count as its own replacement would suppress the downgrade forever.
   */
  excludeSubscriptionId?: string | null;
}): Promise<CustomerSubscriptionAuthority> {
  if (!args.verifiedCustomerId) return { kind: "unverified_customer" };

  const entitled: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;

  // Bounded loop: Stripe caps `limit` at 100, and a customer with more than
  // 1,000 subscriptions is already far outside any supported shape.
  for (let page = 0; page < 10; page++) {
    const result = await stripeLookup("subscriptions.list", () =>
      args.stripe.subscriptions.list({
        customer: args.verifiedCustomerId as string,
        status: "all",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      })
    );
    // A definitively missing customer is reported as its own outcome. It is
    // NOT the same as "this customer has no entitlement": the local binding
    // could be stale or a migration could be in flight, and a destructive
    // downgrade needs positive authority, not an absent lookup.
    if (result.kind === "absent") return { kind: "customer_missing" };

    const page_ = result.value;
    for (const candidate of page_.data) {
      if (args.excludeSubscriptionId && candidate.id === args.excludeSubscriptionId) continue;
      // PLAN-BEARING, not entitlement-bearing. `past_due` is still the
      // customer's subscription under this product's existing contract
      // (lib/stripe/subscriptionValidation.ts, app/api/billing/sync-plan);
      // whether it grants access is decided separately by the effective
      // entitlement resolver, which withholds it. Selecting candidates by
      // entitlement would make a past_due customer look like they had no
      // subscription at all and clear their reference.
      if (isPlanBearingSubscriptionStatus(candidate.status)) entitled.push(candidate);
    }
    if (!page_.has_more || page_.data.length === 0) break;
    startingAfter = page_.data[page_.data.length - 1]?.id;
    if (!startingAfter) break;
  }

  if (entitled.length === 0) return { kind: "no_entitlement" };
  if (entitled.length > 1) {
    // The ids travel with the outcome so the caller can log something an
    // operator can actually act on: this state is terminal, so the log is the
    // only signal that repair is needed.
    return { kind: "multiple_entitlements", count: entitled.length, subscriptionIds: entitled.map((s) => s.id) };
  }
  return { kind: "exactly_one", subscription: entitled[0] };
}

/**
 * The customer-identity rule shared by every webhook path.
 *
 * A stored binding always wins: an event whose customer differs from it is
 * refused, and the stored value is never rewritten from an inbound event.
 *
 * When the user has no stored binding, only a NON-destructive path may adopt
 * the event's customer, and only as the first binding. A deletion may never
 * do so: it can remove authority but must never create identity, which is the
 * hole that let a foreign deletion downgrade a paying customer and write its
 * own customer id onto that user's record.
 */
export function verifyCustomerIdentity(args: {
  storedCustomerId: string | null | undefined;
  eventCustomerId: string | null | undefined;
  /** `true` for `customer.subscription.deleted`, which may never bootstrap. */
  destructive: boolean;
}): { ok: true; verifiedCustomerId: string } | { ok: false; reason: "association_conflict" | "no_verified_customer" } {
  const stored = args.storedCustomerId || null;
  const incoming = args.eventCustomerId || null;

  if (stored && incoming && stored !== incoming) return { ok: false, reason: "association_conflict" };
  if (stored) return { ok: true, verifiedCustomerId: stored };
  if (args.destructive) return { ok: false, reason: "no_verified_customer" };
  if (incoming) return { ok: true, verifiedCustomerId: incoming };
  return { ok: false, reason: "no_verified_customer" };
}

/**
 * Phase WEBHOOK-B1-C6 — the ambiguity record, in ONE place.
 *
 * `multiple_entitlements` is terminal on every path: nothing is written and
 * nothing will retry, so this log is the only signal an operator gets that a
 * customer needs manual repair. It was previously written out by hand at each
 * call site, which is how a third call site (request-time reconciliation)
 * managed to have no record at all while quietly resolving the ambiguity the
 * other two refused. One emitter means the classification, the field set and
 * the "changed nothing" promise cannot drift apart again.
 *
 * Deliberately carries no secret, no raw event payload and no payment detail —
 * only the identifiers needed to find the customer and both subscriptions.
 */
export const MULTIPLE_ENTITLEMENTS_CODE = "multiple_entitlement_subscriptions";

/** Which writer refused. All three automatic writers resolve authority the same way. */
export type AuthorityPath =
  | "webhook_subscription_change"
  | "webhook_subscription_deleted"
  | "request_time_reconciliation"
  | "self_serve_plan_sync";

export function reportMultipleEntitlementSubscriptions(args: {
  path: AuthorityPath;
  eventId?: string;
  eventType?: string;
  stripeCustomerId: string;
  uid: string;
  eventSubscriptionId?: string | null;
  storedSubscriptionId: string | null;
  candidateSubscriptionIds: string[];
  candidateCount: number;
}): void {
  logger.error("[billing] multiple_entitlement_subscriptions", {
    code: MULTIPLE_ENTITLEMENTS_CODE,
    path: args.path,
    eventId: args.eventId,
    eventType: args.eventType,
    stripeCustomerId: args.stripeCustomerId,
    uid: args.uid,
    eventSubscriptionId: args.eventSubscriptionId ?? null,
    storedSubscriptionId: args.storedSubscriptionId,
    candidateSubscriptionIds: args.candidateSubscriptionIds,
    candidateCount: args.candidateCount,
    resolution: "no_mutation_ambiguous_subscription_set",
  });
}
