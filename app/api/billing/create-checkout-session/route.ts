/**
 * Create Stripe Checkout Session
 * 
 * Creates a Stripe checkout session for subscription signup.
 * Supports monthly and annual billing intervals.
 * User must be authenticated to access this route.
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import type { BillingInterval } from "@/lib/plans";
import { resolveApprovedPriceId } from "@/lib/billing/approvedPrice";
import { verifyStripePriceCadence } from "@/lib/billing/stripePriceCadence";
import { adminDb } from "@/lib/firebase/admin";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { STRIPE_PRICE_3_MODELS, STRIPE_3_MODELS_ANNUAL, STRIPE_PRICE_5_MODELS, STRIPE_5_MODELS_ANNUAL } from "@/lib/env";
import { getPostHogClient } from "@/lib/posthog-server";
import { logger } from "@/lib/logger";
import Stripe from "stripe";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Auth Identity Consistency Remediation, Step 7 — resolves via the
    // shared, hardened resolver (considers cookie AND bearer, fails
    // closed on a confirmed identity mismatch) rather than this route's
    // own duplicated cookie-first logic. `userEmail` is now always
    // sourced from Firestore (matching what the cookie-authenticated path
    // already did) rather than occasionally from the bearer token's own
    // claims — functionally equivalent for Stripe checkout purposes,
    // since `users/{uid}.email` is kept in sync with the Firebase Auth
    // account at every login.
    const identity = await resolveRequestIdentity(req);
    if (identity.status !== "authenticated") {
      logIdentityResolutionFailure({ route: "POST /api/billing/create-checkout-session", method: "POST", failureCategory: identity.reason });
      return NextResponse.json(
        { error: "Unauthorized. Please sign in." },
        { status: 401 }
      );
    }
    const uid = identity.uid;
    let userEmail: string | undefined;
    if (adminDb) {
      const userDoc = await adminDb.collection("users").doc(uid).get();
      userEmail = userDoc.data()?.email;
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
    // Phase BILLING-ANNUAL-C1 — the client supplies ONLY a canonical plan key
    // and cadence (validated above). The approved Price ID is resolved
    // server-side from configuration; any client-supplied priceId/amount/
    // currency field in the body is ignored by construction.
    const approved = resolveApprovedPriceId(planId, interval as BillingInterval);
    if (!approved.ok) {
      logger.error("[create-checkout-session] Approved price resolution failed", { planId, interval, reason: approved.reason });
      return NextResponse.json(
        {
          error: approved.reason === "not_configured"
            ? `Stripe price ID not configured for ${planId} plan (${interval} billing). Check your .env.local: STRIPE_PRICE_3_MODELS, STRIPE_PRICE_5_MODELS, STRIPE_3_MODELS_ANNUAL, STRIPE_5_MODELS_ANNUAL.`
            : "Billing configuration error. This plan cannot be purchased right now. Please contact support.",
        },
        { status: 500 }
      );
    }
    const priceId = approved.priceId;

    if (!stripe) {
      return NextResponse.json(
        { error: "Stripe is not configured." },
        { status: 500 }
      );
    }

    // Phase BILLING-ANNUAL-C1 — FAIL CLOSED before ANY Stripe write: the
    // configured Price must really bill on the cadence the user selected.
    // A "$X / year" plan whose Price recurs monthly (the incident that
    // motivated this guard) is refused here instead of being sold.
    const cadence = await verifyStripePriceCadence(stripe, priceId, interval as BillingInterval);
    if (!cadence.ok) {
      logger.error("[create-checkout-session] REFUSED — configured Stripe Price cadence does not match the selected billing interval", {
        planId,
        interval,
        reason: cadence.reason,
        actualInterval: cadence.actualInterval ?? null,
        actualIntervalCount: cadence.actualIntervalCount ?? null,
      });
      return NextResponse.json(
        { error: "Billing configuration error. This plan cannot be purchased right now. Please contact support." },
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

        try {
          const ph = getPostHogClient();
          ph.capture({
            distinctId: uid,
            event: "subscription_upgraded",
            properties: {
              plan: planId,
              interval,
              subscription_id: updatedSubscription.id,
            },
          });
          await ph.flush();
        } catch (phErr) {
          logger.warn("[create-checkout-session] PostHog capture failed (non-critical)", { error: phErr });
        }

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

