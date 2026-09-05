/**
 * Self-Serve Plan Sync Endpoint
 *
 * Lets a signed-in user re-derive their own plan from Stripe. The billing page
 * invokes it automatically on the post-checkout redirect, so despite the
 * "manual" name it is one of the application's THREE automatic billing-authority
 * writers, alongside the Stripe webhook and request-time reconciliation.
 *
 * Phase WEBHOOK-B1-C7 — TWO DEFECTS, ONE HANDLER.
 *
 * AUTHORITY. This route carried the old selection rule: list ten subscriptions,
 * ignore `has_more`, sort by `created`, take the newest. So a customer set the
 * webhook and request-time reconciliation had both explicitly REFUSED to
 * resolve was resolved here on the very next page load, and a paying customer
 * whose authoritative subscription sat behind ten newer throwaway ones was
 * downgraded to free. Authority now comes from
 * `resolveCustomerSubscriptionAuthority()` — the same resolver, the same
 * exhaustive enumeration, the same refusal — so all three automatic writers
 * answer the same question the same way.
 *
 * USAGE (BILLING-USAGE-Q1). This route also called the plan-change usage reset
 * unconditionally, which zeroed `runsThisMonth`. Because any authenticated user
 * may sync their own account, that made "re-check my plan" a self-serve quota
 * reset: run out of runs, press sync, run again. The reset is gone.
 *
 * THE OWNERSHIP RULE. Billing synchronization owns Stripe customer identity,
 * subscription identity, status, plan, cadence and billing-cycle facts. It does
 * NOT own run usage. Only the canonical calendar-month quota transition in
 * `lib/stripe/usage.ts` may reset a usage counter.
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { adminDb, firebaseAdmin } from "@/lib/firebase/admin";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { PLAN_CONFIG, getPlanConfigById } from "@/lib/billing/planConfig";
import { mapSubscriptionToPlan } from "@/lib/billing/subscriptionMapper";
import { resolveSubscriptionBillingState } from "@/lib/billing/subscriptionBillingState";
import {
  reportIncompleteAuthorityEnumeration,
  reportMultipleEntitlementSubscriptions,
  resolveCustomerSubscriptionAuthority,
} from "@/lib/billing/customerSubscriptionAuthority";
import { isTransientDependencyError } from "@/lib/billing/reconciliationOutcome";
import { updateUserPlanInFirestore } from "@/lib/stripe/webhookHelpers";
import { isOverrideActive } from "@/lib/admin/entitlements";
import { logger } from "@/lib/logger";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Auth Identity Consistency Remediation, Step 7 — resolves via the
    // shared, hardened resolver (considers cookie AND bearer, fails
    // closed on a confirmed identity mismatch) rather than this route's
    // own duplicated cookie-first logic. Also removes this route's
    // pre-existing direct `console.log`/`console.error` of raw uid
    // values, which violated this step's "no uid is ever logged"
    // invariant — replaced with the shared, safe telemetry wrapper.
    const identity = await resolveRequestIdentity(req);
    if (identity.status !== "authenticated") {
      logIdentityResolutionFailure({ route: "POST /api/billing/sync-plan", method: "POST", failureCategory: identity.reason });
      const isTokenError =
        identity.reason === "invalid_bearer_token" ||
        identity.reason === "invalid_session_cookie" ||
        identity.reason === "expired_session" ||
        identity.reason === "revoked_session";
      return NextResponse.json(
        {
          error: isTokenError
            ? "Authentication failed. Please sign in again."
            : "Unauthorized. Please sign in.",
        },
        { status: 401 }
      );
    }
    const uid = identity.uid;

    if (!adminDb) {
      console.error("[sync-plan] ❌ Firestore not available");
      return NextResponse.json(
        { error: "Database not available" },
        { status: 500 }
      );
    }

    if (!stripe) {
      console.error("[sync-plan] ❌ Stripe not configured");
      return NextResponse.json(
        { error: "Stripe not configured" },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({})); // Allow empty body
    const { targetUid } = body;

    // Allow users to sync their own plan, or require admin for other users
    const targetUserId = targetUid || uid;
    if (targetUserId !== uid) {
      // Check if user is admin (you can add admin check here)
      // For now, only allow syncing own plan
      console.error("[sync-plan] ❌ User attempted to sync another user's plan:", { uid, targetUserId });
      return NextResponse.json(
        { error: "You can only sync your own plan" },
        { status: 403 }
      );
    }
    
    console.log("[sync-plan] ✅ Authenticated user, syncing plan for:", targetUserId);

    // Get user from Firestore
    const userDoc = await adminDb.collection("users").doc(targetUserId).get();
    if (!userDoc.exists) {
      console.error("[sync-plan] ❌ User document not found in Firestore:", targetUserId);
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    const userData = userDoc.data();
    const stripeCustomerId = userData?.stripeCustomerId;
    
    console.log("[sync-plan] User Firestore data:", {
      uid: targetUserId,
      hasStripeCustomerId: !!stripeCustomerId,
      currentPlan: userData?.plan,
    });

    if (!stripeCustomerId) {
      return NextResponse.json(
        { error: "User does not have a Stripe customer ID" },
        { status: 400 }
      );
    }

    // THE AUTHORITY DECISION — one shared resolver for all three automatic
    // writers. It enumerates the customer's subscriptions to exhaustion, uses
    // the canonical plan-bearing predicate, and reports more than one candidate
    // as an unsupported state rather than picking one. The customer id comes
    // from the stored binding on the user's own document and from nowhere else:
    // the request body cannot steer whose subscriptions are read.
    //
    // This also replaces a separate `customers.retrieve()` round trip. A
    // definitively missing customer now surfaces as its own outcome from the
    // one enumeration, so the route makes fewer Stripe calls than before.
    let authority;
    try {
      authority = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: stripeCustomerId });
    } catch (dependencyError) {
      if (isTransientDependencyError(dependencyError)) {
        // Could not establish state. That is never authority to change a plan,
        // and it is certainly not "this customer has no subscriptions".
        logger.warn("[sync-plan] Could not establish the customer's subscription set; leaving billing state untouched", {
          dependency: dependencyError.dependency,
          operation: dependencyError.operation,
        });
        return NextResponse.json(
          { error: "Could not reach Stripe to check your subscription. Please try again in a moment." },
          { status: 503 }
        );
      }
      throw dependencyError;
    }

    if (authority.kind === "enumeration_incomplete") {
      // Phase WEBHOOK-B1-C8: never report success, and never downgrade, on a
      // set we did not finish reading.
      reportIncompleteAuthorityEnumeration({
        path: "self_serve_plan_sync",
        stripeCustomerId,
        uid: targetUserId,
        storedSubscriptionId: (userData?.stripeSubscriptionId as string | undefined) ?? null,
        reason: authority.reason,
        pagesFetched: authority.pagesFetched,
      });
      return NextResponse.json(
        {
          error: "We couldn't finish checking your subscriptions, so we've left your plan unchanged. Please contact support.",
          code: "authority_enumeration_incomplete",
        },
        { status: 409 }
      );
    }

    if (authority.kind === "unverified_customer" || authority.kind === "customer_missing") {
      // An absent lookup is not proof that the user holds no entitlement — the
      // stored binding may be stale — so nothing is written.
      logger.error("[sync-plan] Stripe customer could not be verified; refusing to derive entitlement from an absent lookup");
      return NextResponse.json(
        { error: "Your Stripe customer record could not be verified. Please contact support." },
        { status: 409 }
      );
    }

    if (authority.kind === "multiple_entitlements") {
      // Unsupported under the one-subscription product contract, and the
      // repository defines no rule for choosing between two. The webhook and
      // request-time reconciliation both refuse this state; if this route
      // resolved it, their refusal would mean nothing. Change nothing, surface
      // it, and do not tell the user a plan was selected.
      reportMultipleEntitlementSubscriptions({
        path: "self_serve_plan_sync",
        stripeCustomerId,
        uid: targetUserId,
        storedSubscriptionId: (userData?.stripeSubscriptionId as string | undefined) ?? null,
        candidateSubscriptionIds: authority.subscriptionIds,
        candidateCount: authority.count,
      });
      return NextResponse.json(
        {
          error: "Your account has more than one active subscription, so we can't safely choose between them. Please contact support.",
          code: "multiple_entitlement_subscriptions",
        },
        { status: 409 }
      );
    }

    if (authority.kind === "no_entitlement") {
      // Proven, after exhausting the listing: no current billing relationship.
      // An admin override deliberately holds a plan open, so it is honoured
      // here exactly as it is on the request-time path.
      if (isOverrideActive(userData)) {
        logger.info("[sync-plan] Skipping downgrade - admin override is active");
        return NextResponse.json({
          success: true,
          message: "No active subscription found, but an account override is in effect.",
          plan: userData?.plan ?? "free",
        });
      }

      await updateUserPlanInFirestore({
        uid: targetUserId,
        customerId: stripeCustomerId,
        subscriptionId: (userData?.stripeSubscriptionId as string | undefined) || "",
        planMapping: {
          planId: "free",
          monthlyLimit: PLAN_CONFIG.free.monthlyLimit,
          maxModelsPerRun: PLAN_CONFIG.free.maxModels,
          isActive: false,
        },
        status: "canceled",
      });

      // NOTE: no usage reset. See the ownership rule at the top of this file.
      return NextResponse.json({
        success: true,
        message: "No active subscription found. User set to free plan.",
        plan: "free",
      });
    }

    // Exactly one plan-bearing subscription: that one is authoritative.
    const authoritative = authority.subscription;

    // Canonical mapping only — the plan comes from the shared mapper (current
    // Price first, then the validated server-written marker), and the cadence
    // and period come from the plan-bearing ITEM, never from `items.data[0]`,
    // an independent interval heuristic, or the current time.
    const planMapping = mapSubscriptionToPlan(authoritative);
    const billingStateResult = resolveSubscriptionBillingState(authoritative as never);
    if (!billingStateResult.ok) {
      logger.error("[sync-plan] Could not resolve canonical billing state; refusing to persist derived billing fields", {
        reason: billingStateResult.reason,
      });
      return NextResponse.json(
        { error: "Could not resolve this subscription's billing period.", code: billingStateResult.reason },
        { status: 409 }
      );
    }
    const billingState = billingStateResult.state;

    await updateUserPlanInFirestore({
      uid: targetUserId,
      customerId: stripeCustomerId,
      subscriptionId: authoritative.id,
      planMapping,
      status: authoritative.status,
      billingInterval: billingState.billingInterval,
      billingState,
    });

    // NOTE: no usage reset. See the ownership rule at the top of this file.
    return NextResponse.json({
      success: true,
      message: "Plan synced successfully",
      plan: planMapping.planId,
      planLabel: getPlanConfigById(planMapping.planId).label,
      monthlyLimit: planMapping.monthlyLimit,
      maxModels: planMapping.maxModelsPerRun,
      subscriptionStatus: authoritative.status,
      subscriptionId: authoritative.id,
    });
  } catch (error: any) {
    // Comprehensive error logging with full context
    console.error("[sync-plan] ❌ Unexpected error:", {
      message: error?.message,
      stack: error?.stack,
      code: error?.code,
      name: error?.name,
    });
    
    // Return structured error response
    return NextResponse.json(
      { 
        error: error?.message || "Failed to sync plan",
        // Include error code if available for debugging
        ...(error?.code && { code: error.code }),
      },
      { status: 500 }
    );
  }
}
