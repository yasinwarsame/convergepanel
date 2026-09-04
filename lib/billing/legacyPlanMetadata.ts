/**
 * Billing incident BILLING-ANNUAL (Sept 2026), Phase MIG-B1 — the ONE
 * canonical, tightly validated reader for the server-originated
 * `targetPlan` marker carried in Stripe subscription metadata.
 *
 * Why this exists: `STRIPE_PRICE_TO_PLAN` (lib/billing/planConfig.ts) is
 * built exclusively from the CURRENT checkout price environment variables.
 * When a Price is retired — as the defective monthly-cadence "Full Annual"
 * Price was — every historical subscription still carrying it stops
 * resolving to any plan, and a plan resolver that only consults the price
 * map would silently classify a genuinely paying customer as free.
 *
 * Provenance (audited, Phase MIG-B1): `targetPlan` is written in exactly
 * three places, all inside `app/api/billing/create-checkout-session/route.ts`
 * (the in-place upgrade `subscriptions.update`, the Checkout Session's own
 * metadata, and `subscription_data.metadata`), and in every one of them the
 * value is the server-validated `planId` literal — the route rejects any
 * body whose `planId` is not exactly "lite" or "full" before Stripe is
 * touched at all. A client can therefore choose BETWEEN the two paid plans
 * (which it may do anyway, by picking a plan) but can never inject an
 * arbitrary string, a price id, or an amount. No other route, webhook
 * branch, or admin path writes this key.
 *
 * This module deliberately does NOT decide entitlement. It answers one
 * narrow question — "does this subscription carry a valid, server-written
 * plan marker?" — and fails closed on anything else. Status policy lives in
 * `lib/billing/subscriptionStatus.ts`; price-map precedence lives in
 * `mapSubscriptionToPlan()`, which always prefers a recognized current
 * Price and only reaches this fallback when the Price is unmapped.
 */

import type Stripe from "stripe";
import type { BillingPlanId } from "./planConfig";

/** The only values a legacy metadata marker may ever resolve to. `"free"` is deliberately excluded: a paid-plan marker is the only thing this fallback can assert, and "free" is the fail-closed outcome rather than something metadata grants. */
export type LegacyPaidPlanId = Extract<BillingPlanId, "lite" | "full">;

const VALID_LEGACY_PLANS: ReadonlySet<string> = new Set<LegacyPaidPlanId>(["lite", "full"]);

/**
 * Pure, zero I/O. Returns the validated paid plan a subscription's
 * server-written `targetPlan` marker names, or `null` for every other case:
 * missing metadata, a missing/blank key, a non-string value, an unknown
 * string ("enterprise", "FULL", " full "), or the literal "free".
 *
 * Never trims, lowercases, or otherwise repairs the value — an exact match
 * against the enum is required, so a mutated or hand-edited marker fails
 * closed instead of being coerced into a paid grant.
 */
export function readLegacyPlanMetadata(subscription: Pick<Stripe.Subscription, "metadata">): LegacyPaidPlanId | null {
  const raw = subscription.metadata?.targetPlan;
  if (typeof raw !== "string") return null;
  if (!VALID_LEGACY_PLANS.has(raw)) return null;
  return raw as LegacyPaidPlanId;
}
