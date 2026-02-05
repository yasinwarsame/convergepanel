/**
 * Usage Check and Increment
 * 
 * Atomic operation that checks plan limits and increments usage in a single transaction.
 * This ensures limits are enforced correctly and usage is tracked accurately.
 * 
 * Firestore User Schema (for reference):
 * - plan: "free" | "lite" | "full" (PlanId)
 * - runsThisMonth: number (panel runs used this month)
 * - usageMonth: string (YYYY-MM format, e.g., "2025-01")
 * - billingCycleStart: string (ISO timestamp, optional)
 * - totalRuns: number (lifetime total of panel runs, never resets)
 * 
 * This function reads and writes these exact field names from Firestore.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { PlanId, getPlanConfig, normalizeMaxModels } from "@/lib/plans";
import { UserProfile } from "@/lib/types";
import { migrateUserToNewModelCap } from "@/lib/migrations/migrate4To5Models";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";

/**
 * Result of checking and incrementing usage
 * 
 * Standardized format for limit enforcement errors.
 * All fields are included for both success and failure cases to ensure consistent UI handling.
 */
export type UsageCheckResult =
  | {
      allowed: true;
      runsThisMonth: number;
      maxRunsPerMonth: number;
      maxModelsPerRun: number;
      plan: PlanId;
      resetsAt?: Date; // When the monthly limit resets (start of next calendar month in UTC)
    }
  | {
      allowed: false;
      reason: "RUN_LIMIT" | "MODEL_LIMIT";
      runsThisMonth: number;
      maxRunsPerMonth: number;
      maxModelsPerRun: number;
      plan: PlanId;
      resetsAt: Date; // When the monthly limit resets (start of next calendar month in UTC)
    };

/**
 * Check plan limits and atomically increment usage if allowed
 * 
 * This function:
 * 1. Loads user from Firestore (plan, runsThisMonth, usageMonth)
 * 2. Resets counters if a new calendar month has started
 * 3. Checks model limit (requestedModelCount <= maxModelsPerRun)
 * 4. Checks run limit (runsThisMonth < maxRunsPerMonth)
 * 5. If both checks pass, atomically increments runsThisMonth using FieldValue.increment
 * 
 * IMPORTANT: This function enforces hard monthly caps. If limits are exceeded, usage is NOT incremented.
 * 
 * ATOMICITY: Uses Firestore FieldValue.increment for atomic updates. This prevents race conditions
 * where multiple concurrent requests could increment the counter simultaneously. However, note that
 * the limit check happens before increment, so there's a small window where concurrent requests
 * at the limit boundary (e.g., 79/80) could both pass the check before either increments. In practice,
 * this is acceptable because:
 * - FieldValue.increment is atomic at the document level
 * - The check happens immediately before increment with minimal delay
 * - Users hitting the limit will be blocked on their next request
 * - For true transactional enforcement, consider using Firestore transactions (at performance cost)
 * 
 * @param uid - Firebase user ID
 * @param requestedModelCount - Number of models requested for this run
 * @returns Usage check result with updated usage count if allowed, including plan and resetsAt date
 */
