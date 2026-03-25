/**
 * Plan Configuration
 * 
 * Single source of truth for all plan definitions, limits, and features.
 * Used by billing UI, usage enforcement, and Stripe integration.
 * 
 * CRITICAL: This file is the ONLY canonical source for plan limits.
 * All other modules must import from here - never hardcode plan limits elsewhere.
 */

export type PlanId = "free" | "lite" | "full";
export type BillingInterval = "month" | "year";

export interface PlanConfig {
  id: PlanId;
  name: string;
  tagline: string;
  monthlyPriceUsd: number; // 0, 99.99, 169.99
  yearlyPriceUsd?: number; // undefined for free; 959.90, 1631.90 for paid (20% discount)
  stripePriceIds?: {
    month?: string; // from STRIPE_PRICE_*_MONTHLY
    year?: string; // from STRIPE_PRICE_*_ANNUAL
  };
  maxRunsPerMonth: number; // CRITICAL: This is the single source of truth for run limits
  maxModelsPerRun: number;
  historyRetentionDays?: number; // 7 for free, undefined for paid (unlimited)
  advancedExportEnabled: boolean;
  /** Team workspaces: governance dashboard, policies, audit (Full plan). */
  teamGovernanceAccess?: boolean;
  features: string[];
  positioningText?: string; // Optional marketing text
  badge?: string; // e.g., "Most popular"
  highlight?: boolean; // Visual highlighting for flagship plan
}

/**
 * Plan configurations
 * 
 * Three plans:
 * - free: Starter — Free (no Stripe subscription)
 * - lite: 3-Model Plan ($99.99/month or $959.90/year)
 * - full: Full Plan — 5 Models ($169.99/month or $1,631.90/year)
 * 
 * CRITICAL LIMITS (do not change without updating all references):
 * - free: 8 runs/month, 2 models
 * - lite: 80 runs/month, 3 models
 * - full: 150 runs/month, 5 models
 * 
 * PRICING (canonical values):
 * - lite: $99.99/month, $959.90/year (20% discount)
 * - full: $169.99/month, $1,631.90/year (20% discount)
 */
export const PLAN_CONFIGS: Record<PlanId, PlanConfig> = {
  free: {
    id: "free",
    name: "Starter — Free",
    tagline: "Try the panel, no credit card required.",
    monthlyPriceUsd: 0,
    yearlyPriceUsd: undefined,
    stripePriceIds: undefined,
    maxRunsPerMonth: 8,
    maxModelsPerRun: 2,
    historyRetentionDays: 7, // Only last 7 days accessible
    advancedExportEnabled: false,
    features: [
      "2 panel runs per week (up to 8 runs/month)",
      "Use up to 2 models per run",
      "Core unified answer view",
      "Basic agreement/disagreement highlighting",
      "Store recent sessions (last 7 days)",
    ],
  },
  lite: {
    id: "lite",
    name: "3-Model Plan",
    tagline: "For solo researchers who need more than one model—but not the full panel yet.",
    monthlyPriceUsd: 99.99,
    yearlyPriceUsd: 959.90, // 20% off: $99.99 × 12 = $1,199.88; $1,199.88 - $239.98 = $959.90
    stripePriceIds: {
      month: process.env.STRIPE_PRICE_3_MODELS,
      year: process.env.STRIPE_3_MODELS_ANNUAL,
    },
    maxRunsPerMonth: 80, // CRITICAL: This is the single source of truth
    maxModelsPerRun: 3,
    historyRetentionDays: undefined, // Unlimited history
    advancedExportEnabled: true,
    features: [
      "Up to 80 panel runs / month",
      "Use 3 models at a time (e.g., GPT 5.2 + Claude Opus 4.5 + Grok 4)",
      "Full unified answer + trust summary",
      "Agreement / disagreement map across all models",
      "Save and revisit past panels - Available in next release",
      "Export results (copy to clipboard / basic export)",
    ],
    positioningText: "Good if you're budget-conscious. Most power users choose Full Panel.",
  },
  full: {
    id: "full",
    name: "Full Plan (Up to 5 models per run)",
    tagline: "The real expert panel: all five models, one click, one report.",
    monthlyPriceUsd: 169.99,
    yearlyPriceUsd: 1631.90, // 20% off: $169.99 × 12 = $2,039.88; $2,039.88 - $407.98 = $1,631.90
    stripePriceIds: {
      month: process.env.STRIPE_PRICE_5_MODELS,
      year: process.env.STRIPE_5_MODELS_ANNUAL || process.env.Stripe_5_Models_Annual, // Support legacy casing
    },
    maxRunsPerMonth: 150, // CRITICAL: This is the single source of truth
    maxModelsPerRun: 5,
    historyRetentionDays: undefined, // Unlimited history
    advancedExportEnabled: true,
    teamGovernanceAccess: true,
    features: [
      "Up to 150 panel runs / month",
      "Use all 5 models at once (GPT 5.2, Claude Opus 4.5, Grok 4, Perplexity Pro, Gemini 3 Pro)",
      "Rich unified answer with strong consensus vs. contested areas",
      "Deep agreement / disagreement map across all models",
      "Compare View to see answers side-by-side",
      "Unlimited saved panels & advanced exports (Markdown / PDF / copy-ready) - Available in next release",
      "Priority processing when the system is under load",
      "Early access to new model integrations",
    ],
    badge: "Most popular",
    highlight: true, // Visually highlight this plan
  },
};

