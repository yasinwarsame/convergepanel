/**
 * Subscription Validation — REQUEST-TIME RECONCILIATION.
 *
 * This is the self-healing path that runs on ordinary paid requests
 * (`/api/run-panel`, `/api/verify-claim`, the workspace run and verification
 * routes, `/api/user/usage` and `/api/billing/validate-subscription`). It
 * exists because a webhook may not have arrived.
 *
 * Phase WEBHOOK-B1-C6 — IT NOW ANSWERS TO THE SAME AUTHORITY CONTRACT AS THE
 * WEBHOOK.
 *
 * The C5-R1 exact-head review proved that the webhook's safety guarantee did
 * not survive contact with normal operation, because this path had its own,
 * weaker selection rule:
 *
 *   - it listed only the first 10 subscriptions and ignored `has_more`, so ten
 *     newer throwaway subscriptions could hide the authoritative one and a
 *     paying customer was downgraded to free;
 *   - it sorted by `created` and took the newest plan-bearing subscription, so
 *     an ambiguity the webhook had explicitly REFUSED to resolve was resolved
 *     here on the very next request — and with equal creation timestamps the
 *     winner flipped with Stripe's array order, reintroducing exactly the
 *     order-dependence the webhook correction removed.
 *
 * Authority now comes from `resolveCustomerSubscriptionAuthority()`, the same
 * resolver the webhook uses: the customer's whole subscription set, paginated
 * to exhaustion, classified by the same plan-bearing predicate. There is no
 * second implementation and no second ranking rule.
 *
 * IMPORTANT: this function is defensive and never throws. It returns `false`
 * when it could not establish state; callers treat that as "not validated",
 * never as "no subscription". A state it cannot establish is never a reason to
 * write.
 */

import "server-only";
import { stripe } from "./client";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { mapSubscriptionToPlan } from "@/lib/billing/subscriptionMapper";
import { updateUserPlanInFirestore } from "./webhookHelpers";
import { resolveSubscriptionBillingState } from "@/lib/billing/subscriptionBillingState";
import {
  reportMultipleEntitlementSubscriptions,
  resolveCustomerSubscriptionAuthority,
  verifyCustomerIdentity,
} from "@/lib/billing/customerSubscriptionAuthority";
import { isTransientDependencyError } from "@/lib/billing/reconciliationOutcome";
import { BillingInterval } from "@/lib/plans";
import { PLAN_CONFIG } from "@/lib/billing/planConfig";
import { isOverrideActive } from "@/lib/admin/entitlements";

/**
 * Validate and reconcile a user's plan against their authoritative Stripe
 * subscription state.
 *
 * @param uid - Firebase user ID
 * @param stripeCustomerId - optional caller-supplied customer id. It is a
 *   HINT, not authority: the stored binding always wins, and a value that
 *   conflicts with it is refused rather than followed.
 * @returns `true` when validation succeeded or was not needed, `false` when it
 *   could not be completed. `false` never implies absence of a subscription.
 */
