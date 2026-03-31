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
import { PlanId, normalizeMaxModels } from "@/lib/plans";
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

type UsageGatePass = {
  currentRuns: number;
  maxRunsPerMonth: number;
  maxModelsPerRun: number;
  plan: PlanId;
  resetsAt: Date;
  isNewMonth: boolean;
  now: Date;
  currentMonth: string;
};

/**
 * Same limit checks as {@link checkAndIncrementUsageForRun} but does not write usage.
 * Use before expensive work; call {@link checkAndIncrementUsageForRun} after success to charge the run.
 */
export async function checkUsageAllowanceForRun(
  uid: string,
  requestedModelCount: number
): Promise<UsageCheckResult> {
  const gate = await evaluateUsageGate(uid, requestedModelCount);
  if (gate.outcome === "deny") {
    return gate.result;
  }
  return {
    allowed: true,
    runsThisMonth: gate.pass.currentRuns,
    maxRunsPerMonth: gate.pass.maxRunsPerMonth,
    maxModelsPerRun: gate.pass.maxModelsPerRun,
    plan: gate.pass.plan,
    resetsAt: gate.pass.resetsAt,
  };
}

type GateEval =
  | { outcome: "deny"; result: Extract<UsageCheckResult, { allowed: false }> }
  | { outcome: "allow"; pass: UsageGatePass };

async function evaluateUsageGate(uid: string, requestedModelCount: number): Promise<GateEval> {
  if (!adminDb) {
    throw new Error("Firestore is not available. Firebase Admin SDK may not be initialized.");
  }

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const resetsAt = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);

  const userDoc = await adminDb.collection("users").doc(uid).get();

  if (!userDoc.exists) {
    await adminDb.collection("users").doc(uid).set(
      {
        plan: "free",
        runsThisMonth: 0,
        usageMonth: currentMonth,
        totalRuns: 0,
      },
      { merge: true }
    );
    return evaluateUsageGate(uid, requestedModelCount);
  }

  const userData = userDoc.data() as Partial<UserProfile>;

  const entitlements = await getEffectiveEntitlements(uid);
  const plan = entitlements.planId;

  const storedMonth = userData?.usageMonth || currentMonth;
  let currentRuns = userData?.runsThisMonth ?? 0;

  if (userData?.totalRuns === undefined || userData?.totalRuns === null) {
    const estimatedTotalRuns = Math.max(currentRuns, 0);
    await adminDb.collection("users").doc(uid).update({
      totalRuns: estimatedTotalRuns,
    });
    console.log(
      `[usageCheck] Initialized totalRuns for user ${uid} to ${estimatedTotalRuns} (estimated from runsThisMonth: ${currentRuns})`
    );
    userData.totalRuns = estimatedTotalRuns;
  }

  const needsMigration =
    userData?.maxModelsPerRun === 4 ||
    (plan === "full" && (userData?.maxModelsPerRun === undefined || userData?.maxModelsPerRun === null)) ||
    ((plan === "free" || plan === "lite") &&
      (userData?.maxModelsPerRun === undefined || userData?.maxModelsPerRun === null));

  if (needsMigration) {
    try {
      await migrateUserToNewModelCap(uid);
      const updatedDoc = await adminDb.collection("users").doc(uid).get();
      if (updatedDoc.exists) {
        Object.assign(userData, updatedDoc.data());
      }
    } catch (migrationError: unknown) {
      console.warn(`[usageCheck] Migration failed for user ${uid}:`, migrationError);
    }
  }

  let maxRunsPerMonth = entitlements.monthlyLimit;
  let maxModelsPerRun = normalizeMaxModels(entitlements.maxModelsPerRun);

  const storedMonthlyLimit = userData?.monthlyLimit;
  if (storedMonthlyLimit !== undefined && storedMonthlyLimit !== maxRunsPerMonth) {
    console.warn(
      `[usageCheck] ⚠️ Firestore has stale monthlyLimit (${storedMonthlyLimit}) for plan ${plan}, using plan config value (${maxRunsPerMonth})`,
      { uid, plan, storedMonthlyLimit, correctLimit: maxRunsPerMonth, source: "planConfig" }
    );
    adminDb
      .collection("users")
      .doc(uid)
      .update({ monthlyLimit: maxRunsPerMonth })
      .catch((updateError: unknown) => {
        console.warn(`[usageCheck] Failed to update stale monthlyLimit in Firestore:`, updateError);
      });
  }

  if (process.env.NODE_ENV !== "production") {
    if (maxModelsPerRun !== 2 && maxModelsPerRun !== 3 && maxModelsPerRun !== 5) {
      console.error(`[usageCheck] CRITICAL: maxModelsPerRun is ${maxModelsPerRun}, expected 2, 3, or 5.`);
    }
    if (plan === "full" && maxRunsPerMonth === 400) {
      console.error(`[usageCheck] CRITICAL: Full plan has maxRunsPerMonth=400 (stale value), should be 150`);
      maxRunsPerMonth = 150;
    }
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

  const isNewMonth = storedMonth !== currentMonth;
  if (isNewMonth) {
    currentRuns = 0;
  }

  if (requestedModelCount > maxModelsPerRun) {
    return {
      outcome: "deny",
      result: {
        allowed: false,
        reason: "MODEL_LIMIT",
        runsThisMonth: currentRuns,
        maxRunsPerMonth,
        maxModelsPerRun,
        plan,
        resetsAt,
      },
    };
  }

  if (currentRuns >= maxRunsPerMonth) {
    return {
      outcome: "deny",
      result: {
        allowed: false,
        reason: "RUN_LIMIT",
        runsThisMonth: currentRuns,
        maxRunsPerMonth,
        maxModelsPerRun,
        plan,
        resetsAt,
      },
    };
  }

  return {
    outcome: "allow",
    pass: {
      currentRuns,
      maxRunsPerMonth,
      maxModelsPerRun,
      plan,
      resetsAt,
      isNewMonth,
      now,
      currentMonth,
    },
  };
}