/**
 * Get plan configuration by plan ID
 * 
 * Returns plan config with normalized maxModelsPerRun (ensures only 2, 3, or 5).
 * 
 * IMPORTANT: This is the ONLY function that should be used to get plan limits.
 * Never hardcode plan limits elsewhere - always use this function.
 * 
 * @param planId - Plan identifier
 * @returns Plan configuration object with normalized maxModelsPerRun
 */
export function planHasTeamGovernance(planId: PlanId | string | undefined | null): boolean {
  if (!planId) return false;
  const id = planId as PlanId;
  const c = PLAN_CONFIGS[id];
  return c?.teamGovernanceAccess === true;
}

export function getPlanConfig(planId: PlanId): PlanConfig {
  // Defensive: validate planId exists
  if (!planId || !PLAN_CONFIGS[planId as PlanId]) {
    console.error(`[plans] Unknown planId: ${planId}, falling back to free plan`);
    return PLAN_CONFIGS.free;
  }
  
  const config = PLAN_CONFIGS[planId as PlanId];
  // Return config with normalized maxModelsPerRun
  // Dev assertion: maxModelsPerRun must be one of [2, 3, 5]
  const normalized = normalizeMaxModels(config.maxModelsPerRun);
  if (process.env.NODE_ENV !== "production" && normalized !== 2 && normalized !== 3 && normalized !== 5) {
    console.error(`[plans] CRITICAL: maxModelsPerRun is ${normalized}, expected 2, 3, or 5.`);
  }
  return {
    ...config,
    maxModelsPerRun: normalized,
  };
}

/**
 * Normalize maxModelsPerRun to valid values (2, 3, or 5)
 * 
 * Backward compatibility mapping:
 * - 4 → 5 (legacy 4-model plan → 5-model plan)
 * 
 * @param maxModels - Raw maxModels value (may be legacy 4)
 * @returns Normalized maxModels (2, 3, or 5)
 */
export function normalizeMaxModels(maxModels: number): number {
  // Normalize legacy 4-model plan to 5-model plan
  if (maxModels === 4) {
    return 5;
  }
  // Keep valid values as-is (2, 3, 5)
  if (maxModels === 2 || maxModels === 3 || maxModels === 5) {
    return maxModels;
  }
  // Invalid value - default to 2 (safest fallback)
  console.warn(`[plans] Invalid maxModels value: ${maxModels}, defaulting to 2`);
  return 2;
}

