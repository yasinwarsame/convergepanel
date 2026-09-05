/**
 * User Token Usage Tracking
 * 
 * Maintains denormalized token counters on user documents for fast Admin queries.
 * Uses Stripe subscription billing periods when available, falls back to calendar month for free users.
 * 
 * Firestore Schema (users/{userId}):
 *   - tokensUsedCurrentPeriod: number (tokens used in current subscription billing period)
 *   - billingCycleStart: timestamp (start of current Stripe subscription billing period - already stored by webhook)
 *   - billingInterval: "month" | "year" (billing interval from Stripe - already stored by webhook)
 * 
 * Period Reset Logic:
 * - For paid users: Use Stripe billingCycleStart + billingInterval to determine period boundaries
 * - For free users: Use calendar month (YYYY-MM) as period boundary
 * - Reset tokensUsedCurrentPeriod when a new billing period starts
 * - Does NOT create a separate tokensPeriodStart field - uses existing billingCycleStart
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { FIREBASE_PROJECT_ID } from "@/lib/firebase/admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { safeNum } from "@/lib/tokenExtraction";

const PERIOD_DAYS = 30; // 30-day rolling window for token tracking

/**
 * Calculate the end date of a billing period
 * 
 * @param periodStart - Start date of the billing period
 * @param billingInterval - "month" or "year"
 * @returns End date of the billing period
 */
function calculatePeriodEnd(periodStart: Date, billingInterval: "month" | "year"): Date {
  const end = new Date(periodStart);
  if (billingInterval === "month") {
    end.setMonth(end.getMonth() + 1);
  } else {
    end.setFullYear(end.getFullYear() + 1);
  }
  return end;
}

/**
 * Check if we're in a new billing period
 * 
 * @param billingCycleStart - Start of current billing period
 * @param billingInterval - "month" or "year" (or null/undefined for free users)
 * @param now - Current date
 * @returns true if we're in a new period (period has expired)
 */
function isNewBillingPeriod(
  billingCycleStart: Date | null,
  billingInterval: "month" | "year" | null | undefined,
  now: Date
): boolean {
  if (!billingCycleStart) {
    return true; // No period start means we need to initialize
  }

  if (!billingInterval) {
    // Free user: use calendar month
    const periodMonth = billingCycleStart.getMonth();
    const periodYear = billingCycleStart.getFullYear();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    return periodMonth !== currentMonth || periodYear !== currentYear;
  }

  // Paid user: use Stripe billing period
  const periodEnd = calculatePeriodEnd(billingCycleStart, billingInterval);
  return now >= periodEnd;
}

/**
 * Increment user's token usage for the current subscription billing period
 * 
 * This function:
 * 1. Checks if we're in a new billing period (using Stripe billingCycleStart + billingInterval)
 * 2. Resets tokensUsedCurrentPeriod if period expired
 * 3. Increments tokensUsedCurrentPeriod by the provided amount
 * 4. Uses billingCycleStart from Stripe (already stored in user doc) - does NOT create tokensPeriodStart
 * 
 * @param userId - User ID
 * @param tokens - Number of tokens to add
 * @returns Promise<{ tokensUsedCurrentPeriod: number; periodStart: Date }>
 */
