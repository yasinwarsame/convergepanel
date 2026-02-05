/**
 * Stripe Subscription Sync Helper
 * 
 * Synchronizes Stripe subscription state to Firestore.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import Stripe from "stripe";
import { priceIdToPlan, getUserEffectiveEntitlement, entitlementPlanToPlanId, PLAN_LIMITS } from "./entitlements";
import { getPlanConfig } from "@/lib/plans";

/**
 * Sync subscription state from Stripe to Firestore
 */
export async function syncSubscriptionToFirestore(
  uid: string,
  subscription: Stripe.Subscription | null
): Promise<void> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }

  const userDocRef = adminDb.collection("users").doc(uid);

  if (!subscription) {
    // No subscription - set to free plan (unless override is active)
    const userDoc = await userDocRef.get();
    const userData = userDoc.data();

    if (userData?.override?.active) {
      // Just update Stripe fields, keep override
      await userDocRef.update({
        planFromStripe: null,
        subscriptionStatusFromStripe: null,
      });
    } else {
      // No override, set to free
      const freePlanId = "free";
      const freeConfig = getPlanConfig(freePlanId);

      await userDocRef.update({
        planFromStripe: null,
        subscriptionStatusFromStripe: null,
        entitlements: {
          planEffective: "free",
          runLimitMonthly: PLAN_LIMITS.free.runsPerMonth,
          source: "free",
          updatedAt: Timestamp.now(),
        },
        monthlyLimit: freeConfig.maxRunsPerMonth,
        maxModelsPerRun: freeConfig.maxModelsPerRun,
        plan: freePlanId,
      });
    }
    return;
  }

  // Extract subscription details
  const priceId = subscription.items.data[0]?.price.id;
  const planFromStripe = priceIdToPlan(priceId);
  const status = subscription.status;
  const currentPeriodEnd = (subscription as any).current_period_end
    ? Timestamp.fromDate(new Date((subscription as any).current_period_end * 1000))
    : null;

  // Get user document to check for override
  const userDoc = await userDocRef.get();
  const userData = userDoc.data();

  // Prepare update data
  const updateData: any = {
    planFromStripe,
    subscriptionStatusFromStripe: status,
    currentPeriodEnd,
    stripeSubscriptionId: subscription.id,
  };

  // Only update entitlements if override is not active
  if (!userData?.override?.active) {
    if (planFromStripe && status === "active") {
      const planId = entitlementPlanToPlanId(planFromStripe);
      const planConfig = getPlanConfig(planId);
      const limits = PLAN_LIMITS[planFromStripe];

      updateData.entitlements = {
        planEffective: planFromStripe,
        runLimitMonthly: limits.runsPerMonth,
        source: "stripe",
        updatedAt: Timestamp.now(),
      };
      updateData.monthlyLimit = limits.runsPerMonth;
      updateData.maxModelsPerRun = limits.maxModels;
      updateData.plan = planId;
    } else {
      const freePlanId = "free";
      const freeConfig = getPlanConfig(freePlanId);

      updateData.entitlements = {
        planEffective: "free",
        runLimitMonthly: PLAN_LIMITS.free.runsPerMonth,
        source: "free",
        updatedAt: Timestamp.now(),
      };
      updateData.monthlyLimit = freeConfig.maxRunsPerMonth;
      updateData.maxModelsPerRun = freeConfig.maxModelsPerRun;
      updateData.plan = freePlanId;
    }
  }

  await userDocRef.update(updateData);
}

