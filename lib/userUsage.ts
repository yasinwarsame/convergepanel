/**
 * User Usage and Quota Management
 * 
 * This module provides utilities for managing user plans, usage tracking,
 * and quota enforcement. It handles:
 * - Initializing user usage on signup
 * - Resetting monthly usage when a new month begins
 * - Checking quota limits before allowing panel runs
 * 
 * All functions in this module are server-side only (use Firebase Admin SDK).
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { UserPlan, UserUsage } from "@/lib/types";

/**
 * Free plan monthly run limit
 * 
 * Free users can run up to this many panels per calendar month.
 * The limit resets automatically on the first day of each new month.
 * 
 * To change this limit, update this constant and redeploy.
 */
export const FREE_MONTHLY_LIMIT = 8;

/**
 * Get current month string in YYYY-MM format
 * 
 * Used to track which month the usage counter applies to.
 * Example: "2025-11" for November 2025
 */
export function getCurrentMonthString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Initialize user usage document in Firestore
 * 
 * Called when a new user signs up. Creates a user document with:
 * - plan: "free" (default plan for all new users)
 * - runsThisMonth: 0 (fresh start)
 * - usageMonth: current month (to track which month the counter applies to)
 * 
 * @param uid - Firebase user ID
 */
export async function initializeUserUsage(uid: string): Promise<void> {
  // Check if Firestore is available
  if (!adminDb) {
    throw new Error("Firestore is not available. Firebase Admin SDK may not be initialized.");
  }
  
  const currentMonth = getCurrentMonthString();
  
  await adminDb.collection("users").doc(uid).set(
    {
      plan: "free" as UserPlan,
      runsThisMonth: 0,
      usageMonth: currentMonth,
    },
    { merge: true } // Don't overwrite existing fields if doc already exists
  );
}

/**
 * Get user usage document from Firestore
 * 
 * Returns the user's current plan and usage stats.
 * If the document doesn't exist, returns default values (free plan, 0 runs).
 * 
 * @param uid - Firebase user ID
 * @returns User usage data
 */
export async function getUserUsage(uid: string): Promise<UserUsage> {
  // Check if Firestore is available
  if (!adminDb) {
    throw new Error("Firestore is not available. Firebase Admin SDK may not be initialized.");
  }
  
  const userDoc = await adminDb.collection("users").doc(uid).get();
  
  if (!userDoc.exists) {
    // User doc doesn't exist - return defaults and initialize
    await initializeUserUsage(uid);
    return {
      plan: "free",
      runsThisMonth: 0,
      usageMonth: getCurrentMonthString(),
    };
  }
  
  const data = userDoc.data();
  return {
    plan: (data?.plan as UserPlan) || "free",
    runsThisMonth: data?.runsThisMonth ?? 0,
    usageMonth: data?.usageMonth || getCurrentMonthString(),
  };
}

/**
 * Reset usage if a new month has started
 * 
 * Simple rolling monthly quota: if the stored usageMonth doesn't match
 * the current month, reset the counter to 0 and update usageMonth.
 * 
 * This ensures users get a fresh quota at the start of each calendar month.
 * 
 * @param uid - Firebase user ID
 * @returns Updated user usage (after potential reset)
 */
export async function resetUsageIfNewMonth(uid: string): Promise<UserUsage> {
  // Check if Firestore is available
  if (!adminDb) {
    throw new Error("Firestore is not available. Firebase Admin SDK may not be initialized.");
  }
  
  const currentMonth = getCurrentMonthString();
  const usage = await getUserUsage(uid);
  
  // If stored month doesn't match current month, reset the counter
  if (usage.usageMonth !== currentMonth) {
    await adminDb.collection("users").doc(uid).update({
      runsThisMonth: 0,
      usageMonth: currentMonth,
    });
    
    return {
      ...usage,
      runsThisMonth: 0,
      usageMonth: currentMonth,
    };
  }
  
  return usage;
}

/**
 * Check if user has exceeded their monthly quota
 * 
 * For free plan users, checks if runsThisMonth >= FREE_MONTHLY_LIMIT.
 * Other plans (solo, pro) are not yet implemented, so they default to unlimited.
 * 
 * @param usage - User usage data
 * @returns true if quota exceeded, false otherwise
 */
export function isQuotaExceeded(usage: UserUsage): boolean {
  if (usage.plan === "free") {
    return usage.runsThisMonth >= FREE_MONTHLY_LIMIT;
  }
  
  // Future plans (solo, pro) will have their own limits
  // For now, return false (unlimited)
  return false;
}

/**
 * Increment user's run counter after a successful panel run
 * 
 * Atomically increments runsThisMonth by 1.
 * Should be called after a panel run completes successfully.
 * 
 * @param uid - Firebase user ID
 */
export async function incrementRunCount(uid: string): Promise<void> {
  // Check if Firestore is available
  if (!adminDb) {
    throw new Error("Firestore is not available. Firebase Admin SDK may not be initialized.");
  }
  
  await adminDb.collection("users").doc(uid).update({
    runsThisMonth: FieldValue.increment(1),
  });
}

/**
 * Get monthly limit for a given plan
 * 
 * Returns the maximum number of panel runs allowed per month for a plan.
 * Used for displaying quota information to users.
 * 
 * IMPORTANT: This function is deprecated. Use `getPlanConfig(planId).maxRunsPerMonth` from lib/plans.ts instead.
 * This function is kept for backward compatibility only.
 * 
 * @param plan - User plan
 * @returns Monthly run limit (or null for unlimited)
 * @deprecated Use getPlanConfig(planId).maxRunsPerMonth from lib/plans.ts instead
 */
export function getMonthlyLimit(plan: UserPlan): number | null {
  // Import here to avoid circular dependency
  // Use the single source of truth from lib/plans.ts
  try {
    const { getPlanConfig } = require("@/lib/plans");
    const config = getPlanConfig(plan);
    return config.maxRunsPerMonth;
  } catch (importError) {
    // Fallback to hardcoded values only if import fails (should never happen)
    console.error("[userUsage] Failed to import plan config, using fallback values:", importError);
    switch (plan) {
      case "free":
        return FREE_MONTHLY_LIMIT;
      case "lite":
        return 80; // Research Lite: 80 runs/month (updated from 100)
      case "full":
        return 150; // Full Panel: 150 runs/month (updated from 400)
      default:
        return FREE_MONTHLY_LIMIT;
    }
  }
}

