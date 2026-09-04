/**
 * Shared Webhook Helper Functions
 * 
 * Contains shared functions for updating user plans in Firestore.
 * Used by both the webhook handler and subscription validation.
 */

import "server-only";
import { adminDb, firebaseAdmin } from "@/lib/firebase/admin";
import { getPlanConfigById } from "@/lib/billing/planConfig";
import { SubscriptionPlanMapping } from "@/lib/billing/subscriptionMapper";
import { BillingInterval } from "@/lib/plans";
import type { SubscriptionBillingState } from "@/lib/billing/subscriptionBillingState";

/**
 * Update user plan in Firestore from Stripe subscription
 * 
 * This is the main function that updates Firestore with subscription data.
 * Used by both webhook handler and subscription validation.
 * 
 * @param args - Parameters for updating user plan
 */
export async function updateUserPlanInFirestore(args: {
  uid: string;
  customerId: string;
  subscriptionId: string;
  planMapping: SubscriptionPlanMapping;
  status: string;
  billingInterval?: BillingInterval;
  /**
   * Canonical billing state from `resolveSubscriptionBillingState()`. When
   * present its ITEM-LEVEL period is persisted — see Phase WEBHOOK-B1 note
   * below. Omitted only by callers that have no subscription object.
   */
  billingState?: SubscriptionBillingState | null;
}): Promise<void> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }

  const { uid, customerId, subscriptionId, planMapping, status, billingInterval, billingState } = args;
  const userRef = adminDb.collection("users").doc(uid);

  // Get plan label from PLAN_CONFIG for display
  const planConfigFromNew = getPlanConfigById(planMapping.planId);

  // Phase WEBHOOK-B1 — BILLING PERIOD.
  //
  // The period comes from the canonical resolver, which reads the PLAN-BEARING
  // ITEM. In Stripe's `flexible` billing mode the subscription-level
  // `current_period_start` can lag an interval change: the incident
  // subscription reported an item period starting 2026-08-02 (the annual term
  // actually paid for) while the subscription-level start still read
  // 2026-09-02. Persisting the latter records the annual term a month late.
  //
  // There is deliberately NO `new Date()` fallback. Manufacturing a billing
  // period from "now" is what made every reconciliation pass rewrite the
  // customer's cycle start to the moment the sync happened; when Stripe
  // reports no period, the stored value is left untouched instead.
  const billingCycleStartDate = billingState?.periodStart ?? null;
  const billingCycleEndDate = billingState?.periodEnd ?? null;
  
  // CRITICAL: Update Firestore with all subscription data
  // This ensures /api/user/usage can read the correct plan and limits
  const updateData: any = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    plan: planMapping.planId, // "free" | "lite" | "full"
    planLabel: planConfigFromNew.label,
    maxModels: planConfigFromNew.maxModels,
    monthlyLimit: planMapping.monthlyLimit, // CRITICAL: Must be stored for /api/user/usage
    maxModelsPerRun: planMapping.maxModelsPerRun, // CRITICAL: Must be stored for /api/user/usage
    subscriptionStatus: status,
    billingInterval: billingInterval || null,
    planUpdatedAt: firebaseAdmin.firestore.Timestamp.now(),
    // Canonical period. Written ONLY when Stripe reported one, so a
    // subscription without period data leaves the stored value untouched
    // rather than having it overwritten with "now".
    ...(billingCycleStartDate ? { billingCycleStart: firebaseAdmin.firestore.Timestamp.fromDate(billingCycleStartDate) } : {}),
    ...(billingCycleEndDate ? { currentPeriodEnd: firebaseAdmin.firestore.Timestamp.fromDate(billingCycleEndDate) } : {}),
    updatedAt: firebaseAdmin.firestore.Timestamp.now(), // General updatedAt timestamp
  };

  // If downgrading to free, remove subscription ID
  // Video allowance is 0 on free via plan; do not zero `videoRunsThisMonth` here (calendar-month counter).
  if (planMapping.planId === "free") {
    updateData.stripeSubscriptionId = firebaseAdmin.firestore.FieldValue.delete();
    updateData.billingInterval = null;
  }
  
  console.log(`[webhookHelpers] Updating Firestore for user ${uid}:`, {
    plan: planMapping.planId,
    monthlyLimit: planMapping.monthlyLimit,
    maxModelsPerRun: planMapping.maxModelsPerRun,
    subscriptionStatus: status,
    subscriptionId,
    customerId,
    billingInterval: billingInterval || null,
    periodSource: billingState?.periodSource ?? "none",
  });
  
  try {
    await userRef.set(updateData, { merge: true });
    console.log(`[webhookHelpers] ✅ Firestore update successful for user ${uid}`);
  } catch (firestoreError: any) {
    console.error(`[webhookHelpers] ❌ CRITICAL: Firestore update failed for user ${uid}:`, {
      message: firestoreError?.message,
      stack: firestoreError?.stack,
    });
    throw firestoreError; // Re-throw to trigger error handling
  }

  // Phase WEBHOOK-B1 — USAGE IS NOT TOUCHED HERE. This function used to call
  // `resetUsageForNewPlan()`, which zeroed `runsThisMonth` and rewrote
  // `usageMonth` on EVERY synchronization. Because Stripe retries deliveries
  // and re-sends events, that made an ordinary duplicate
  // `customer.subscription.updated` — or any reconciliation pass — hand the
  // customer a fresh month of quota. Calendar-month rollover is owned by the
  // run-quota gate (`lib/stripe/usageCheck.ts`), which compares the stored
  // `usageMonth` against the current month on each request; leaving both
  // fields alone here keeps that the single rollover authority.

  console.log(`[webhookHelpers] ✅ Successfully updated user ${uid} to plan ${planMapping.planId}`, {
    monthlyLimit: planMapping.monthlyLimit,
    maxModelsPerRun: planMapping.maxModelsPerRun,
    subscriptionStatus: status,
    subscriptionId,
  });
}
