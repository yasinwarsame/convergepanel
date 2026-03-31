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
import { getCurrentMonthString } from "@/lib/stripe/usage";
import { BillingInterval } from "@/lib/plans";
import { resetUsageForNewPlan } from "@/lib/stripe/usage";

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
  currentPeriodStart?: number; // Stripe subscription current_period_start (Unix timestamp)
}): Promise<void> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }

  const { uid, customerId, subscriptionId, planMapping, status, billingInterval, currentPeriodStart } = args;
  const userRef = adminDb.collection("users").doc(uid);
  const currentMonth = getCurrentMonthString();

  // Get plan label from PLAN_CONFIG for display
  const planConfigFromNew = getPlanConfigById(planMapping.planId);
  
  // Use Stripe's current_period_start if provided, otherwise use current time
  // This ensures token tracking uses the actual subscription billing period
  const billingCycleStartDate = currentPeriodStart 
    ? new Date(currentPeriodStart * 1000) // Convert Unix timestamp to Date
    : new Date();
  
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
    billingCycleStart: firebaseAdmin.firestore.Timestamp.fromDate(billingCycleStartDate), // Use actual Stripe period start
    usageMonth: currentMonth, // Update to current month
    planUpdatedAt: firebaseAdmin.firestore.Timestamp.now(),
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
    usageMonth: currentMonth,
  });
  
  try {
    await userRef.set(updateData, { merge: true });
    console.log(`[webhookHelpers] ✅ Firestore update successful for user ${uid}`);
    
    // Verify the update
    const userDocAfter = await userRef.get();
    if (userDocAfter.exists) {
      const userDataAfter = userDocAfter.data();
      console.log(`[webhookHelpers] ✅ Verified Firestore update for user ${uid}:`, {
        plan: userDataAfter?.plan,
        monthlyLimit: userDataAfter?.monthlyLimit,
        maxModelsPerRun: userDataAfter?.maxModelsPerRun,
        subscriptionStatus: userDataAfter?.subscriptionStatus,
      });
    }
  } catch (firestoreError: any) {
    console.error(`[webhookHelpers] ❌ CRITICAL: Firestore update failed for user ${uid}:`, {
      message: firestoreError?.message,
      stack: firestoreError?.stack,
    });
    throw firestoreError; // Re-throw to trigger error handling
  }

  // Reset usage counters for new plan
  await resetUsageForNewPlan(uid, planMapping.planId, billingInterval);

  console.log(`[webhookHelpers] ✅ Successfully updated user ${uid} to plan ${planMapping.planId}`, {
    monthlyLimit: planMapping.monthlyLimit,
    maxModelsPerRun: planMapping.maxModelsPerRun,
    subscriptionStatus: status,
    subscriptionId,
  });
}