/**
 * Check plan limits and atomically increment usage if allowed
 *
 * See module header for field semantics and atomicity notes.
 */
export async function checkAndIncrementUsageForRun(
  uid: string,
  requestedModelCount: number
): Promise<UsageCheckResult> {
  const gate = await evaluateUsageGate(uid, requestedModelCount);
  if (gate.outcome === "deny") {
    return gate.result;
  }

  const {
    currentRuns,
    maxRunsPerMonth,
    maxModelsPerRun,
    plan,
    resetsAt,
    isNewMonth,
    now,
    currentMonth,
  } = gate.pass;
  const newRunsCount = currentRuns + 1;

  try {
    if (isNewMonth) {
      await adminDb!.collection("users").doc(uid).update({
        runsThisMonth: 1,
        videoRunsThisMonth: 0,
        usageMonth: currentMonth,
        billingCycleStart: now.toISOString(),
        totalRuns: FieldValue.increment(1),
      });
      console.log("[usageCheck] Reset usage for new month, set runsThisMonth to 1, incremented totalRuns");
    } else {
      await adminDb!.collection("users").doc(uid).update({
        runsThisMonth: FieldValue.increment(1),
        usageMonth: currentMonth,
        totalRuns: FieldValue.increment(1),
      });
      console.log("[usageCheck] Incremented runsThisMonth and totalRuns atomically");
    }

    const updatedDoc = await adminDb!.collection("users").doc(uid).get();
    const updatedData = updatedDoc.data() as Partial<UserProfile>;
    const actualRuns = updatedData?.runsThisMonth ?? 0;
    const actualTotalRuns = updatedData?.totalRuns ?? 0;

    console.log("[usageCheck] Updated usage:", {
      expectedRunsThisMonth: newRunsCount,
      actualRunsThisMonth: actualRuns,
      actualTotalRuns: actualTotalRuns,
      uid,
    });

    return {
      allowed: true,
      runsThisMonth: actualRuns,
      maxRunsPerMonth,
      maxModelsPerRun,
      plan,
      resetsAt,
    };
  } catch (updateError: unknown) {
    const msg = updateError instanceof Error ? updateError.message : String(updateError);
    console.error("[usageCheck] Failed to update usage in Firestore:", updateError);
    throw new Error(`Failed to update usage: ${msg}`);
  }
}

