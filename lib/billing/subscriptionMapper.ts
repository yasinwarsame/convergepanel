/**
 * Subscription to Plan Mapper
 * 
 * Maps Stripe subscription objects to internal plan configurations.
 * Handles both price ID matching and metadata-based plan detection.
 * 
 * This is the single source of truth for subscription → plan mapping logic.
 * Used by the webhook handler to determine which plan a subscription corresponds to.
 */

import { BillingPlanId, PLAN_CONFIG, getPlanConfigById, getPlanIdFromPriceId } from "./planConfig";
import { readLegacyPlanMetadata } from "./legacyPlanMetadata";
import { isPlanBearingSubscriptionStatus } from "./subscriptionStatus";
import Stripe from "stripe";

export interface SubscriptionPlanMapping {
  planId: BillingPlanId;
  monthlyLimit: number;
  maxModelsPerRun: number;
  isActive: boolean;
}

/**
 * Map Stripe subscription to internal plan
 * 
 * Determines the plan based on:
 * 1. Subscription status (must be "active" or "trialing" for paid plans)
 * 2. Price ID matching (primary method)
 * 3. Validated, server-originated metadata.targetPlan (legacy fallback for
 *    subscriptions whose Price has since been retired from the checkout map)
 * 
 * @param subscription - Stripe subscription object
 * @returns Plan mapping with plan ID, limits, and active status
 */
export function mapSubscriptionToPlan(
  subscription: Stripe.Subscription
): SubscriptionPlanMapping {
  const status = subscription.status;
  const priceId = subscription.items.data[0]?.price.id;

  // Canonical status contract — see lib/billing/subscriptionStatus.ts. This
  // is the plan-bearing set (which still includes "past_due"), deliberately
  // wider than the entitlement-bearing set used by the run-quota gate.
  const isActiveStatus = isPlanBearingSubscriptionStatus(status);
  
  if (!isActiveStatus) {
    const freeConfig = PLAN_CONFIG.free;
    return {
      planId: "free",
      monthlyLimit: freeConfig.monthlyLimit,
      maxModelsPerRun: freeConfig.maxModels,
      isActive: false,
    };
  }

  // Method 1: Try to map by price ID (most reliable)
  if (priceId) {
    const planIdFromPrice = getPlanIdFromPriceId(priceId);
    if (planIdFromPrice) {
      const config = getPlanConfigById(planIdFromPrice);
      return {
        planId: planIdFromPrice,
        monthlyLimit: config.monthlyLimit,
        maxModelsPerRun: config.maxModels,
        isActive: true,
      };
    }
  }

  // Method 2: legacy fallback — a subscription whose Price is no longer in
  // the CURRENT checkout price map (a retired Price, e.g. the defective
  // monthly-cadence "Full Annual" Price this incident retired) is still a
  // genuinely paying subscription. `readLegacyPlanMetadata()` accepts only
  // the exact server-written "lite"/"full" markers and fails closed on
  // everything else; it is reached ONLY when the Price above matched
  // nothing, so it can never override a recognized current Price.
  const legacyPlan = readLegacyPlanMetadata(subscription);
  if (legacyPlan) {
    const legacyConfig = PLAN_CONFIG[legacyPlan];
    return {
      planId: legacyPlan,
      monthlyLimit: legacyConfig.monthlyLimit,
      maxModelsPerRun: legacyConfig.maxModels,
      isActive: true,
    };
  }

  // Default to free plan if no match found
  const freeConfig = PLAN_CONFIG.free;
  return {
    planId: "free",
    monthlyLimit: freeConfig.monthlyLimit,
    maxModelsPerRun: freeConfig.maxModels,
    isActive: false,
  };
}

/**
 * Get current month string in "YYYY-MM" format
 */
export function getCurrentMonthString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
