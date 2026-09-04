/**
 * Stripe Subscription Sync Helper
 * 
 * Synchronizes Stripe subscription state to Firestore.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import Stripe from "stripe";
import { getUserEffectiveEntitlement, entitlementPlanToPlanId, normalizePlanId, PLAN_LIMITS } from "./entitlements";
import { mapSubscriptionToPlan } from "@/lib/billing/subscriptionMapper";
import { isEntitlementBearingSubscriptionStatus } from "@/lib/billing/subscriptionStatus";
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

  // Extract subscription details.
  //
  // Phase MIG-B1: plan resolution goes through the CANONICAL
  // `mapSubscriptionToPlan()` rather than this module's own
  // `priceIdToPlan()` lookup. `priceIdToPlan()` consults only the current
  // checkout price environment variables, so a subscription on a RETIRED
  // Price (the defective monthly-cadence "Full Annual" Price this incident
  // retired) resolved to `null` and this sync then wrote the customer down
  // to free — even while Stripe still reported the subscription active.
  // The canonical mapper prefers a recognized current Price exactly as
  // before and only then falls back to the validated, server-written
  // `targetPlan` marker.
  const status = subscription.status;
  const planMapping = mapSubscriptionToPlan(subscription);
  const planFromStripe = planMapping.isActive ? normalizePlanId(planMapping.planId) : null;
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
    // Status gate: the canonical entitlement-bearing set ("active" or
    // "trialing"), so an admin sync run during the corrective migration's
    // compensating trial does not downgrade a paying customer.
    if (planFromStripe && planFromStripe !== "free" && isEntitlementBearingSubscriptionStatus(status)) {
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

