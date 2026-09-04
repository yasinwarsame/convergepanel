/**
 * Subscription Validation
 * 
 * Validates Stripe subscription status for users with paid plans.
 * This ensures Firestore stays in sync with Stripe even if webhooks fail.
 * 
 * IMPORTANT: All validation functions are defensive and never throw.
 * If validation fails, we log the issue but don't block the user.
 */

import "server-only";
import { stripe } from "./client";
import { adminDb } from "@/lib/firebase/admin";
import { mapSubscriptionToPlan } from "@/lib/billing/subscriptionMapper";
import { updateUserPlanInFirestore } from "./webhookHelpers";
import { resolveSubscriptionBillingState } from "@/lib/billing/subscriptionBillingState";
import { BillingInterval } from "@/lib/plans";
import { isOverrideActive } from "@/lib/admin/entitlements";

/**
 * Validate and sync subscription status for a user
 * 
 * This function:
 * 1. Checks if user has a paid plan in Firestore
 * 2. If yes, validates subscription status with Stripe
 * 3. Updates Firestore if subscription status has changed
 * 
 * @param uid - Firebase user ID
 * @param stripeCustomerId - Stripe customer ID (optional, will be looked up if not provided)
 * @returns true if validation succeeded (or not needed), false if validation failed
 */
export async function validateUserSubscription(
  uid: string,
  stripeCustomerId?: string
): Promise<boolean> {
  try {
    if (!stripe) {
      console.warn("[subscriptionValidation] Stripe not configured, skipping validation");
      return true; // Not an error - just skip validation
    }

    if (!adminDb) {
      console.warn("[subscriptionValidation] Firestore not available, skipping validation");
      return true; // Not an error - just skip validation
    }

    // Get user from Firestore
    const userDoc = await adminDb.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      // New user - no validation needed
      return true;
    }

    const userData = userDoc.data();
    const currentPlan = userData?.plan;
    const currentStripeCustomerId = stripeCustomerId || userData?.stripeCustomerId;

    // Only validate paid plans (free plan doesn't have Stripe subscription)
    if (currentPlan === "free" || !currentPlan) {
      return true; // No validation needed for free plan
    }

    // If no Stripe customer ID, can't validate
    if (!currentStripeCustomerId) {
      console.warn("[subscriptionValidation] User has paid plan but no stripeCustomerId:", {
        uid,
        plan: currentPlan,
      });
      return true; // Not blocking - user might be in transition
    }

    // Fetch subscriptions from Stripe
    const subscriptions = await stripe.subscriptions.list({
      customer: currentStripeCustomerId,
      status: "all",
      limit: 10,
    });

    // Find the most recent active subscription
    const sortedSubscriptions = subscriptions.data.sort((a, b) => b.created - a.created);
    const activeSubscription = sortedSubscriptions.find(
      (sub) => sub.status === "active" || sub.status === "trialing" || sub.status === "past_due"
    );

    // Map subscription to plan
    const planMapping = activeSubscription
      ? mapSubscriptionToPlan(activeSubscription)
      : null;

    // Check if Firestore plan matches Stripe subscription
    const firestoreSubscriptionId = userData?.stripeSubscriptionId;
    const firestoreStatus = userData?.subscriptionStatus;

    if (activeSubscription) {
      // User has active subscription in Stripe
      const expectedPlan = planMapping?.planId;
      
      // If Firestore plan doesn't match Stripe, update it
      // Phase WEBHOOK-B1: the cadence is part of "does local state match
      // Stripe". It was previously excluded, so a subscription whose plan,
      // id and status all matched but whose stored `billingInterval` was
      // stale — exactly the state left behind when a Price's cadence is
      // corrected — could never be repaired by this path.
      const canonicalState = resolveSubscriptionBillingState(activeSubscription as never);
      const firestoreBillingInterval = userData?.billingInterval;
      const intervalMismatch = canonicalState.ok && firestoreBillingInterval !== canonicalState.state.billingInterval;

      if (currentPlan !== expectedPlan || 
          firestoreSubscriptionId !== activeSubscription.id ||
          firestoreStatus !== activeSubscription.status ||
          intervalMismatch) {
        console.log("[subscriptionValidation] Plan mismatch detected, syncing from Stripe:", {
          uid,
          firestorePlan: currentPlan,
          stripePlan: expectedPlan,
          firestoreSubscriptionId,
          stripeSubscriptionId: activeSubscription.id,
          firestoreStatus,
          stripeStatus: activeSubscription.status,
        });

        // Update Firestore to match Stripe
        // Phase WEBHOOK-B1: same canonical resolver the webhook uses. If the
        // subscription cannot be resolved, this path writes nothing derived
        // from it rather than manufacturing a period from the current time.
        const billingStateResult = canonicalState;
        if (!billingStateResult.ok) {
          console.warn("[subscriptionValidation] Could not resolve canonical billing state; skipping reconciliation write");
          return true;
        }
        const billingInterval: BillingInterval = billingStateResult.state.billingInterval;
        
        await updateUserPlanInFirestore({
          uid,
          customerId: currentStripeCustomerId,
          subscriptionId: activeSubscription.id,
          planMapping: planMapping!,
          status: activeSubscription.status,
          billingInterval,
          billingState: billingStateResult.state,
        });

        return true;
      }

      // Plans match - validation successful
      return true;
    } else {
      // No active subscription in Stripe, but user has paid plan in Firestore
      // This could mean subscription was canceled
      // BUT: Do NOT downgrade if admin override is active
      if (currentPlan !== "free" && !isOverrideActive(userData)) {
        console.log("[subscriptionValidation] No active subscription found, downgrading to free:", {
          uid,
          currentPlan,
          firestoreSubscriptionId,
        });

        // Downgrade to free plan (only if no active override)
        await updateUserPlanInFirestore({
          uid,
          customerId: currentStripeCustomerId,
          subscriptionId: firestoreSubscriptionId || "",
          planMapping: {
            planId: "free",
            monthlyLimit: 8,
            maxModelsPerRun: 3,
            isActive: false,
          },
          status: "canceled",
        });

        return true;
      } else if (isOverrideActive(userData)) {
        console.log("[subscriptionValidation] Skipping downgrade - admin override is active:", {
          uid,
          currentPlan,
        });
      }

      return true;
    }
  } catch (error: any) {
    // Defensive: log error but don't block user
    console.error("[subscriptionValidation] Error validating subscription:", {
      uid,
      error: error?.message,
      stack: error?.stack,
    });
    return false; // Return false to indicate validation failed, but don't throw
  }
}

/**
 * Quick check: Is subscription likely active based on Firestore data?
 * 
 * This is a fast check that doesn't call Stripe API.
 * Used for quick validation before expensive operations.
 * 
 * @param userData - User document data from Firestore
 * @returns true if subscription appears active, false otherwise
 */
export function isSubscriptionLikelyActive(userData: any): boolean {
  if (!userData) return false;
  
  const plan = userData.plan;
  const subscriptionStatus = userData.subscriptionStatus;
  const stripeSubscriptionId = userData.stripeSubscriptionId;

  // Free plan is always "active" (no subscription needed)
  if (plan === "free" || !plan) {
    return true;
  }

  // Paid plans need active subscription
  if (!stripeSubscriptionId) {
    return false;
  }

  // Check if status indicates active subscription
  const activeStatuses = ["active", "trialing", "past_due"];
  return activeStatuses.includes(subscriptionStatus);
}
