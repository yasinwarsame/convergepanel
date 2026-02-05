/**
 * Plan Mapping Helper
 * 
 * Maps Stripe price IDs to internal plan configurations.
 * This is the single source of truth for price ID → plan mapping.
 * 
 * IMPORTANT: All price ID comparisons should use this helper, not inline comparisons.
 */

import { PlanId, getPlanConfig } from "@/lib/plans";
import {
  STRIPE_PRICE_3_MODELS,
  STRIPE_3_MODELS_ANNUAL,
  STRIPE_PRICE_5_MODELS,
  STRIPE_5_MODELS_ANNUAL,
} from "@/lib/env";

export type BillingPlan = PlanId;

export interface PlanConfig {
  plan: BillingPlan;
  monthlyLimit: number;
  maxModelsPerRun: number;
}

/**
 * Get plan configuration from Stripe price ID
 * 
 * Maps a Stripe price ID to the corresponding internal plan configuration.
 * Returns null if the price ID doesn't match any known plan.
 * 
 * @param priceId - Stripe price ID (e.g., "price_xxx")
 * @returns Plan configuration or null if not found
 */
export function getPlanFromPriceId(priceId: string | null | undefined): PlanConfig | null {
  if (!priceId) {
    return null;
  }

  // 3-Model Plan - monthly
  if (priceId === STRIPE_PRICE_3_MODELS) {
    const config = getPlanConfig("lite");
    return {
      plan: "lite",
      monthlyLimit: config.maxRunsPerMonth,
      maxModelsPerRun: config.maxModelsPerRun,
    };
  }

  // 3-Model Plan - annual
  if (priceId === STRIPE_3_MODELS_ANNUAL) {
    const config = getPlanConfig("lite");
    return {
      plan: "lite",
      monthlyLimit: config.maxRunsPerMonth,
      maxModelsPerRun: config.maxModelsPerRun,
    };
  }

  // Full Plan (5 models) - monthly
  if (priceId === STRIPE_PRICE_5_MODELS) {
    const config = getPlanConfig("full");
    return {
      plan: "full",
      monthlyLimit: config.maxRunsPerMonth,
      maxModelsPerRun: config.maxModelsPerRun,
    };
  }

  // Full Plan (5 models) - annual
  if (priceId === STRIPE_5_MODELS_ANNUAL) {
    const config = getPlanConfig("full");
    return {
      plan: "full",
      monthlyLimit: config.maxRunsPerMonth,
      maxModelsPerRun: config.maxModelsPerRun,
    };
  }

  // Price ID doesn't match any known plan
  return null;
}

/**
 * Get plan configuration for free plan
 * 
 * @returns Plan configuration for free plan
 */
export function getFreePlanConfig(): PlanConfig {
  const config = getPlanConfig("free");
  return {
    plan: "free",
    monthlyLimit: config.maxRunsPerMonth,
    maxModelsPerRun: config.maxModelsPerRun,
  };
}