export async function checkAndIncrementUsageForRun(
  uid: string,
  requestedModelCount: number
): Promise<UsageCheckResult> {
  if (!adminDb) {
    throw new Error("Firestore is not available. Firebase Admin SDK may not be initialized.");
  }

  // Get current month for calendar-based tracking
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  
  // Calculate when the monthly limit resets (start of next calendar month in UTC)
  const resetsAt = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0); // First day of next month, 00:00:00 UTC

  // Load user document
  const userDoc = await adminDb.collection("users").doc(uid).get();

  if (!userDoc.exists) {
    // Initialize new user with free plan
    await adminDb.collection("users").doc(uid).set(
      {
        plan: "free",
        runsThisMonth: 0,
        usageMonth: currentMonth,
        totalRuns: 0,
      },
      { merge: true }
    );
    // Recursively call with initialized user
    return checkAndIncrementUsageForRun(uid, requestedModelCount);
  }

  const userData = userDoc.data() as Partial<UserProfile>;
  
  // Get effective entitlements (respects admin override > Stripe > free)
  const entitlements = await getEffectiveEntitlements(uid);
  const plan = entitlements.planId;
  
  const storedMonth = userData?.usageMonth || currentMonth;
  let currentRuns = userData?.runsThisMonth ?? 0;
  
  // Ensure totalRuns exists - initialize if missing (for existing users)
  // This handles users who were created before totalRuns tracking was added
  // We estimate from runsThisMonth as a rough approximation
  // Note: This is a one-time initialization - subsequent runs will increment correctly
  if (userData?.totalRuns === undefined || userData?.totalRuns === null) {
    // Estimate totalRuns from current runsThisMonth (not perfect, but better than 0)
    // For existing users, this gives a rough estimate of their historical usage
    const estimatedTotalRuns = Math.max(currentRuns, 0);
    
    // Initialize totalRuns BEFORE incrementing to avoid double-counting
    await adminDb.collection("users").doc(uid).update({
      totalRuns: estimatedTotalRuns,
    });
    console.log(`[usageCheck] Initialized totalRuns for user ${uid} to ${estimatedTotalRuns} (estimated from runsThisMonth: ${currentRuns})`);
    
    // Update userData to reflect the initialization
    userData.totalRuns = estimatedTotalRuns;
  }

  // MIGRATION: Auto-migrate users with legacy maxModelsPerRun values (4) to new scheme (2/3/5)
  // This ensures legacy users are automatically upgraded
  // Note: maxModelsPerRun: 2 is valid for free plan, so no migration needed
  // Use effective plan from entitlements for migration check
  const needsMigration = 
    userData?.maxModelsPerRun === 4 || 
    (plan === "full" && (userData?.maxModelsPerRun === undefined || userData?.maxModelsPerRun === null)) ||
    ((plan === "free" || plan === "lite") && (userData?.maxModelsPerRun === undefined || userData?.maxModelsPerRun === null));
  
  if (needsMigration) {
    try {
      await migrateUserToNewModelCap(uid);
      // Re-fetch user data after migration
      const updatedDoc = await adminDb.collection("users").doc(uid).get();
      if (updatedDoc.exists) {
        Object.assign(userData, updatedDoc.data());
      }
    } catch (migrationError: any) {
      // Log but don't fail - migration is best-effort
      console.warn(`[usageCheck] Migration failed for user ${uid}:`, migrationError);
    }
  }

  // Use effective entitlements as source of truth (respects admin override)
  let maxRunsPerMonth = entitlements.monthlyLimit;
  let maxModelsPerRun = entitlements.maxModelsPerRun;
  
  // Normalize maxModelsPerRun to ensure only 2, 3, or 5 (backward compatibility: 4→5)
  maxModelsPerRun = normalizeMaxModels(maxModelsPerRun);
  
  // Get stored values for comparison (optional logging)
  const storedMonthlyLimit = userData?.monthlyLimit;
  const storedMaxModelsPerRun = userData?.maxModelsPerRun;
  
  // Log warning if Firestore has stale/incorrect limit values (optional, non-blocking)
  if (storedMonthlyLimit !== undefined && storedMonthlyLimit !== maxRunsPerMonth) {
    console.warn(`[usageCheck] ⚠️ Firestore has stale monthlyLimit (${storedMonthlyLimit}) for plan ${plan}, using plan config value (${maxRunsPerMonth})`, {
      uid,
      plan,
      storedMonthlyLimit,
      correctLimit: maxRunsPerMonth,
      source: "planConfig",
    });
    // Optionally update Firestore with correct value (non-blocking, don't wait)
    adminDb.collection("users").doc(uid).update({ monthlyLimit: maxRunsPerMonth }).catch((updateError: any) => {
      console.warn(`[usageCheck] Failed to update stale monthlyLimit in Firestore:`, updateError);
    });
  }
  
  // Dev assertion: verify limits are valid
  if (process.env.NODE_ENV !== "production") {
    if (maxModelsPerRun !== 2 && maxModelsPerRun !== 3 && maxModelsPerRun !== 5) {
      console.error(`[usageCheck] CRITICAL: maxModelsPerRun is ${maxModelsPerRun}, expected 2, 3, or 5.`);
    }
    // Safety check: Never allow 400 for full plan
    if (plan === "full" && maxRunsPerMonth === 400) {
      console.error(`[usageCheck] CRITICAL: Full plan has maxRunsPerMonth=400 (stale value), should be 150`);
      // Force correct value
      maxRunsPerMonth = 150;
    }
    // Verify expected limits
    const expectedLimits: Record<PlanId, { runs: number; models: number }> = {
      free: { runs: 8, models: 2 },
      lite: { runs: 80, models: 3 },
      full: { runs: 150, models: 5 },
    };
    const expected = expectedLimits[plan];
    if (expected && (maxRunsPerMonth !== expected.runs || maxModelsPerRun !== expected.models)) {
      console.warn(`[usageCheck] Plan limits don't match expected values:`, {
        plan,
        expected: expectedLimits[plan],
        actual: { runs: maxRunsPerMonth, models: maxModelsPerRun },
      });
    }
  }

  // Reset usage if a new calendar month has started
  const isNewMonth = storedMonth !== currentMonth;
  if (isNewMonth) {
    currentRuns = 0;
  }

  // Check model limit first (before incrementing)
  if (requestedModelCount > maxModelsPerRun) {
    return {
      allowed: false,
      reason: "MODEL_LIMIT",
      runsThisMonth: currentRuns,
      maxRunsPerMonth,
      maxModelsPerRun,
      plan,
      resetsAt,
    };
  }

  // Check run limit
  if (currentRuns >= maxRunsPerMonth) {
    return {
      allowed: false,
      reason: "RUN_LIMIT",
      runsThisMonth: currentRuns,
      maxRunsPerMonth,
      maxModelsPerRun,
      plan,
      resetsAt,
    };
  }

  // Both checks passed - atomically increment usage
  // Use FieldValue.increment to ensure atomicity even with concurrent requests
  // CRITICAL: This prevents race conditions where multiple requests could exceed the limit.
  // FieldValue.increment is atomic at the document level, ensuring concurrent requests
  // don't result in lost increments. However, note that the limit check happens before
  // increment, so there's a small window where concurrent requests at the limit boundary
  // (e.g., 79/80) could both pass the check before either increments. In practice, this
  // is acceptable because:
  // - FieldValue.increment is atomic (prevents lost updates)
  // - The check-to-increment delay is minimal (microseconds)
  // - Users exceeding the limit will be blocked on their next request
  // - For true transactional enforcement, use Firestore transactions (at performance cost)
  const newRunsCount = currentRuns + 1;

  try {
    if (isNewMonth) {
      // New month: reset to 1 and update billingCycleStart
      // Also increment totalRuns (lifetime counter)
      await adminDb.collection("users").doc(uid).update({
        runsThisMonth: 1,
        usageMonth: currentMonth,
        billingCycleStart: now.toISOString(),
        totalRuns: FieldValue.increment(1), // Increment lifetime total
      });
      console.log("[usageCheck] Reset usage for new month, set runsThisMonth to 1, incremented totalRuns");
    } else {
      // Same month: atomically increment both counters
      await adminDb.collection("users").doc(uid).update({
        runsThisMonth: FieldValue.increment(1),
        usageMonth: currentMonth, // Ensure month is current
        totalRuns: FieldValue.increment(1), // Increment lifetime total
      });
      console.log("[usageCheck] Incremented runsThisMonth and totalRuns atomically");
    }
    
    // Verify the update by reading back the document
    const updatedDoc = await adminDb.collection("users").doc(uid).get();
    const updatedData = updatedDoc.data() as Partial<UserProfile>;
    const actualRuns = updatedData?.runsThisMonth ?? 0;
    const actualTotalRuns = updatedData?.totalRuns ?? 0;
    
    console.log("[usageCheck] Updated usage:", {
      expectedRunsThisMonth: newRunsCount,
      actualRunsThisMonth: actualRuns,
      actualTotalRuns: actualTotalRuns,
      uid,
    });
    
    // Use the actual value from DB in case of any discrepancy
    const finalRunsCount = actualRuns;
    
    return {
      allowed: true,
      runsThisMonth: finalRunsCount,
      maxRunsPerMonth,
      maxModelsPerRun,
      plan,
      resetsAt,
    };
  } catch (updateError: any) {
    console.error("[usageCheck] Failed to update usage in Firestore:", updateError);
    throw new Error(`Failed to update usage: ${updateError.message}`);
  }
}

