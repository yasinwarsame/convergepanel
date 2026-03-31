/**
 * Plan Configuration - Single Source of Truth
 * 
 * This is the canonical mapping between Stripe price IDs and internal plan configurations.
 * All billing logic (checkout, webhooks, usage limits) should use this file.
 * 
 * IMPORTANT: If you need to change plan limits or add new plans, update ONLY this file.
 */

import {
  STRIPE_PRICE_3_MODELS,
  STRIPE_3_MODELS_ANNUAL,
  STRIPE_PRICE_5_MODELS,
  STRIPE_5_MODELS_ANNUAL,
} from "@/lib/env";

export type BillingPlanId = "free" | "lite" | "full";

export interface PlanConfig {
  id: BillingPlanId;
  label: string;
  maxModels: number;
  monthlyLimit: number;
  /** Paid-plan video verification quota per calendar month (0 = not available). */
  videoVerificationsPerMonth: number;
}

/**
 * Plan configurations
 * 
 * This is the single source of truth for plan limits and labels.
 * Used by:
 * - Stripe webhook (to update Firestore)
 * - /api/run-panel (to enforce limits)
 * - Frontend badge (to display plan name and limits)
 */
export const PLAN_CONFIG: Record<BillingPlanId, PlanConfig> = {
  free: {
    id: "free",
    label: "Free Plan",
    maxModels: 2,
    monthlyLimit: 8,
    videoVerificationsPerMonth: 0,
  },
  lite: {
    id: "lite",
    label: "3-Model Plan",
    maxModels: 3,
    monthlyLimit: 80,
    videoVerificationsPerMonth: 5,
  },
  full: {
    id: "full",
    label: "Full Panel",
    maxModels: 5,
    monthlyLimit: 150,
    videoVerificationsPerMonth: 20,
  },
};

/**
 * Map Stripe price IDs to internal plan IDs
 * 
 * This mapping is used by the webhook to determine which plan a subscription corresponds to.
 * 
 * IMPORTANT: All price IDs must be defined in environment variables.
 * If a price ID is not found in this map, the webhook will log a warning and skip the update.
 */
export const STRIPE_PRICE_TO_PLAN: Record<string, BillingPlanId> = {};

// Initialize the mapping from environment variables
// Only include price IDs that are actually set (not undefined)
if (STRIPE_PRICE_3_MODELS) {
  STRIPE_PRICE_TO_PLAN[STRIPE_PRICE_3_MODELS] = "lite";
  console.log("[planConfig] Mapped price ID to lite plan:", STRIPE_PRICE_3_MODELS);
}
if (STRIPE_3_MODELS_ANNUAL) {
  STRIPE_PRICE_TO_PLAN[STRIPE_3_MODELS_ANNUAL] = "lite";
  console.log("[planConfig] Mapped annual price ID to lite plan:", STRIPE_3_MODELS_ANNUAL);
}
if (STRIPE_PRICE_5_MODELS) {
  STRIPE_PRICE_TO_PLAN[STRIPE_PRICE_5_MODELS] = "full";
  console.log("[planConfig] Mapped price ID to full plan:", STRIPE_PRICE_5_MODELS);
}
if (STRIPE_5_MODELS_ANNUAL) {
  STRIPE_PRICE_TO_PLAN[STRIPE_5_MODELS_ANNUAL] = "full";
  console.log("[planConfig] Mapped annual price ID to full plan:", STRIPE_5_MODELS_ANNUAL);
}

/**
 * Get plan configuration by plan ID
 * 
 * @param planId - Plan identifier ("free", "lite", or "full")
 * @returns Plan configuration, or free plan as fallback
 */
export function getPlanConfigById(planId: BillingPlanId | string): PlanConfig {
  const normalizedId = planId as BillingPlanId;
  return PLAN_CONFIG[normalizedId] || PLAN_CONFIG.free;
}

/**
 * Monthly video verification allowance for the given plan (calendar month; separate from panel run count).
 */
export function getVideoLimit(plan: string): number {
  if (plan === "full" || plan === "lite" || plan === "free") {
    return PLAN_CONFIG[plan].videoVerificationsPerMonth;
  }
  return 0;
}

/**
 * Get plan ID from Stripe price ID
 * 
 * @param priceId - Stripe price ID (e.g., "price_xxx")
 * @returns Plan ID or null if not found
 */
export function getPlanIdFromPriceId(priceId: string | null | undefined): BillingPlanId | null {
  if (!priceId) {
    return null;
  }
  return STRIPE_PRICE_TO_PLAN[priceId] || null;
}

