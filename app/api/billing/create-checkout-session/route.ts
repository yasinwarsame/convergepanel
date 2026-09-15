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
} from "@/lib/billing/customerSubscriptionAuthority";
import { selectPlanBearingItem } from "@/lib/billing/subscriptionBillingState";
import { resolveUidCustomerAuthority } from "@/lib/billing/uidCustomerAuthority";
import { withCheckoutIdentityLease, bindStripeCustomerIfAbsent, isCheckoutLeaseStillHeld, type LeaseOutcome } from "@/lib/billing/checkoutIdentityLease";
import { resolvePendingCheckoutAuthority } from "@/lib/billing/pendingCheckoutAuthority";
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
    if (!adminDb) {
      logger.error("[create-checkout-session] Firestore unavailable; refusing to start checkout without a billing identity store");
      return NextResponse.json({ error: "Billing is temporarily unavailable. Please try again in a moment." }, { status: 503 });
    }
    const db = adminDb;
    const stripeClient = stripe;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;

    // Phase BILLING-INTEGRITY-R5 — fail-closed side-effect order:
    // authenticate → trusted uid → lease → discover EVERY customer of this uid
    // (even with a stored binding) → validate the stored customer → enumerate
    // subscriptions → derive cross-customer authority → refuse ambiguity →
    // only then create/reuse a customer and perform the existing mutation.
    let leased: LeaseOutcome<NextResponse>;
    try {
      leased = await withCheckoutIdentityLease(uid, async (lease): Promise<NextResponse> => {
        const userSnap = await db.collection("users").doc(uid).get();
        const storedCustomerId = (userSnap.data()?.stripeCustomerId as string | undefined) || null;

        const authority = await resolveUidCustomerAuthority({ stripe: stripeClient, uid, storedCustomerId });

        switch (authority.kind) {
          case "invalid_uid":
            logger.error("[create-checkout-session] Authenticated uid is not a plausible billing identity; refusing");
            return NextResponse.json({ error: "Your account could not be verified for billing. Please contact support.", code: "billing_identity_invalid" }, { status: 409 });
          case "stored_customer_missing":
            logger.error("[create-checkout-session] Stored Stripe customer is missing or deleted; refusing to start checkout", { storedCustomerId });
            return NextResponse.json({ error: "Your Stripe customer record could not be verified. Please contact support.", code: "stored_customer_missing" }, { status: 409 });
          case "stored_customer_mismatch":
            logger.error("[create-checkout-session] Stored Stripe customer belongs to a different uid; refusing to start checkout", { storedCustomerId });
            return NextResponse.json({ error: "Your billing identity could not be verified. Please contact support.", code: "billing_identity_mismatch" }, { status: 409 });
          case "stored_customer_unmarked":
            // R5-C1: never auto-claim an unmarked customer in a shared Stripe account.
            logger.error("[create-checkout-session] Stored Stripe customer carries no uid ownership marker; refusing to start checkout", { storedCustomerId });
            return NextResponse.json({ error: "Your billing identity could not be established. Please contact support.", code: "billing_identity_unestablished" }, { status: 409 });
          case "discovery_incomplete":
            logger.error("[create-checkout-session] Could not completely discover this uid's Stripe customers; refusing to start checkout", { pagesFetched: authority.pagesFetched });
            return NextResponse.json({ error: "We couldn't finish checking your billing identity, so we've made no changes. Please contact support.", code: "customer_discovery_incomplete" }, { status: 409 });
          case "enumeration_incomplete":
            reportIncompleteAuthorityEnumeration({ path: "checkout_session_create", stripeCustomerId: authority.customerId, uid, storedSubscriptionId: null, reason: authority.reason, pagesFetched: authority.pagesFetched });
            return NextResponse.json({ error: "We couldn't finish checking your subscriptions, so we've made no changes. Please contact support.", code: "authority_enumeration_incomplete" }, { status: 409 });
          case "multiple_entitlements":
            reportMultipleEntitlementSubscriptions({ path: "checkout_session_create", stripeCustomerId: authority.customerId, uid, storedSubscriptionId: null, candidateSubscriptionIds: authority.subscriptionIds, candidateCount: authority.count });
            return NextResponse.json({ error: "Your account has more than one active subscription, so we can't safely change your plan. Please contact support.", code: "multiple_entitlement_subscriptions" }, { status: 409 });
          case "cross_customer_entitlements":
            logger.error("[billing] cross_customer_entitlement_subscriptions", { code: "cross_customer_entitlement_subscriptions", path: "checkout_session_create", uid, customerIds: authority.customerIds, candidateSubscriptionIds: authority.subscriptionIds, resolution: "no_mutation_ambiguous_customer_set" });
            return NextResponse.json({ error: "Your account has more than one active subscription, so we can't safely change your plan. Please contact support.", code: "cross_customer_entitlement_subscriptions" }, { status: 409 });
          case "customer_authority_conflict":
            logger.error("[billing] customer_authority_conflict", { code: "customer_authority_conflict", path: "checkout_session_create", uid, authoritativeCustomerId: authority.authoritativeCustomerId, storedCustomerId: authority.storedCustomerId, candidateSubscriptionIds: authority.subscriptionIds, resolution: "no_mutation_binding_repair_required" });
            return NextResponse.json({ error: "Your billing records need attention before your plan can change. We've made no changes. Please contact support.", code: "customer_authority_conflict" }, { status: 409 });
          case "ambiguous_customers":
            logger.error("[billing] ambiguous_billing_identity", { code: "ambiguous_billing_identity", path: "checkout_session_create", uid, customerIds: authority.customerIds, resolution: "no_mutation_no_canonical_customer" });
            return NextResponse.json({ error: "Your billing records need attention before checkout can start. We've made no changes. Please contact support.", code: "ambiguous_billing_identity" }, { status: 409 });
          case "no_customer":
          case "reuse_customer":
          case "exactly_one":
            break;
        }

        let customerId: string;
        let subscription: Stripe.Subscription | null = null;
        if (authority.kind === "no_customer") {
          if (!userEmail) {
            return NextResponse.json({ error: "User email not found. Please update your profile." }, { status: 400 });
          }
          // Idempotent per uid: a racing or retried create returns the same customer instead of a second one.
          const created = await stripeClient.customers.create(
            { email: userEmail, metadata: { firebaseUid: uid, email: userEmail } },
            { idempotencyKey: `billing-customer-create-${uid}` }
          );
          customerId = created.id;
        } else {
          customerId = authority.customerId;
          if (authority.kind === "exactly_one") subscription = authority.subscription;
        }

        if (authority.kind === "no_customer" || authority.source === "discovered") {
          const bound = await bindStripeCustomerIfAbsent(uid, customerId);
          if (bound.kind === "conflict") {
            logger.error("[create-checkout-session] A different Stripe customer was bound concurrently; refusing to start checkout", { customerId, existingCustomerId: bound.existingCustomerId });
            return NextResponse.json({ error: "Your billing identity changed while we were checking it. We've made no changes. Please try again.", code: "customer_binding_conflict" }, { status: 409 });
          }
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


          // Already on the requested Price: nothing to do. No Stripe mutation, no
          // session, no extra item.
          if (planItem.item.price?.id === priceId) {
            console.log("[create-checkout-session] Subscription already on the requested price; no change needed", {
              subscriptionId: current.id,
              priceId,
            });
            return NextResponse.json({ url: `${baseUrl}/billing?success=true&upgraded=true`, upgraded: true, unchanged: true });
          }

          if (!(await isCheckoutLeaseStillHeld(lease))) {
            logger.error("[create-checkout-session] Lease no longer held before the in-place plan change; refusing to mutate", { subscriptionId: current.id });
            return NextResponse.json({ error: "Another checkout for your account is already in progress. Please wait a moment and try again.", code: "checkout_in_progress" }, { status: 409 });
          }
          try {
            // The ITEM ID is mandatory. Updating with a bare price ADDS an item
            // rather than replacing the existing one, which would produce a
            // two-item subscription — the other shape the resolver fails closed on.
            // Stripe prorates, and an interval change resets the billing cycle.
            const updatedSubscription = await stripeClient.subscriptions.update(current.id, {
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

        // R5-C1 — pending Checkout Session authority: Stripe's own session state
        // is the durable record of a checkout that can still complete. Reuse an
        // actionable one; never open a second completable session for this uid.
        const pending = await resolvePendingCheckoutAuthority({ stripe: stripeClient, uid, customerId });
        if (pending.kind === "enumeration_incomplete") {
          logger.error("[create-checkout-session] Could not completely enumerate pending Checkout Sessions; refusing to create another", { customerId, reason: pending.reason, pagesFetched: pending.pagesFetched });
          return NextResponse.json({ error: "We couldn't finish checking your pending checkout, so we've made no changes. Please try again in a moment.", code: "pending_checkout_enumeration_incomplete" }, { status: 409 });
        }
        if (pending.kind === "pending") {
          logger.info("[create-checkout-session] Reusing the customer's existing actionable Checkout Session instead of creating another", { customerId, sessionId: pending.session.id, actionableCount: pending.count });
          return NextResponse.json({ url: pending.session.url, pending: true });
        }
        if (!(await isCheckoutLeaseStillHeld(lease))) {
          logger.error("[create-checkout-session] Lease no longer held before Checkout Session creation; refusing to create one", { customerId });
          return NextResponse.json({ error: "Another checkout for your account is already in progress. Please wait a moment and try again.", code: "checkout_in_progress" }, { status: 409 });
        }
        const session = await stripeClient.checkout.sessions.create({
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
        }, { idempotencyKey: `billing-checkout-session-${uid}-${lease.token}` });

        console.log("[create-checkout-session] Created checkout session:", {
          sessionId: session.id,
          planId,
          interval,
          priceId,
        });

        return NextResponse.json({ url: session.url });
      });
    } catch (dependencyError) {
      if (isTransientDependencyError(dependencyError)) {
        logger.warn("[create-checkout-session] Could not establish billing identity or subscription authority; refusing to start checkout", {
          dependency: dependencyError.dependency,
          operation: dependencyError.operation,
        });
        return NextResponse.json(
          { error: "We couldn't reach our billing systems to verify your account. Please try again in a moment." },
          { status: 503 }
        );
      }
      throw dependencyError;
    }
    if (leased.kind === "busy") {
      return NextResponse.json(
        { error: "Another checkout for your account is already in progress. Please wait a moment and try again.", code: "checkout_in_progress" },
        { status: 409 }
      );
    }
    return leased.result;
  } catch (error: any) {
    console.error("[create-checkout-session] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create checkout session." },
      { status: 500 }
    );
  }
}