export async function incrementUserTokenUsage(
  userId: string,
  tokens: number
): Promise<{ tokensUsedCurrentPeriod: number; periodStart: Date }> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }

  // CRITICAL: Use shared safeNum helper for consistency
  // Ensure tokens is a valid number (defensive against NaN/undefined)
  // If tokens is NaN, Infinity, negative, or invalid, set to 0
  let safeTokens = safeNum(tokens);
  
  // Final validation: ensure safeTokens is finite and non-negative
  if (!Number.isFinite(safeTokens) || safeTokens < 0) {
    console.error(`[userTokens] ❌ CRITICAL: tokens value is invalid for user ${userId}:`, {
      originalTokens: tokens,
      safeTokens,
      isNaN: Number.isNaN(safeTokens),
      isFinite: Number.isFinite(safeTokens),
    });
    safeTokens = 0; // Set to 0 to prevent NaN in Firestore increment
  }
  
  // Log if tokens were sanitized (for debugging)
  if (safeTokens !== tokens) {
    console.warn(`[userTokens] Sanitized invalid tokens value for user ${userId}: ${tokens} → ${safeTokens}`);
  }

  // CRITICAL: Log entry point with token value validation
  console.log(`[userTokens] 📥 incrementUserTokenUsage called for user ${userId}:`, {
    originalTokens: tokens,
    safeTokens,
    isFinite: Number.isFinite(safeTokens),
    isNaN: Number.isNaN(safeTokens),
    willProceed: safeTokens > 0,
  });

  if (safeTokens <= 0) {
    // For 0 tokens, still ensure the field exists (initialize if missing)
    // This ensures tokensUsedCurrentPeriod is always present in the user document
    console.log(`[userTokens] ⚠️ safeTokens is ${safeTokens} (<= 0), initializing field if missing for user ${userId}`);
    
    const userDocRef = adminDb.collection("users").doc(userId);
    const userDoc = await userDocRef.get();
    const data = userDoc.data();
    const billingCycleStart = data?.billingCycleStart
      ? (data.billingCycleStart.toDate ? data.billingCycleStart.toDate() : new Date(data.billingCycleStart))
      : new Date();
    
    // If tokensUsedCurrentPeriod doesn't exist, initialize it to 0 using merge set
    // CRITICAL: Use merge set to handle missing docs gracefully
    if (data?.tokensUsedCurrentPeriod === undefined) {
      await userDocRef.set({
        tokensUsedCurrentPeriod: 0,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      console.log(`[userTokens] Initialized tokensUsedCurrentPeriod to 0 for user ${userId} using merge set`);
    }
    
    return {
      tokensUsedCurrentPeriod: data?.tokensUsedCurrentPeriod ?? 0,
      periodStart: billingCycleStart,
    };
  }

  // Define canonical document path (single source of truth)
  const userDocPath = `users/${userId}`;
  const userDocRef = adminDb.collection("users").doc(userId);

  // Dev-only: log environment info to prevent emulator/prod confusion
  const isDebugMode = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DEBUG_TOKENS === "true";
  if (isDebugMode) {
    console.log(`[userTokens] 🔍 Environment info:`, {
      projectId: FIREBASE_PROJECT_ID,
      hasEmulator: !!process.env.FIRESTORE_EMULATOR_HOST,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST || "none (production)",
      nodeEnv: process.env.NODE_ENV,
      docPath: userDocPath,
      tokensToAdd: safeTokens,
    });
  }

  // Read current document state BEFORE update
  // CRITICAL: If doc doesn't exist, we'll create it with merge set (don't throw)
  const userDoc = await userDocRef.get();
  const userData = userDoc.exists ? userDoc.data() : null;
  const tokensBeforeFromDb = safeNum(userData?.tokensUsedCurrentPeriod ?? 0);
  
  if (isDebugMode) {
    console.log(`[userTokens] 📖 Read user document ${userDocPath} before update:`, {
      tokensBeforeFromDb,
      hasField: userData ? ('tokensUsedCurrentPeriod' in userData) : false,
      rawValue: userData?.tokensUsedCurrentPeriod,
    });
  }
  
  const now = new Date();
  const billingCycleStart = userData?.billingCycleStart
    ? (userData.billingCycleStart.toDate ? userData.billingCycleStart.toDate() : new Date(userData.billingCycleStart))
    : null;
  const billingInterval = userData?.billingInterval as "month" | "year" | null | undefined;

  // Check if we're in a new billing period
  const isNewPeriod = isNewBillingPeriod(billingCycleStart, billingInterval, now);

  let periodStart: Date;
  let updateData: any;
  let tokensAfterComputed: number;

  if (isNewPeriod) {
    // New billing period: reset tokens to current run's tokens
    periodStart = billingCycleStart || now;
    if (!billingCycleStart && !billingInterval) {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    tokensAfterComputed = safeTokens;
    
    updateData = {
      tokensUsedCurrentPeriod: safeTokens,
      updatedAt: FieldValue.serverTimestamp(),
      // Phase WEBHOOK-B1-C2: token bookkeeping does NOT own `billingCycleStart`.
      // This branch used to stamp a `Date.now()`-derived value for any user
      // who lacked one — fabricating a Stripe billing fact from token-counting
      // time. It was the sixth such writer, overlooked when the other five
      // were removed. The field is written only by the reconciliation paths,
      // from the plan-bearing subscription item; token accounting reads it.
    };
    
    if (isDebugMode) {
      console.log(`[userTokens] Will SET tokensUsedCurrentPeriod to ${safeTokens} for ${userDocPath} (new period)`);
    }
  } else {
    // Same billing period: increment existing count
    periodStart = billingCycleStart || new Date(now.getFullYear(), now.getMonth(), 1);
    
    if (userData?.tokensUsedCurrentPeriod === undefined) {
      // Field doesn't exist - set it to safeTokens
      tokensAfterComputed = safeTokens;
      updateData = {
        tokensUsedCurrentPeriod: safeTokens,
        updatedAt: FieldValue.serverTimestamp(),
      };
      
      if (isDebugMode) {
        console.log(`[userTokens] Will SET tokensUsedCurrentPeriod to ${safeTokens} for ${userDocPath} (field missing)`);
      }
    } else {
      // Field exists - use FieldValue.increment for atomic operation (works outside transactions)
      tokensAfterComputed = tokensBeforeFromDb + safeTokens;
      updateData = {
        tokensUsedCurrentPeriod: FieldValue.increment(safeTokens),
        updatedAt: FieldValue.serverTimestamp(),
      };
      
      if (isDebugMode) {
        console.log(`[userTokens] Will INCREMENT tokensUsedCurrentPeriod by ${safeTokens} for ${userDocPath} (${tokensBeforeFromDb} -> ${tokensAfterComputed})`);
      }
    }
  }

  // CRITICAL: Final NaN check before Firestore increment
  // FieldValue.increment() will fail or produce NaN if passed NaN/Infinity
  // If invalid, log error and set to 0 (do NOT throw - we want runs to succeed)
  if (!Number.isFinite(safeTokens) || safeTokens < 0) {
    console.error(`[userTokens] ❌ CRITICAL: Invalid tokens value for ${userDocPath}:`, {
      originalTokens: tokens,
      safeTokens,
      isNaN: Number.isNaN(safeTokens),
      isFinite: Number.isFinite(safeTokens),
    });
    console.error(`[userTokens] Setting safeTokens to 0 to prevent Firestore errors (run will still succeed)`);
    safeTokens = 0;
  }

  // Dev-only: log right before calling FieldValue.increment
  // Note: isDebugMode is already defined earlier in the function (line 156)
  if (isDebugMode) {
    console.log(`[userTokens] 🚀 About to call FieldValue.increment(${safeTokens}) for ${userDocPath}:`, {
      safeTokens,
      isFinite: Number.isFinite(safeTokens),
      isNaN: Number.isNaN(safeTokens),
      type: typeof safeTokens,
      willIncrement: !isNewPeriod && userData?.tokensUsedCurrentPeriod !== undefined,
    });
  }

  // Perform the update using merge set to handle missing docs gracefully
  // CRITICAL: Use set() with merge: true instead of update() to ensure doc exists
  try {
    console.log(`[userTokens] 🔄 About to write to Firestore for ${userDocPath}:`, {
      updateData: JSON.stringify(updateData, (key, value) => {
        if (value && typeof value === 'object' && value.constructor && value.constructor.name === 'FieldValue') {
          return `[FieldValue.increment(${safeTokens})]`;
        }
        return value;
      }),
      isNewPeriod,
      tokens: safeTokens,
      isFinite: Number.isFinite(safeTokens),
      docExists: userDoc.exists,
      usingMergeSet: true,
    });

    // CRITICAL: Use set() with merge: true to ensure doc exists and field increments
    // This guarantees the field increments even if doc is missing
    await userDocRef.set(updateData, { merge: true });
    console.log(`[userTokens] ✅ Firestore set(merge: true) call completed for ${userDocPath}`);

  } catch (updateError: any) {
    console.error(`[userTokens] ❌ Firestore set(merge: true) FAILED for ${userDocPath}:`, {
      error: updateError?.message,
      code: updateError?.code,
      stack: updateError?.stack,
      updateData: JSON.stringify(updateData, (key, value) => {
        if (value && typeof value === 'object' && value.constructor && value.constructor.name === 'FieldValue') {
          return `[FieldValue.increment(${safeTokens})]`;
        }
        return value;
      }),
      isNewPeriod,
      tokens: safeTokens,
      userId,
      projectId: FIREBASE_PROJECT_ID,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST || "none",
    });
    throw updateError; // Re-throw to be caught by caller
  }

  // Read back from Firestore AFTER update commits to verify persistence
  // Use a retry loop to ensure we read the committed value (Firestore eventual consistency)
  let verificationDoc;
  let retries = 0;
  const maxReadRetries = 3;
  let tokensAfterFromDb: number = tokensAfterComputed; // Initialize with computed value as fallback
  let updateSucceeded = false;
  
  while (retries < maxReadRetries) {
    await new Promise(resolve => setTimeout(resolve, 100 * (retries + 1))); // Increasing delay
    verificationDoc = await userDocRef.get();
    
    if (!verificationDoc.exists) {
      console.error(`[userTokens] ❌ User document ${userDocPath} does not exist after update (this should not happen with merge set)`);
      // Don't throw - use computed value as fallback
      tokensAfterFromDb = tokensAfterComputed;
      updateSucceeded = false;
      break;
    }

    const verificationData = verificationDoc.data();
    tokensAfterFromDb = safeNum(verificationData?.tokensUsedCurrentPeriod ?? 0);
    
    // If this is not a new period and we're incrementing, verify the increment was applied
    if (!isNewPeriod && tokensBeforeFromDb > 0) {
      const expectedAfter = tokensBeforeFromDb + safeTokens;
      if (tokensAfterFromDb === expectedAfter) {
        // Value matches expectation - break out of retry loop
        updateSucceeded = true;
        break;
      } else if (retries < maxReadRetries - 1) {
        // Value doesn't match yet - retry (might be eventual consistency)
        if (isDebugMode) {
          console.log(`[userTokens] Read-back retry ${retries + 1}/${maxReadRetries} for ${userDocPath}: expected ${expectedAfter}, got ${tokensAfterFromDb}`);
        }
        retries++;
        continue;
      }
    } else {
      // New period or first update - verify and break
      if (isNewPeriod && tokensAfterFromDb === safeTokens) {
        updateSucceeded = true;
      } else if (!isNewPeriod && tokensAfterFromDb === safeTokens) {
        updateSucceeded = true;
      }
      break;
    }
  }

    // CRITICAL: [TOKENS:db] log with verification after write
    // This log shows persistence verification and helps debug emulator/prod confusion
    const actualDeltaFromDb = tokensAfterFromDb - tokensBeforeFromDb;
    
    console.log(`[TOKENS:db]`, {
      docPath: userDocPath,
      before: tokensBeforeFromDb,
      after: tokensAfterFromDb,
      added: safeTokens,
      delta: actualDeltaFromDb,
    });
    
    // Dev-only: comprehensive verification logging
    if (isDebugMode) {
      const expectedDelta = safeTokens;

      // Verify tokensAfterFromDb matches expectation
      if (isNewPeriod) {
        if (tokensAfterFromDb !== safeTokens) {
          console.error(`[TOKENS:firestore] ❌ New period reset mismatch for ${userDocPath}:`, {
            docPath: userDocPath,
            uid: userId,
            tokensBeforeFromDb,
            tokensAdded: safeTokens,
            tokensAfterComputed,
            tokensAfterFromDb,
            expected: safeTokens,
            difference: tokensAfterFromDb - safeTokens,
            isNewPeriod: true,
          });
          updateSucceeded = false;
        }
      } else {
        const expectedAfter = tokensBeforeFromDb + safeTokens;
        if (tokensAfterFromDb !== expectedAfter) {
          console.error(`[TOKENS:firestore] ❌ Increment mismatch for ${userDocPath}:`, {
            docPath: userDocPath,
            uid: userId,
            tokensBeforeFromDb,
            tokensAdded: safeTokens,
            tokensAfterComputed,
            tokensAfterFromDb,
            expected: expectedAfter,
            difference: tokensAfterFromDb - expectedAfter,
            isNewPeriod: false,
          });
          updateSucceeded = false;
        }
      }
    }

    // Final verification log
    console.log(`[userTokens] ✅ Token usage update verified for ${userDocPath}:`, {
      docPath: userDocPath,
      tokensUsedCurrentPeriod: tokensAfterFromDb,
      tokensBeforeFromDb,
      tokensAdded: safeTokens,
      tokensAfterComputed,
      tokensAfterFromDb,
      billingCycleStart: periodStart.toISOString(),
      billingInterval: billingInterval || "free (calendar month)",
      isNewPeriod,
      updateSucceeded,
    });

  // Final verification - if update didn't succeed, log error
  if (!updateSucceeded) {
    console.error(`[userTokens] ❌ Update verification FAILED for ${userDocPath}:`, {
      docPath: userDocPath,
      uid: userId,
      tokensBeforeFromDb,
      tokensAdded: safeTokens,
      tokensAfterComputed,
      tokensAfterFromDb,
      isNewPeriod,
    });
  }

  return {
    tokensUsedCurrentPeriod: tokensAfterFromDb,
    periodStart: periodStart,
  };
}

