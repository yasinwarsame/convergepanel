/**
 * Entitlement Calculation and Management
 * 
 * Single source of truth for calculating effective user entitlements.
 * Priority order:
 * 1. Admin override (if active and not expired)
 * 2. Stripe subscription (if active or trialing — see
 *    lib/billing/subscriptionStatus.ts for the canonical status contract)
 * 3. Free plan (default)
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { STRIPE_PRICE_3_MODELS, STRIPE_3_MODELS_ANNUAL, STRIPE_PRICE_5_MODELS, STRIPE_5_MODELS_ANNUAL } from "@/lib/env";
import { isEntitlementBearingSubscriptionStatus } from "@/lib/billing/subscriptionStatus";

/**
 * Plan identifier for entitlements
 */
export type EntitlementPlan = "free" | "3_models" | "5_models";

/**
 * Entitlement source
 */
export type EntitlementSource = "stripe" | "override" | "free";

/**
 * Run limits for each plan (matches lib/plans.ts)
 */
export const PLAN_LIMITS: Record<EntitlementPlan, { runsPerMonth: number; maxModels: number }> = {
  free: { runsPerMonth: 8, maxModels: 2 },
  "3_models": { runsPerMonth: 80, maxModels: 3 },
  "5_models": { runsPerMonth: 150, maxModels: 5 },
};

/**
 * Map Stripe price ID to plan
 */
export function priceIdToPlan(priceId: string | null | undefined): EntitlementPlan | null {
  if (!priceId) return null;
  
  if (priceId === STRIPE_PRICE_3_MODELS || priceId === STRIPE_3_MODELS_ANNUAL) {
    return "3_models";
  }
  if (priceId === STRIPE_PRICE_5_MODELS || priceId === STRIPE_5_MODELS_ANNUAL) {
    return "5_models";
  }
  
  return null;
}

/**
 * Effective entitlement result
 */
export interface EffectiveEntitlement {
  plan: EntitlementPlan;
  runLimitMonthly: number;
  maxModelsPerRun: number;
  source: EntitlementSource;
  overrideActive?: boolean;
  stripeActive?: boolean;
}

/**
 * User document structure (subset we need)
 */
interface UserDocument {
  override?: {
    plan: "3_models" | "5_models";
    runLimitMonthly: number;
    active: boolean;
    expiresAt?: Timestamp | string | null;
  };
  planFromStripe?: EntitlementPlan | null;
  subscriptionStatusFromStripe?: string | null;
  subscriptionStatus?: string | null;
  plan?: "free" | "lite" | "full";
}

/**
 * Calculate effective entitlement from user document
 * 
 * Priority order:
 * 1. Override (if active and not expired)
 * 2. Stripe subscription (if active or trialing — see
 *    lib/billing/subscriptionStatus.ts for the canonical status contract)
 * 3. Free plan (default)
 */
export function calculateEffectiveEntitlement(userDoc: UserDocument | null | undefined): EffectiveEntitlement {
  if (!userDoc) {
    return {
      plan: "free",
      runLimitMonthly: PLAN_LIMITS.free.runsPerMonth,
      maxModelsPerRun: PLAN_LIMITS.free.maxModels,
      source: "free",
    };
  }

  const now = new Date();

  // Check override first (highest priority)
  if (userDoc.override?.active) {
    const expiresAt = userDoc.override.expiresAt;
    let isExpired = false;

    if (expiresAt) {
      let expiryDate: Date | null = null;
      if (typeof expiresAt === "string") {
        expiryDate = new Date(expiresAt);
      } else if (expiresAt instanceof Date) {
        expiryDate = expiresAt;
      } else if (expiresAt && typeof expiresAt === "object" && "toDate" in expiresAt) {
        expiryDate = (expiresAt as any).toDate();
      } else if (expiresAt && typeof expiresAt === "object" && "_seconds" in expiresAt) {
        expiryDate = new Date((expiresAt as any)._seconds * 1000);
      } else {
        isExpired = true;
      }

      if (!isExpired && expiryDate) {
        isExpired = expiryDate <= now;
      }
    }

    if (!isExpired) {
      const plan = userDoc.override.plan;
      return {
        plan,
        runLimitMonthly: userDoc.override.runLimitMonthly || PLAN_LIMITS[plan].runsPerMonth,
        maxModelsPerRun: PLAN_LIMITS[plan].maxModels,
        source: "override",
        overrideActive: true,
      };
    }
  }

  // Check Stripe subscription (second priority).
  //
  // STATUS (Phase MIG-B1): the eligible set is the canonical
  // `isEntitlementBearingSubscriptionStatus()` — "active" OR "trialing" —
  // not a literal `=== "active"` comparison. The corrective migration for
  // the legacy annual subscription attaches a compensating trial covering
  // the year the customer already paid for; without "trialing" here that
  // repair would strip a paying customer down to free limits.
  //
  // PLAN SOURCE (Phase MIG-B1): `planFromStripe` is written ONLY by the
  // admin sync path (lib/admin/stripeSync.ts). The canonical subscription
  // synchronization path — the Stripe webhook, via
  // `updateUserPlanInFirestore()` — writes `plan` and never `planFromStripe`,
  // so resolving entitlement from `planFromStripe` alone made a paid
  // decision depend on a field the canonical writer does not set. `plan` is
  // read as a fallback only when `planFromStripe` is absent, and both are
  // gated by the same status predicate. Neither field is client-writable.
  const stripeStatus = userDoc.subscriptionStatusFromStripe || userDoc.subscriptionStatus;
  const stripePlan: EntitlementPlan | null =
    userDoc.planFromStripe && userDoc.planFromStripe !== "free"
      ? userDoc.planFromStripe
      : normalizePlanId(userDoc.plan);

  if (isEntitlementBearingSubscriptionStatus(stripeStatus) && stripePlan && stripePlan !== "free") {
    return {
      plan: stripePlan,
      runLimitMonthly: PLAN_LIMITS[stripePlan].runsPerMonth,
      maxModelsPerRun: PLAN_LIMITS[stripePlan].maxModels,
      source: "stripe",
      stripeActive: true,
    };
  }

  // Default to free plan
  return {
    plan: "free",
    runLimitMonthly: PLAN_LIMITS.free.runsPerMonth,
    maxModelsPerRun: PLAN_LIMITS.free.maxModels,
    source: "free",
  };
}

