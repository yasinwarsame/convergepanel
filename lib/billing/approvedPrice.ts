/**
 * Billing Annual Correction, Phase BILLING-ANNUAL-C1 — the ONE place the
 * checkout route turns a (plan, interval) request into an APPROVED Stripe
 * Price ID. The client never supplies a Price ID, amount, or currency; it
 * supplies a canonical plan key and cadence, and this resolver maps them
 * through the existing configuration (`getStripePriceId()` → env). It adds
 * the invariant configuration alone cannot express: the monthly and annual
 * Price IDs for a plan must be DIFFERENT — a copy/paste env mistake that
 * points both cadences at one Price is refused rather than sold.
 */

import "server-only";
import { getStripePriceId, type BillingInterval, type PlanId } from "@/lib/plans";

export type PaidPlanId = Exclude<PlanId, "free">;

export type ApprovedPriceResolution = { ok: true; priceId: string } | { ok: false; reason: "not_configured" | "interval_collision"; message: string };

export function resolveApprovedPriceId(planId: PaidPlanId, interval: BillingInterval): ApprovedPriceResolution {
  let priceId: string | undefined;
  try {
    priceId = getStripePriceId(planId, interval);
  } catch (err) {
    return { ok: false, reason: "not_configured", message: err instanceof Error ? err.message : `Stripe price ID not configured for ${planId} plan (${interval} billing).` };
  }
  if (!priceId) {
    return { ok: false, reason: "not_configured", message: `Stripe price ID not configured for ${planId} plan (${interval} billing).` };
  }
  const otherInterval: BillingInterval = interval === "year" ? "month" : "year";
  let otherPriceId: string | undefined;
  try {
    otherPriceId = getStripePriceId(planId, otherInterval);
  } catch {
    otherPriceId = undefined;
  }
  if (otherPriceId && otherPriceId === priceId) {
    return { ok: false, reason: "interval_collision", message: `Stripe price configuration for the ${planId} plan uses the same Price for month and year billing.` };
  }
  return { ok: true, priceId };
}
