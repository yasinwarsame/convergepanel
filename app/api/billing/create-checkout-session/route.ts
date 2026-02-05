/**
 * Create Stripe Checkout Session
 * 
 * Creates a Stripe checkout session for subscription signup.
 * Supports monthly and annual billing intervals.
 * User must be authenticated to access this route.
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { getStripePriceId, PlanId, BillingInterval } from "@/lib/plans";
import { adminDb } from "@/lib/firebase/admin";
import { verifyIdToken } from "@/lib/firebase/auth";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { STRIPE_PRICE_3_MODELS, STRIPE_3_MODELS_ANNUAL, STRIPE_PRICE_5_MODELS, STRIPE_5_MODELS_ANNUAL } from "@/lib/env";
import Stripe from "stripe";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Verify authentication (try session cookie first, then Bearer token)
    const auth = await verifySessionCookie(req);
    let uid: string;
    let userEmail: string | undefined;

    if (auth) {
      uid = auth.uid;
      // Get email from Firestore if needed
      if (adminDb) {
        const userDoc = await adminDb.collection("users").doc(uid).get();
        userEmail = userDoc.data()?.email;
      }
    } else {
      // Fallback to Bearer token
      const authHeader = req.headers.get("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return NextResponse.json(
          { error: "Unauthorized. Please sign in." },
          { status: 401 }
        );
      }
      const token = authHeader.split("Bearer ")[1];
      const decodedToken = await verifyIdToken(token);
      uid = decodedToken.uid;
      userEmail = decodedToken.email;
    }

    // Parse request body
    const body = await req.json();
    const { planId, interval } = body;

    if (!planId || (planId !== "lite" && planId !== "full")) {
      return NextResponse.json(
        { error: "Invalid plan. Must be 'lite' or 'full'." },
        { status: 400 }
      );
    }

    if (!interval || (interval !== "month" && interval !== "year")) {
      return NextResponse.json(
        { error: "Invalid interval. Must be 'month' or 'year'." },
        { status: 400 }
      );
    }

    // Get Stripe price ID for this plan and interval
    // Use a helper function that provides better error messages
    let priceId: string | undefined;
    try {
      priceId = getStripePriceId(planId as PlanId, interval as BillingInterval);
    } catch (err: any) {
      console.error("[create-checkout-session] Price ID lookup error:", err);
      return NextResponse.json(
        { 
          error: err.message || `Stripe price ID not configured for ${planId} plan (${interval} billing). Check your .env.local: STRIPE_PRICE_3_MODELS, STRIPE_PRICE_5_MODELS, STRIPE_3_MODELS_ANNUAL, STRIPE_5_MODELS_ANNUAL.` 
        },
        { status: 500 }
      );
    }

    if (!priceId) {
      return NextResponse.json(
        { 
          error: `Stripe price ID not configured for ${planId} plan (${interval} billing). Check your .env.local: STRIPE_PRICE_3_MODELS, STRIPE_PRICE_5_MODELS, STRIPE_3_MODELS_ANNUAL, STRIPE_5_MODELS_ANNUAL.` 
        },
        { status: 500 }
      );
    }

    if (!stripe) {
      return NextResponse.json(
        { error: "Stripe is not configured." },
        { status: 500 }
      );
    }

    // Get or create Stripe customer
    let customerId: string | undefined;
    let existingSubscriptionId: string | undefined;
    if (adminDb) {
      const userDoc = await adminDb.collection("users").doc(uid).get();
      const userData = userDoc.data();
      customerId = userData?.stripeCustomerId;
      existingSubscriptionId = userData?.stripeSubscriptionId;
    }

    // Get or create Stripe customer
    let customer: Stripe.Customer;
    if (!customerId) {
      if (!userEmail) {
        return NextResponse.json(
          { error: "User email not found. Please update your profile." },
          { status: 400 }
        );
      }

      // Create new customer with metadata
      customer = await stripe.customers.create({
        email: userEmail,
        metadata: {
          firebaseUid: uid,
          email: userEmail,
        },
      });

      customerId = customer.id;

      // Save customer ID to Firestore
      if (adminDb) {
        await adminDb.collection("users").doc(uid).update({
          stripeCustomerId: customerId,
        });
      }
    } else {
      // Update existing customer metadata to ensure it has firebaseUid
      try {
        const existingCustomer = await stripe.customers.retrieve(customerId);
        if (existingCustomer && !existingCustomer.deleted && typeof existingCustomer !== "string") {
          const needsUpdate = !existingCustomer.metadata?.firebaseUid || existingCustomer.metadata?.email !== userEmail;
          if (needsUpdate) {
            await stripe.customers.update(customerId, {
              metadata: {
                ...existingCustomer.metadata,
                firebaseUid: uid,
                email: userEmail || existingCustomer.email || "",
              },
            });
          }
        }
      } catch (err) {
        console.error("[create-checkout-session] Failed to update customer metadata:", err);
      }
    }

    // Check if user has an existing active subscription for upgrade scenario
    // If upgrading from 2-model to 4-model, update the existing subscription instead of creating new one
    let existingSubscription: Stripe.Subscription | null = null;
    if (existingSubscriptionId) {
      try {
        existingSubscription = await stripe.subscriptions.retrieve(existingSubscriptionId);
        console.log("[create-checkout-session] Found existing subscription:", {
          subscriptionId: existingSubscription.id,
          status: existingSubscription.status,
          currentPriceId: existingSubscription.items.data[0]?.price.id,
          targetPriceId: priceId,
        });
      } catch (err) {
        console.warn("[create-checkout-session] Could not retrieve existing subscription:", err);
        existingSubscription = null;
      }
    }

    // UPGRADE LOGIC: If user has an active subscription and is upgrading (lite -> full), 
    // update the existing subscription instead of creating a new checkout session.
    // This uses Stripe's proration to handle the upgrade smoothly.
    // 
    // Upgrade scenarios handled:
    // - lite monthly -> full monthly (same interval)
    // - lite yearly -> full yearly (same interval)
    // - lite monthly -> full yearly (cross-interval upgrade)
    // - lite yearly -> full monthly (cross-interval upgrade, switches to monthly billing)
    //
    // Note: Stripe will automatically prorate charges when changing prices/intervals.
    const currentPriceId = existingSubscription?.items.data[0]?.price.id;
    const isLitePlan = currentPriceId && (
      currentPriceId === STRIPE_PRICE_3_MODELS || 
      currentPriceId === STRIPE_3_MODELS_ANNUAL
    );
    const isUpgrade = existingSubscription && 
                      existingSubscription.status === "active" &&
                      planId === "full" &&
                      isLitePlan;
    
    if (isUpgrade && existingSubscription) {
      console.log("[create-checkout-session] Upgrading existing subscription:", {
        subscriptionId: existingSubscription.id,
        from: existingSubscription.items.data[0]?.price.id,
        to: priceId,
        interval,
      });

      try {
        // Update the subscription to the new price
        // Stripe will automatically prorate the charges
        const updatedSubscription = await stripe.subscriptions.update(existingSubscription.id, {
          items: [{
            id: existingSubscription.items.data[0].id,
            price: priceId,
          }],
          metadata: {
            ...existingSubscription.metadata,
            firebaseUid: uid,
            email: userEmail || "",
            targetPlan: planId,
          },
          proration_behavior: "always_invoice", // Prorate and invoice immediately
        });

        console.log("[create-checkout-session] ✅ Subscription upgraded successfully:", {
          subscriptionId: updatedSubscription.id,
          newPriceId: updatedSubscription.items.data[0]?.price.id,
          status: updatedSubscription.status,
        });

        // Redirect to billing page - webhook will handle Firestore update
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
        return NextResponse.json({ 
          url: `${baseUrl}/billing?success=true&upgraded=true`,
          upgraded: true,
        });
      } catch (upgradeError: any) {
        console.error("[create-checkout-session] Failed to upgrade subscription:", upgradeError);
        // Fall through to create new checkout session as fallback
        // This handles edge cases where subscription update fails
      }
    }

    // Create checkout session (for new subscriptions or when upgrade fails)
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/billing?canceled=true`,
      metadata: {
        firebaseUid: uid,
        email: userEmail || "",
        targetPlan: planId,
      },
      subscription_data: {
        metadata: {
          firebaseUid: uid,
          email: userEmail || "",
          targetPlan: planId,
        },
      },
    });

    console.log("[create-checkout-session] Created checkout session:", {
      sessionId: session.id,
      planId,
      interval,
      priceId,
      isUpgrade: !!isUpgrade,
    });

    return NextResponse.json({ url: session.url });
  } catch (error: any) {
    console.error("[create-checkout-session] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create checkout session." },
      { status: 500 }
    );
  }
}

