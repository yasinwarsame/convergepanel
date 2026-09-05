/**
 * Usage Enforcement and Tracking
 * 
 * Server-side utilities for checking plan limits and tracking usage.
 * Integrates with Firestore to persist usage data.
 * 
 * Uses calendar month tracking: usage resets on the first day of each calendar month.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { PlanId, getPlanConfig, isRunLimitExceeded, canUseModels } from "@/lib/plans";
import { UserProfile } from "@/lib/types";

/**
 * Get current month string in YYYY-MM format
 * 
 * Used for calendar-month-based usage tracking.
 * Example: "2025-12" for December 2025
 */
export function getCurrentMonthString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Get user's current plan and usage
 * 
 * Fetches from Firestore and ensures usage is reset if a new month has started.
 * Uses calendar month tracking: resets on the 1st of each month.
 * 
 * @param uid - Firebase user ID
 * @returns User plan, usage count, and current month
 */
export async function getUserPlanAndUsage(uid: string): Promise<{
  plan: PlanId;
  runsUsed: number;
  usageMonth: string;
}> {
  if (!adminDb) {
    throw new Error("Firestore is not available. Firebase Admin SDK may not be initialized.");
  }

  const userDoc = await adminDb.collection("users").doc(uid).get();
  const currentMonth = getCurrentMonthString();

  if (!userDoc.exists) {
    // Initialize new user with free plan
    await adminDb.collection("users").doc(uid).set(
      {
        plan: "free",
        runsThisMonth: 0,
        usageMonth: currentMonth,
      },
      { merge: true }
    );
    return {
      plan: "free",
      runsUsed: 0,
      usageMonth: currentMonth,
    };
  }

  const data = userDoc.data() as Partial<UserProfile>;
  const storedMonth = data?.usageMonth || currentMonth;
  const plan = (data?.plan as PlanId) || "free";
  let runsUsed = data?.runsThisMonth ?? 0;

  // Reset usage if a new calendar month has started
  // Calendar month tracking: resets on the 1st of each month
  if (storedMonth !== currentMonth) {
    await adminDb.collection("users").doc(uid).update({
      runsThisMonth: 0,
      videoRunsThisMonth: 0,
      usageMonth: currentMonth,
    });
    runsUsed = 0;
  }

  return {
    plan,
    runsUsed,
    usageMonth: currentMonth,
  };
}

/**
 * Check if user can run a panel
 * 
 * Validates:
 * 1. User hasn't exceeded monthly run limit
 * 2. Number of selected models is within plan limit
 * 
 * @param uid - Firebase user ID
 * @param numModels - Number of models selected for this run
 * @returns Object with canRun flag and error message if blocked
 */
export async function canRunPanel(
  uid: string,
  numModels: number
): Promise<{ canRun: boolean; errorCode?: string; message?: string; planId?: PlanId; maxRuns?: number; runsUsed?: number }> {
  const { plan, runsUsed } = await getUserPlanAndUsage(uid);
  const config = getPlanConfig(plan);

  // Check run limit
  if (isRunLimitExceeded(plan, runsUsed)) {
    return {
      canRun: false,
      errorCode: "PLAN_LIMIT_REACHED",
      message: `You've reached your monthly limit of ${config.maxRunsPerMonth} panel runs. Upgrade your plan to continue.`,
      planId: plan,
      maxRuns: config.maxRunsPerMonth,
      runsUsed,
    };
  }

  // Check model limit
  if (!canUseModels(plan, numModels)) {
    const normalizedMax = config.maxModelsPerRun; // Already normalized by getPlanConfig (2, 3, or 5)
    // Plan-aware upgrade messages
    let message: string;
    if (normalizedMax === 2) {
      message = "Free tier allows up to 2 models per run. Upgrade to run 3 or 5 models.";
    } else if (normalizedMax === 3) {
      message = "Your plan allows up to 3 models per run. Upgrade to run 5 models.";
    } else {
      message = `Your plan allows up to ${normalizedMax} models per run.`;
    }
    return {
      canRun: false,
      errorCode: "MODEL_LIMIT_EXCEEDED",
      message,
      planId: plan,
    };
  }

  return { canRun: true };
}

/**
 * Increment user's run counter after successful panel execution
 * 
 * Atomically increments runsThisMonth by 1.
 * Should be called after a panel run completes successfully.
 * 
 * @param uid - Firebase user ID
 */
export async function incrementRunCount(uid: string): Promise<void> {
  if (!adminDb) {
    throw new Error("Firestore is not available. Firebase Admin SDK may not be initialized.");
  }

  const currentMonth = getCurrentMonthString();
  
  // Use Firestore transaction to ensure atomic increment
  await adminDb.collection("users").doc(uid).update({
    runsThisMonth: FieldValue.increment(1),
    usageMonth: currentMonth, // Ensure month is current
  });
}

/**
 * Reset usage when subscription changes
 * 
 * Called when user upgrades/downgrades to reset their usage counter
 * for the new billing period.
 *
 * Note: `videoRunsThisMonth` is intentionally not updated here — it tracks the calendar month
 * alongside `usageMonth` (see usage API / usageCheck). Plan changes do not zero video usage mid-month.
 * 
 * @param uid - Firebase user ID
 * @param newPlan - New plan ID
 * @param billingInterval - Billing interval ("month" or "year")
 */
export async function resetUsageForNewPlan(
  uid: string,
  newPlan: PlanId,
  billingInterval?: "month" | "year"
): Promise<void> {
  if (!adminDb) {
    throw new Error("Firestore is not available. Firebase Admin SDK may not be initialized.");
  }

  const currentMonth = getCurrentMonthString();
  const now = new Date();

  await adminDb.collection("users").doc(uid).update({
    plan: newPlan,
    runsThisMonth: 0,
    usageMonth: currentMonth,
    // Phase WEBHOOK-B1-C1: `billingCycleStart` is a Stripe billing-cycle
    // fact owned by the reconciliation paths. A plan/usage reset must not
    // fabricate it from the current time.
    ...(billingInterval && { billingInterval }),
  });
}