/**
 * Get Stripe price ID for a plan and billing interval
 * 
 * @param planId - Plan identifier ("lite" or "full")
 * @param interval - Billing interval ("month" or "year")
 * @returns Stripe price ID or undefined if not found
 * @throws Error if planId is invalid or price ID is missing
 */
export function getStripePriceId(
  planId: PlanId,
  interval: BillingInterval
): string | undefined {
  if (planId === "free") {
    throw new Error("Free plan does not have a Stripe price ID");
  }

  const config = getPlanConfig(planId);
  const priceId = config.stripePriceIds?.[interval];

  if (!priceId) {
    const envVarName = 
      planId === "lite"
        ? interval === "year"
          ? "STRIPE_3_MODELS_ANNUAL"
          : "STRIPE_PRICE_3_MODELS"
        : interval === "year"
        ? "STRIPE_5_MODELS_ANNUAL"
        : "STRIPE_PRICE_5_MODELS";
    throw new Error(
      `Stripe price ID not configured for ${planId} plan (${interval} billing). ` +
      `Check your .env.local file and ensure ${envVarName} is set.`
    );
  }

  return priceId;
}

/**
 * Format usage text for display
 * 
 * Examples:
 * - "Free plan: 3 / 8 runs used this month"
 * - "Research Lite: 24 / 80 runs used this month"
 * - "Full Panel: 87 / 150 runs used this month"
 * 
 * @param planId - Plan identifier
 * @param runsUsed - Number of runs used this period
 * @returns Formatted usage string
 */
export function formatUsageText(planId: PlanId, runsUsed: number): string {
  const config = getPlanConfig(planId);
  const planName = config.name.split("—")[0].trim(); // Get "Starter", "Research Lite", or "Full Panel"
  return `${planName}: ${runsUsed} / ${config.maxRunsPerMonth} runs used this month`;
}

/**
 * Format plan name with billing interval
 * 
 * Examples:
 * - "Research Lite — 3 Models (Monthly)"
 * - "Full Panel — 5 Models (Yearly)"
 * 
 * @param planId - Plan identifier
 * @param billingInterval - Billing interval ("month" | "year" | null)
 * @returns Formatted plan name with interval
 */
export function formatPlanNameWithInterval(
  planId: PlanId,
  billingInterval: BillingInterval | null
): string {
  const config = getPlanConfig(planId);
  if (!billingInterval || planId === "free") {
    return config.name;
  }
  const intervalLabel = billingInterval === "year" ? "Yearly" : "Monthly";
  return `${config.name} (${intervalLabel})`;
}

/**
 * Check if run limit is exceeded for a plan
 * 
 * @param planId - Plan identifier
 * @param runsUsed - Number of runs used this month
 * @returns True if limit is exceeded, false otherwise
 */
export function isRunLimitExceeded(planId: PlanId, runsUsed: number): boolean {
  const config = getPlanConfig(planId);
  return runsUsed >= config.maxRunsPerMonth;
}

/**
 * Check if user can use requested number of models
 * 
 * @param planId - Plan identifier
 * @param requestedModelCount - Number of models requested
 * @returns True if allowed, false otherwise
 */
export function canUseModels(planId: PlanId, requestedModelCount: number): boolean {
  const config = getPlanConfig(planId);
  return requestedModelCount <= config.maxModelsPerRun;
}

/**
 * Get plan configuration by plan ID (alias for getPlanConfig for backward compatibility)
 * 
 * @param planId - Plan identifier
 * @returns Plan configuration object
 * @deprecated Use getPlanConfig instead
 */
export function getPlanConfigById(planId: PlanId | string): PlanConfig {
  // Normalize to PlanId type
  if (planId === "solo") return getPlanConfig("lite");
  if (planId === "pro") return getPlanConfig("full");
  return getPlanConfig(planId as PlanId);
}
