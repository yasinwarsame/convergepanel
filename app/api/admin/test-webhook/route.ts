/**
 * Test Webhook Endpoint
 * 
 * This endpoint allows manually testing the webhook logic for a specific subscription.
 * Useful for debugging when webhooks aren't firing or Firestore isn't updating.
 * 
 * Requires admin authentication.
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { adminDb } from "@/lib/firebase/admin";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { handleSubscriptionChange } from "@/app/api/stripe/webhook/route";
import Stripe from "stripe";

export async function POST(req: NextRequest) {
  try {
    // Verify authentication
    const auth = await verifySessionCookie(req);
    if (!auth) {
      return NextResponse.json(
        { error: "Unauthorized. Please sign in." },
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

    console.log("[test-webhook] Processing subscription:", {
      subscriptionId: subscription.id,
      customerId: subscription.customer,
      status: subscription.status,
      priceId: subscription.items.data[0]?.price.id,
    });

    // Process the subscription using the webhook handler
    await handleSubscriptionChange(subscription);

    return NextResponse.json({
      success: true,
      message: "Webhook logic executed successfully",
      subscriptionId: subscription.id,
      customerId: subscription.customer,
      status: subscription.status,
    });
  } catch (error: any) {
    console.error("[test-webhook] Error:", error);
    return NextResponse.json(
      { error: "Failed to test webhook" },
      { status: 500 }
    );
  }
}
