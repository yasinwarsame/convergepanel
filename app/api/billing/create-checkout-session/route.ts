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
import {
  reportIncompleteAuthorityEnumeration,
  reportMultipleEntitlementSubscriptions,
  resolveCustomerSubscriptionAuthority,
} from "@/lib/billing/customerSubscriptionAuthority";
import { selectPlanBearingItem } from "@/lib/billing/subscriptionBillingState";
import { isTransientDependencyError } from "@/lib/billing/reconciliationOutcome";
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
    if (adminDb) {
      const userDoc = await adminDb.collection("users").doc(uid).get();
      customerId = userDoc.data()?.stripeCustomerId;
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

    // Phase BILLING-PR145-C8.1 — A PURCHASE MUST NEVER CREATE A SECOND
    // PLAN-BEARING SUBSCRIPTION.
    //
    // The old rule updated a subscription in place only when it was `active`
    // AND the target was `full` AND the current price was a LITE price.
    // Everything else fell through to `checkout.sessions.create`, and nothing
    // cancels the previous subscription — so Full Monthly -> Full Annual, the
    // exact cadence change this incident is about, left the customer with TWO
    // live subscriptions. Every automatic writer then correctly refuses that
    // ambiguity, so the plan they just paid for never activated.
    //
    // The fix belongs HERE, at the path that CREATES the ambiguity, not in the
    // reconciliation that refuses it. Authority comes from the same resolver
    // the webhook, request-time reconciliation and self-serve sync use: the
    // customer's whole Stripe subscription set, enumerated to exhaustion. That
    // also closes the drift case, where Firestore had no subscription id and
    // this route therefore believed a live subscriber was a new customer.
    let authority;
    try {
      authority = await resolveCustomerSubscriptionAuthority({ stripe, verifiedCustomerId: customerId });
    } catch (dependencyError) {
      if (isTransientDependencyError(dependencyError)) {
        // We could not establish whether a subscription already exists.
        // Selling one now is how duplicates are made.
        logger.warn("[create-checkout-session] Could not establish the customer's subscription set; refusing to start checkout", {
          dependency: dependencyError.dependency,
          operation: dependencyError.operation,
        });
        return NextResponse.json(
          { error: "We couldn't reach Stripe to check your current subscription. Please try again in a moment." },
          { status: 503 }
        );
      }
      throw dependencyError;
    }

    if (authority.kind === "multiple_entitlements") {
      // Already ambiguous before we started. Adding a third is not a fix.
      reportMultipleEntitlementSubscriptions({
        path: "checkout_session_create",
        stripeCustomerId: customerId,
        uid,
        storedSubscriptionId: null,
        candidateSubscriptionIds: authority.subscriptionIds,
        candidateCount: authority.count,
      });
      return NextResponse.json(
        {
          error: "Your account has more than one active subscription, so we can't safely change your plan. Please contact support.",
          code: "multiple_entitlement_subscriptions",
        },
        { status: 409 }
      );
    }

    if (authority.kind === "enumeration_incomplete") {
      // We stopped looking before Stripe ran out. That is not proof the
      // customer has no subscription, so it cannot authorise selling another.
      reportIncompleteAuthorityEnumeration({
        path: "checkout_session_create",
        stripeCustomerId: customerId,
        uid,
        storedSubscriptionId: null,
        reason: authority.reason,
        pagesFetched: authority.pagesFetched,
      });
      return NextResponse.json(
        { error: "We couldn't finish checking your subscriptions, so we've made no changes. Please contact support.", code: "authority_enumeration_incomplete" },
        { status: 409 }
      );
    }

    if (authority.kind === "customer_missing" || authority.kind === "unverified_customer") {
      logger.error("[create-checkout-session] Stripe customer could not be verified; refusing to start checkout");
      return NextResponse.json(
        { error: "Your Stripe customer record could not be verified. Please contact support." },
        { status: 409 }
      );
    }

    if (authority.kind === "exactly_one") {
      // EXACTLY ONE existing plan-bearing subscription — change it in place.
      // Terminal subscriptions (canceled, incomplete_expired, unpaid) are not
      // plan-bearing, so a customer whose only subscription is dead still gets
      // an ordinary new checkout below. `trialing` and `past_due` ARE
      // plan-bearing, which is what the old `status === "active"` condition got
      // wrong: both were sold a second subscription.
      const current = authority.subscription;
      const planItem = selectPlanBearingItem(current);
      if (!planItem.ok) {
        // Cannot tell which item bills. Never guess, and never sell around it.
        logger.error("[create-checkout-session] Cannot identify the plan-bearing item on the existing subscription; refusing to change plan", {
          subscriptionId: current.id,
          reason: planItem.reason,
        });
        return NextResponse.json(
          { error: "We couldn't safely identify your current plan. Please contact support.", code: planItem.reason },
          { status: 409 }
        );
      }

      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;

      // Already on the requested Price: nothing to do. No Stripe mutation, no
      // session, no extra item.
      if (planItem.item.price?.id === priceId) {
        console.log("[create-checkout-session] Subscription already on the requested price; no change needed", {
          subscriptionId: current.id,
          priceId,
        });
        return NextResponse.json({ url: `${baseUrl}/billing?success=true&upgraded=true`, upgraded: true, unchanged: true });
      }

      try {
        // The ITEM ID is mandatory. Updating with a bare price ADDS an item
        // rather than replacing the existing one, which would produce a
        // two-item subscription — the other shape the resolver fails closed on.
        // Stripe prorates, and an interval change resets the billing cycle.
        const updatedSubscription = await stripe.subscriptions.update(current.id, {
          items: [{
            // The ITEM ID is what makes this a REPLACEMENT. `quantity` is
            // deliberately omitted: Stripe keeps the item's existing quantity,
            // so a seat count is preserved rather than silently forced to 1.
            id: planItem.item.id,
            price: priceId,
          }],
          metadata: {
            ...current.metadata,
            firebaseUid: uid,
            email: userEmail || "",
            targetPlan: planId,
          },
          proration_behavior: "always_invoice",
        });

        console.log("[create-checkout-session] ✅ Subscription changed in place:", {
          subscriptionId: updatedSubscription.id,
          newPriceId: updatedSubscription.items.data[0]?.price.id,
          status: updatedSubscription.status,
          interval,
        });

        try {
          const ph = getPostHogClient();
          ph.capture({
            distinctId: uid,
            event: "subscription_upgraded",
            properties: { plan: planId, interval, subscription_id: updatedSubscription.id },
          });
          await ph.flush();
        } catch (phErr) {
          logger.warn("[create-checkout-session] PostHog capture failed (non-critical)", { error: phErr });
        }

        // Redirect to billing page - reconciliation will update Firestore
        return NextResponse.json({ url: `${baseUrl}/billing?success=true&upgraded=true`, upgraded: true });
      } catch (upgradeError: any) {
        // DELIBERATELY NO FALL-THROUGH. The old code opened a checkout session
        // when the in-place update failed, which recreated the duplicate
        // subscription this phase exists to prevent — from a transient error.
        logger.error("[create-checkout-session] In-place subscription change failed; refusing to create a second subscription", {
          subscriptionId: current.id,
          error: upgradeError?.message,
        });
        return NextResponse.json(
          { error: "We couldn't change your plan just now and have made no changes. Please try again or contact support." },
          { status: 502 }
        );
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