export async function validateUserSubscription(
  uid: string,
  stripeCustomerId?: string
): Promise<boolean> {
  try {
    if (!stripe) {
      logger.warn("[subscriptionValidation] Stripe not configured, skipping validation");
      return true; // Not an error - just skip validation
    }

    if (!adminDb) {
      logger.warn("[subscriptionValidation] Firestore not available, skipping validation");
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

    // Only validate paid plans. A free user has nothing this path could
    // correct downwards, and upgrades are the webhook's job — reconciling
    // every free request would also put a Stripe call on the hot path of the
    // largest population of users for no billing benefit.
    if (currentPlan === "free" || !currentPlan) {
      return true; // No validation needed for free plan
    }

    // ASSOCIATION, on the same rule as the webhook. This path can DOWNGRADE, so
    // it is treated as destructive: a caller-supplied customer id may never
    // bootstrap a binding that does not already exist, and may never override
    // one that does. Without this, a caller passing a foreign customer id could
    // have that customer's (empty) subscription set decide this user's plan.
    const identity = verifyCustomerIdentity({
      storedCustomerId: (userData?.stripeCustomerId as string | undefined) ?? null,
      eventCustomerId: stripeCustomerId ?? null,
      destructive: true,
    });
    if (!identity.ok) {
      if (identity.reason === "association_conflict") {
        logger.error("[subscriptionValidation] Refusing reconciliation: caller-supplied customer id conflicts with the stored binding", { reason: identity.reason });
        return false;
      }
      // A paid plan with no stored customer binding cannot be reconciled from
      // Stripe at all, and must certainly not be downgraded on the strength of
      // a customer we never bound. Leave it alone; this is not a failure.
      logger.warn("[subscriptionValidation] User has a paid plan but no verified Stripe customer binding; skipping reconciliation");
      return true;
    }
    const verifiedCustomerId = identity.verifiedCustomerId;

    // THE AUTHORITY DECISION — the customer's whole subscription set, resolved
    // by the SAME function the webhook uses. Paginated to exhaustion: a
    // truncated first page is not proof of absence.
    let authority;
    try {
      authority = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId });
    } catch (dependencyError) {
      if (isTransientDependencyError(dependencyError)) {
        // State could not be determined. That is never authority to downgrade.
        logger.warn("[subscriptionValidation] Could not establish the customer's subscription set; leaving billing state untouched", {
          dependency: dependencyError.dependency,
          operation: dependencyError.operation,
        });
        return false;
      }
      throw dependencyError;
    }

    if (authority.kind === "unverified_customer") {
      logger.error("[subscriptionValidation] Cannot establish the customer's subscription set without a verified customer");
      return false;
    }

    if (authority.kind === "customer_missing") {
      // Stripe says the customer itself is gone. An absent lookup is not
      // positive authority to strip a paid plan — the binding may be stale, or
      // a migration may be in flight.
      logger.error("[subscriptionValidation] Stripe customer not found; refusing to derive entitlement from an absent lookup");
      return false;
    }

    if (authority.kind === "multiple_entitlements") {
      // Unsupported under the one-subscription product contract, and there is
      // no documented rule for choosing. The webhook refuses this state; an
      // ordinary request must refuse it identically, or the refusal is
      // meaningless. Preserve existing state and surface it.
      reportMultipleEntitlementSubscriptions({
        path: "request_time_reconciliation",
        stripeCustomerId: verifiedCustomerId,
        uid,
        storedSubscriptionId: (userData?.stripeSubscriptionId as string | undefined) ?? null,
        candidateSubscriptionIds: authority.subscriptionIds,
        candidateCount: authority.count,
      });
      return false;
    }

    const firestoreSubscriptionId = userData?.stripeSubscriptionId;
    const firestoreStatus = userData?.subscriptionStatus;

    if (authority.kind === "no_entitlement") {
      // Proven, after exhausting the listing: this customer holds no
      // plan-bearing subscription. Correct the paid plan — unless an admin
      // override is deliberately holding it open.
      if (isOverrideActive(userData)) {
        logger.info("[subscriptionValidation] Skipping downgrade - admin override is active");
        return true;
      }

      await updateUserPlanInFirestore({
        uid,
        customerId: verifiedCustomerId,
        subscriptionId: firestoreSubscriptionId || "",
        planMapping: {
          planId: "free",
          // Phase WEBHOOK-B1-C6: from the plan configuration, not hard-coded.
          // This path used to write `maxModelsPerRun: 3` while the webhook
          // wrote the configured 2, so which writer downgraded a customer
          // decided how many models they kept.
          monthlyLimit: PLAN_CONFIG.free.monthlyLimit,
          maxModelsPerRun: PLAN_CONFIG.free.maxModels,
          isActive: false,
        },
        status: "canceled",
      });
      return true;
    }

    // Exactly one plan-bearing subscription: that one is authoritative.
    const authoritative = authority.subscription;
    const planMapping = mapSubscriptionToPlan(authoritative);

    // Phase WEBHOOK-B1: the cadence is part of "does local state match
    // Stripe". It was previously excluded, so a subscription whose plan, id
    // and status all matched but whose stored `billingInterval` was stale —
    // exactly the state left behind when a Price's cadence is corrected —
    // could never be repaired by this path.
    const canonicalState = resolveSubscriptionBillingState(authoritative as never);
    const intervalMismatch = canonicalState.ok && userData?.billingInterval !== canonicalState.state.billingInterval;

    const matches =
      currentPlan === planMapping.planId &&
      firestoreSubscriptionId === authoritative.id &&
      firestoreStatus === authoritative.status &&
      !intervalMismatch;

    if (matches) return true;

    // Phase WEBHOOK-B1: same canonical resolver the webhook uses. If the
    // subscription cannot be resolved, this path writes nothing derived from
    // it rather than manufacturing a period from the current time.
    if (!canonicalState.ok) {
      logger.warn("[subscriptionValidation] Could not resolve canonical billing state; skipping reconciliation write", {
        reason: canonicalState.reason,
      });
      return true;
    }
    const billingInterval: BillingInterval = canonicalState.state.billingInterval;

    await updateUserPlanInFirestore({
      uid,
      customerId: verifiedCustomerId,
      subscriptionId: authoritative.id,
      planMapping,
      status: authoritative.status,
      billingInterval,
      billingState: canonicalState.state,
    });

    return true;
  } catch (error: any) {
    // Defensive: log error but don't block user
    logger.error("[subscriptionValidation] Error validating subscription", { error: error?.message });
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