/**
 * Get effective entitlement for a user by UID
 */
export async function getUserEffectiveEntitlement(uid: string): Promise<EffectiveEntitlement> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }

  const userDoc = await adminDb.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    return calculateEffectiveEntitlement(null);
  }

  const userData = userDoc.data() as UserDocument;
  return calculateEffectiveEntitlement(userData);
}

/**
 * Convert planId from plans.ts format to entitlement format
 */
export function normalizePlanId(planId: string | undefined | null): EntitlementPlan {
  if (planId === "lite") return "3_models";
  if (planId === "full") return "5_models";
  return "free";
}

/**
 * Convert entitlement plan to planId format
 */
export function entitlementPlanToPlanId(plan: EntitlementPlan): "free" | "lite" | "full" {
  if (plan === "3_models") return "lite";
  if (plan === "5_models") return "full";
  return "free";
}

/**
 * Get effective entitlements in API-friendly format
 * 
 * Returns entitlements with planId format (free/lite/full) for backward compatibility
 * while using the effective entitlement resolver logic.
 * 
 * @param uid - Firebase user ID
 * @returns Effective entitlements with planId, monthlyLimit, maxModelsPerRun, source, and resetDate
 */
export async function getEffectiveEntitlements(uid: string): Promise<{
  source: EntitlementSource;
  plan: EntitlementPlan;
  planId: "free" | "lite" | "full";
  planLabel: string;
  monthlyLimit: number;
  maxModelsPerRun: number;
  resetDate?: string | null;
}> {
  const entitlement = await getUserEffectiveEntitlement(uid);
  const planId = entitlementPlanToPlanId(entitlement.plan);
  
  // Get plan label for display
  const planLabels: Record<EntitlementPlan, string> = {
    free: "Free",
    "3_models": "3-Model Plan",
    "5_models": "Full Plan",
  };
  
  // Calculate reset date (start of next calendar month)
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  const resetDate = nextMonth.toISOString();
  
  return {
    source: entitlement.source,
    plan: entitlement.plan,
    planId,
    planLabel: planLabels[entitlement.plan],
    monthlyLimit: entitlement.runLimitMonthly,
    maxModelsPerRun: entitlement.maxModelsPerRun,
    resetDate,
  };
}

/**
 * Check if an admin override is currently active
 * 
 * @param userDoc - User document data from Firestore
 * @returns true if override is active and not expired
 */
export function isOverrideActive(userDoc: any): boolean {
  if (!userDoc?.override?.active) {
    return false;
  }
  
  const expiresAt = userDoc.override.expiresAt;
  if (!expiresAt) {
    // No expiration = always active
    return true;
  }
  
  const now = new Date();
  let expiryDate: Date | null = null;
  
  // Parse expiresAt from various formats
  if (typeof expiresAt === "string") {
    expiryDate = new Date(expiresAt);
  } else if (expiresAt instanceof Date) {
    expiryDate = expiresAt;
  } else if (expiresAt && typeof expiresAt === "object" && "toDate" in expiresAt) {
    expiryDate = (expiresAt as any).toDate();
  } else if (expiresAt && typeof expiresAt === "object" && "_seconds" in expiresAt) {
    expiryDate = new Date((expiresAt as any)._seconds * 1000);
  }
  
  if (!expiryDate || isNaN(expiryDate.getTime())) {
    // Invalid date = treat as never expires
    return true;
  }
  
  return expiryDate > now;
}

