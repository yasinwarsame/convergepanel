/**
 * Admin Endpoint: Sync Subscription from Stripe
 * 
 * This endpoint manually processes a Stripe subscription and updates Firestore.
 * Useful for fixing cases where the webhook didn't fire or failed.
 * 
 * Requires admin authentication.
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { adminDb, firebaseAdmin } from "@/lib/firebase/admin";
import { requireAdminApiAccess } from "@/lib/firebase/auth-helpers";
import { getPlanIdFromPriceId, getPlanConfigById } from "@/lib/billing/planConfig";
import { BillingInterval } from "@/lib/plans";
import { resetUsageForNewPlan } from "@/lib/stripe/usage";
import Stripe from "stripe";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Verify admin authentication — session cookie alone is not sufficient
    const auth = await requireAdminApiAccess(req);
    if (!auth) {
      return NextResponse.json(
        { error: "Unauthorized. Admin access required." },
        { status: 401 }
      );
    }

    if (!adminDb) {
      return NextResponse.json(
        { error: "Database not available" },
        { status: 500 }
      );
    }

    if (!stripe) {
      return NextResponse.json(
        { error: "Stripe not configured" },
        { status: 500 }
      );
    }

    const body = await req.json();
    const { subscriptionId, customerId } = body;

    if (!subscriptionId && !customerId) {
      return NextResponse.json(
        { error: "Either subscriptionId or customerId is required" },
        { status: 400 }
      );
    }

    let subscription: Stripe.Subscription;

    if (subscriptionId) {
      // Get subscription by ID
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } else if (customerId) {
      // Get the most recent active subscription for this customer
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 10,
      });

      if (subscriptions.data.length === 0) {
        return NextResponse.json(
          { error: "No subscriptions found for this customer" },
          { status: 404 }
        );
      }

      // Find the most recent active subscription, or use the first one
      subscription = subscriptions.data.find(
        (sub) => sub.status === "active" || sub.status === "trialing"
      ) || subscriptions.data[0];
    } else {
      return NextResponse.json(
        { error: "Either subscriptionId or customerId is required" },
        { status: 400 }
      );
    }

    // Process the subscription using the same logic as the webhook
    const customerIdFromSub = subscription.customer as string;
    const priceId = subscription.items.data[0]?.price.id;

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
        { error: "Could not map price ID to plan", priceId },
        { status: 400 }
      );
    }

    // Find user by stripeCustomerId
    const usersSnapshot = await adminDb.collection("users")
      .where("stripeCustomerId", "==", customerIdFromSub)
      .limit(1)
      .get();

    if (usersSnapshot.empty) {
      // Try to find by subscription metadata
      const firebaseUid = subscription.metadata?.firebaseUid || subscription.metadata?.firebase_uid;
      if (firebaseUid) {
        const userDoc = await adminDb.collection("users").doc(firebaseUid).get();
        if (userDoc.exists) {
          // Update the user
          const planConfig = getPlanConfigById(planId);
          const isAnnual = subscription.items.data[0]?.price.recurring?.interval === "year";
          const billingInterval: BillingInterval = isAnnual ? "year" : "month";

          await adminDb.collection("users").doc(firebaseUid).set(
            {
              plan: planId,
              planLabel: planConfig.label,
              maxModels: planConfig.maxModels,
              monthlyLimit: planConfig.monthlyLimit,
              maxModelsPerRun: planConfig.maxModels,
              subscriptionStatus: subscription.status,
              stripeCustomerId: customerIdFromSub,
              stripeSubscriptionId: subscription.id,
              billingInterval: billingInterval,
              billingCycleStart: new Date().toISOString(),
              planUpdatedAt: firebaseAdmin.firestore.Timestamp.now(),
            },
            { merge: true }
          );

          await resetUsageForNewPlan(firebaseUid, planId, billingInterval);

          return NextResponse.json({
            success: true,
            message: "Subscription synced successfully",
            userId: firebaseUid,
            plan: planId,
            subscriptionId: subscription.id,
          });
        }
      }

      return NextResponse.json(
        { error: "User not found for this subscription" },
        { status: 404 }
      );
    }

    const userDoc = usersSnapshot.docs[0];
    const userId = userDoc.id;

    // Get plan configuration
    const planConfig = getPlanConfigById(planId);

    // Determine billing interval
    const isAnnual = subscription.items.data[0]?.price.recurring?.interval === "year";
    const billingInterval: BillingInterval = isAnnual ? "year" : "month";

    // Update Firestore
    await adminDb.collection("users").doc(userId).set(
      {
        plan: planId,
        planLabel: planConfig.label,
        maxModels: planConfig.maxModels,
        monthlyLimit: planConfig.monthlyLimit,
        maxModelsPerRun: planConfig.maxModels,
        subscriptionStatus: subscription.status,
        stripeSubscriptionId: subscription.id,
        billingInterval: billingInterval,
        billingCycleStart: new Date().toISOString(),
        planUpdatedAt: firebaseAdmin.firestore.Timestamp.now(),
      },
      { merge: true }
    );

    // Reset usage counters
    await resetUsageForNewPlan(userId, planId, billingInterval);

    return NextResponse.json({
      success: true,
      message: "Subscription synced successfully",
      userId: userId,
      plan: planId,
      planLabel: planConfig.label,
      monthlyLimit: planConfig.monthlyLimit,
      maxModels: planConfig.maxModels,
      subscriptionStatus: subscription.status,
      subscriptionId: subscription.id,
    });
  } catch (error: any) {
    console.error("[sync-subscription] Error:", error);
    return NextResponse.json(
      { error: "Failed to sync subscription" },
      { status: 500 }
    );
  }
}
