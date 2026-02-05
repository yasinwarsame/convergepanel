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
 * 3. Metadata targetPlan (fallback for test scenarios)
 * 
 * @param subscription - Stripe subscription object
 * @returns Plan mapping with plan ID, limits, and active status
 */
export function mapSubscriptionToPlan(
  subscription: Stripe.Subscription
): SubscriptionPlanMapping {
  const status = subscription.status;
  const priceId = subscription.items.data[0]?.price.id;
  const metadata = subscription.metadata || {};
  const targetPlan = metadata.targetPlan as string | undefined;

  // If subscription is not active or trialing, return free plan
  const isActiveStatus = status === "active" || status === "trialing" || status === "past_due";
  
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

  // Method 2: Check metadata.targetPlan (fallback for test scenarios)
  if (targetPlan === "full") {
    const fullConfig = PLAN_CONFIG.full;
    return {
      planId: "full",
      monthlyLimit: fullConfig.monthlyLimit,
      maxModelsPerRun: fullConfig.maxModels,
      isActive: true,
    };
  }

  if (targetPlan === "lite") {
    const liteConfig = PLAN_CONFIG.lite;
    return {
      planId: "lite",
      monthlyLimit: liteConfig.monthlyLimit,
      maxModelsPerRun: liteConfig.maxModels,
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
