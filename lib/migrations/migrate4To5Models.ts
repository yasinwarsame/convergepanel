/**
 * Migration: Legacy Model Caps to New Model Caps (2/3/5)
 * 
 * This migration ensures all users have correct maxModelsPerRun values:
 * - maxModelsPerRun: 4 → 5 (legacy 4-model plan → 5-model plan)
 * - Missing/undefined → based on plan (free → 2, lite → 3, full → 5)
 * 
 * Note: maxModelsPerRun: 2 is now valid for free plan, so no migration needed.
 * 
 * This ensures legacy users can use the new model caps without upgrading.
 * 
 * The migration is idempotent and safe to run multiple times.
 * 
 * Usage:
 * - Automatic: Runs on user access via usageCheck.ts
 * - Manual: Can be run as a one-time admin script
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { getPlanConfig, normalizeMaxModels } from "@/lib/plans";

/**
 * Migrate a single user to new model cap scheme (2, 3, or 5)
 * 
 * Maps:
 * - maxModelsPerRun: 4 → 5 (legacy 4-model plan)
 * - Missing/undefined → based on plan (free → 2, lite → 3, full → 5)
 * 
 * Note: maxModelsPerRun: 2 is valid for free plan, so no migration needed.
 * 
 * @param uid - Firebase user ID
 * @returns True if migration was applied, false if not needed
 */
export async function migrateUserToNewModelCap(uid: string): Promise<boolean> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }

  const userRef = adminDb.collection("users").doc(uid);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    return false; // User doesn't exist, nothing to migrate
  }

  const userData = userDoc.data();
  const maxModelsPerRun = userData?.maxModelsPerRun;
  const plan = userData?.plan || "free";

  // Check if migration is needed
  // Only migrate: 4 → 5, or missing/undefined → plan default
  // Do NOT migrate 2 (it's valid for free plan)
  const needsMigration = 
    maxModelsPerRun === 4 || 
    (plan === "full" && (maxModelsPerRun === undefined || maxModelsPerRun === null)) ||
    ((plan === "free" || plan === "lite") && (maxModelsPerRun === undefined || maxModelsPerRun === null));

  if (!needsMigration) {
    return false; // Already migrated or doesn't need migration
  }

  // Get the correct maxModelsPerRun from plan config (already normalized)
  const config = getPlanConfig(plan);
  const correctMaxModels = config.maxModelsPerRun;

  // Update user document
  await userRef.update({
    maxModelsPerRun: correctMaxModels,
    // Also update monthlyLimit if it's missing (defensive)
    monthlyLimit: userData?.monthlyLimit ?? config.maxRunsPerMonth,
  });

  console.log(`[migration] Migrated user ${uid} from maxModelsPerRun: ${maxModelsPerRun} to ${correctMaxModels}`);
  return true;
}

/**
 * Legacy function name for backward compatibility
 * @deprecated Use migrateUserToNewModelCap instead
 */
export async function migrateUser4To5Models(uid: string): Promise<boolean> {
  return migrateUserToNewModelCap(uid);
}

/**
 * Migrate all users with legacy model caps to new caps (2/3/5)
 * 
 * This is a one-time batch migration that can be run as an admin script.
 * It queries all users and updates those with maxModelsPerRun: 4 or missing.
 * 
 * WARNING: This queries all users. Use with caution in production.
 * Consider running in batches if you have many users.
 * 
 * @returns Number of users migrated
 */
export async function migrateAllUsersToNewModelCaps(): Promise<number> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }

  console.log("[migration] Starting batch migration of legacy model caps to new caps (2/3/5)...");

  // Query all users
  const usersSnapshot = await adminDb.collection("users").get();
  let migratedCount = 0;

  for (const userDoc of usersSnapshot.docs) {
    const userData = userDoc.data();
    const maxModelsPerRun = userData?.maxModelsPerRun;
    const plan = userData?.plan || "free";

    // Check if this user needs migration
    // Only migrate: 4 → 5, or missing/undefined → plan default
    // Do NOT migrate 2 (it's valid for free plan)
    const needsMigration = 
      maxModelsPerRun === 4 || 
      (plan === "full" && (maxModelsPerRun === undefined || maxModelsPerRun === null)) ||
      ((plan === "free" || plan === "lite") && (maxModelsPerRun === undefined || maxModelsPerRun === null));

    if (needsMigration) {
      try {
        const migrated = await migrateUserToNewModelCap(userDoc.id);
        if (migrated) {
          migratedCount++;
        }
      } catch (error: any) {
        console.error(`[migration] Failed to migrate user ${userDoc.id}:`, error);
        // Continue with other users even if one fails
      }
    }
  }

  console.log(`[migration] Batch migration complete. Migrated ${migratedCount} users.`);
  return migratedCount;
}

/**
 * Legacy function name for backward compatibility
 * @deprecated Use migrateAllUsersToNewModelCaps instead
 */
export async function migrateAllUsers4To5Models(): Promise<number> {
  return migrateAllUsersToNewModelCaps();
}

