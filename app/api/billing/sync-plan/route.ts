/**
 * Manual Plan Sync Endpoint
 * 
 * This endpoint allows manually syncing a user's plan from their Stripe subscription.
 * Useful for debugging or fixing cases where the webhook didn't fire or failed.
 * 
 * Requires authentication and admin privileges (or the user can sync their own plan).
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { adminDb, firebaseAdmin } from "@/lib/firebase/admin";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { getPlanIdFromPriceId, getPlanConfigById, BillingPlanId, STRIPE_PRICE_TO_PLAN } from "@/lib/billing/planConfig";
import { BillingInterval } from "@/lib/plans";
import { resetUsageForNewPlan } from "@/lib/stripe/usage";
import Stripe from "stripe";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Authenticate user - same pattern as /api/user/usage
    // Try session cookie first, then fallback to Bearer token
    let uid: string;
    try {
      const auth = await verifySessionCookie(req);
      
      if (auth) {
        uid = auth.uid;
        console.log("[sync-plan] Authenticated via session cookie:", uid);
      } else {
        // Fallback to Bearer token (for client-side requests)
        const authHeader = req.headers.get("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          console.error("[sync-plan] ❌ No ID token provided - missing Authorization header");
          return NextResponse.json(
            { error: "Unauthorized. Please sign in." },
            { status: 401 }
          );
        }
        const token = authHeader.split("Bearer ")[1];
        if (!token) {
          console.error("[sync-plan] ❌ No ID token provided - empty token");
          return NextResponse.json(
            { error: "Unauthorized. Please sign in." },
            { status: 401 }
          );
        }
        const decodedToken = await verifyIdToken(token);
        uid = decodedToken.uid;
        console.log("[sync-plan] Authenticated via Bearer token:", uid);
      }
    } catch (authError: any) {
      // Log specific auth error details
      console.error("[sync-plan] ❌ Authentication error:", {
        message: authError?.message,
        code: authError?.code,
        cause: authError?.cause?.message,
      });
      
      // Check if this is a token verification error
      const isTokenError = 
        authError?.message === "INVALID_ID_TOKEN" ||
        authError?.message?.includes("ID token") ||
        authError?.message?.includes("aud") ||
        authError?.message?.includes("audience") ||
        authError?.message?.includes("expired") ||
        authError?.code === "auth/argument-error" ||
        authError?.code === "auth/id-token-expired" ||
        authError?.code === "auth/id-token-revoked";
      
      return NextResponse.json(
        { 
          error: isTokenError 
            ? "Authentication failed. Please sign in again."
            : "Unauthorized. Please sign in." 
        },
        { status: 401 }
      );
    }

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

    // Get customer from Stripe
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (customer.deleted || typeof customer === "string") {
      return NextResponse.json(
        { error: "Stripe customer not found or deleted" },
        { status: 404 }
      );
    }

    // Get active subscriptions for this customer
    console.log("[sync-plan] Fetching subscriptions for customer:", stripeCustomerId);
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all", // Get all subscriptions to find active ones
      limit: 10,
    });

    console.log("[sync-plan] Found subscriptions:", {
      count: subscriptions.data.length,
      subscriptions: subscriptions.data.map(sub => ({
        id: sub.id,
        status: sub.status,
        priceId: sub.items.data[0]?.price.id,
      })),
    });

    // Find the most recent active subscription
    // Sort by created date (most recent first) and find active one
    const sortedSubscriptions = subscriptions.data.sort((a, b) => b.created - a.created);
    const activeSubscription = sortedSubscriptions.find(
      (sub) => sub.status === "active" || sub.status === "trialing" || sub.status === "past_due"
    );
    
    if (activeSubscription) {
      console.log("[sync-plan] Found active subscription:", {
        id: activeSubscription.id,
        status: activeSubscription.status,
        priceId: activeSubscription.items.data[0]?.price.id,
        created: new Date(activeSubscription.created * 1000).toISOString(),
      });
    }

    if (!activeSubscription) {
      // No active subscription - set to free plan
      const freeConfig = getPlanConfigById("free");
      await adminDb.collection("users").doc(targetUserId).set(
        {
          plan: "free",
          planLabel: freeConfig.label,
          maxModels: freeConfig.maxModels,
          monthlyLimit: freeConfig.monthlyLimit,
          maxModelsPerRun: freeConfig.maxModels,
          subscriptionStatus: "none",
          stripeSubscriptionId: firebaseAdmin.firestore.FieldValue.delete(),
          billingInterval: null,
          planUpdatedAt: firebaseAdmin.firestore.Timestamp.now(),
        },
        { merge: true }
      );

      await resetUsageForNewPlan(targetUserId, "free");

      return NextResponse.json({
        success: true,
        message: "No active subscription found. User set to free plan.",
        plan: "free",
      });
    }

    // Get price ID from subscription
    const priceId = activeSubscription.items.data[0]?.price.id;
    if (!priceId) {
      return NextResponse.json(
        { error: "Subscription has no price ID" },
        { status: 400 }
      );
    }

    // Map price ID to plan ID
    const planId = getPlanIdFromPriceId(priceId);
    if (!planId) {
      return NextResponse.json(
        {
          error: "Could not map price ID to plan",
          priceId,
          availableMappings: Object.keys(STRIPE_PRICE_TO_PLAN),
          configuredMappings: STRIPE_PRICE_TO_PLAN,
        },
        { status: 400 }
      );
    }

    // Get plan configuration
    const planConfig = getPlanConfigById(planId);

    // Determine billing interval
    const isAnnual = activeSubscription.items.data[0]?.price.recurring?.interval === "year";
    const billingInterval: BillingInterval = isAnnual ? "year" : "month";

    // Update Firestore
    const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    const updateData = {
      plan: planId,
      planLabel: planConfig.label,
      maxModels: planConfig.maxModels,
      monthlyLimit: planConfig.monthlyLimit,
      maxModelsPerRun: planConfig.maxModels,
      subscriptionStatus: activeSubscription.status,
      stripeSubscriptionId: activeSubscription.id,
      billingInterval: billingInterval,
      billingCycleStart: new Date().toISOString(),
      usageMonth: currentMonth,
      planUpdatedAt: firebaseAdmin.firestore.Timestamp.now(),
      updatedAt: firebaseAdmin.firestore.Timestamp.now(),
    };
    
    console.log("[sync-plan] Updating Firestore for user:", targetUserId, {
      ...updateData,
      planUpdatedAt: "[Timestamp]",
      updatedAt: "[Timestamp]",
    });
    
    try {
      await adminDb.collection("users").doc(targetUserId).set(updateData, { merge: true });
      console.log("[sync-plan] ✅ Firestore update successful");
      
      // Verify the update
      const userDocAfter = await adminDb.collection("users").doc(targetUserId).get();
      if (userDocAfter.exists) {
        const userDataAfter = userDocAfter.data();
        console.log("[sync-plan] ✅ Verified Firestore update:", {
          plan: userDataAfter?.plan,
          monthlyLimit: userDataAfter?.monthlyLimit,
          maxModelsPerRun: userDataAfter?.maxModelsPerRun,
          stripeSubscriptionId: userDataAfter?.stripeSubscriptionId,
          subscriptionStatus: userDataAfter?.subscriptionStatus,
        });
      }
    } catch (firestoreError: any) {
      console.error("[sync-plan] ❌ Firestore update failed:", {
        message: firestoreError?.message,
        stack: firestoreError?.stack,
        code: firestoreError?.code,
      });
      return NextResponse.json(
        { error: `Failed to update Firestore: ${firestoreError.message}` },
        { status: 500 }
      );
    }

    // Reset usage counters
    await resetUsageForNewPlan(targetUserId, planId, billingInterval);

    return NextResponse.json({
      success: true,
      message: "Plan synced successfully",
      plan: planId,
      planLabel: planConfig.label,
      monthlyLimit: planConfig.monthlyLimit,
      maxModels: planConfig.maxModels,
      subscriptionStatus: activeSubscription.status,
      subscriptionId: activeSubscription.id,
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
