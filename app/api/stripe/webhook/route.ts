/**
 * Stripe Webhook Handler
 * 
 * Handles Stripe webhook events for subscription lifecycle and updates Firestore accordingly.
 * 
 * EVENTS HANDLED:
 * - checkout.session.completed: New subscription created via checkout
 * - customer.subscription.created: New subscription created
 * - customer.subscription.updated: Plan changes, upgrades, downgrades, status changes
 * - customer.subscription.deleted: Subscription canceled - downgrades to free plan
 * - invoice.payment_succeeded: Payment successful - ensures subscription is active
 * - invoice.payment_failed: Payment failed - logged but doesn't change plan
 * 
 * PLAN MAPPING:
 * Uses getPlanFromPriceId() helper to map Stripe price IDs to internal plans:
 * - STRIPE_PRICE_3_MODELS → "lite" plan (80 runs/month, 3 models)
 * - STRIPE_3_MODELS_ANNUAL → "lite" plan (80 runs/month, 3 models)
 * - STRIPE_PRICE_5_MODELS → "full" plan (150 runs/month, 5 models)
 * - STRIPE_5_MODELS_ANNUAL → "full" plan (150 runs/month, 5 models)
 * 
 * FIRESTORE UPDATES:
 * When a subscription is active, updates:
 * - plan: "lite" | "full" | "free"
 * - stripeCustomerId: Stripe customer ID
 * - stripeSubscriptionId: Stripe subscription ID
 * - billingInterval: "month" | "year"
 * - billingCycleStart: ISO timestamp
 * - runsThisMonth: Reset to 0 (via resetUsageForNewPlan)
 * - usageMonth: Current month (YYYY-MM)
 * 
 * When subscription is deleted, updates:
 * - plan: "free"
 * - stripeSubscriptionId: null
 * - billingInterval: null
 * - runsThisMonth: Reset to 0
 * 
 * USER IDENTIFICATION:
 * Finds Firebase UID from metadata in this order:
 * 1. subscription.metadata.firebase_uid
 * 2. customer.metadata.firebase_uid (fallback)
 * 3. session.metadata.firebase_uid (for checkout.session.completed)
 * 
 * IMPORTANT: This route must be publicly accessible (no auth required)
 * but verifies webhook signatures using STRIPE_WEBHOOK_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { STRIPE_WEBHOOK_SECRET } from "@/lib/env";
import { adminDb } from "@/lib/firebase/admin";
import { resetUsageForNewPlan } from "@/lib/stripe/usage";
import { getPlanFromPriceId, getFreePlanConfig, PlanConfig } from "@/lib/billing/planMapping";
import { PLAN_CONFIG, getPlanIdFromPriceId, getPlanConfigById, BillingPlanId, STRIPE_PRICE_TO_PLAN } from "@/lib/billing/planConfig";
import { mapSubscriptionToPlan, getCurrentMonthString, SubscriptionPlanMapping } from "@/lib/billing/subscriptionMapper";
import { resolveSubscriptionBillingState } from "@/lib/billing/subscriptionBillingState";
import { decideSubscriptionAuthority, mayDeletionDowngrade } from "@/lib/billing/subscriptionAuthority";
import { TransientDependencyError, firestoreRead, stripeLookup } from "@/lib/billing/reconciliationOutcome";
import { isEntitlementBearingSubscriptionStatus } from "@/lib/billing/subscriptionStatus";
import { PlanId, BillingInterval } from "@/lib/plans";
import { updateUserPlanInFirestore } from "@/lib/stripe/webhookHelpers";
import { getPostHogClient } from "@/lib/posthog-server";
import { logger } from "@/lib/logger";
import Stripe from "stripe";

export async function POST(req: NextRequest) {
  try {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      console.error("[webhook] Stripe not configured");
      return NextResponse.json(
        { error: "Stripe webhook not configured" },
        { status: 500 }
      );
    }

    if (!adminDb) {
      console.error("[webhook] Firestore not available");
      return NextResponse.json(
        { error: "Database not available" },
        { status: 500 }
      );
    }

    // Get raw body for signature verification
    const body = await req.text();
    const signature = req.headers.get("stripe-signature");

    if (!signature) {
      return NextResponse.json(
        { error: "Missing stripe-signature header" },
        { status: 400 }
      );
    }

    // Verify webhook signature
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err: any) {
      console.error("[webhook] Signature verification failed:", err.message);
      return NextResponse.json(
        { error: `Webhook signature verification failed: ${err.message}` },
        { status: 400 }
      );
    }

    // Log received event for debugging
    console.log("[webhook] ✅ Received event:", {
      type: event.type,
      id: event.id,
      created: event.created,
      livemode: event.livemode,
    });

    // Handle different event types
    switch (event.type) {
      case "checkout.session.completed": {
        // Checkout session completed - subscription should be created
        const session = event.data.object as Stripe.Checkout.Session;
        
        console.log("[webhook] Processing checkout.session.completed:", {
          sessionId: session.id,
          customerId: session.customer,
          subscriptionId: session.subscription,
          metadata: session.metadata,
        });
        
        // If subscription exists, retrieve it and process
        if (session.subscription) {
          try {
            const subscription = await stripe.subscriptions.retrieve(
              session.subscription as string
            );
            
            console.log("[webhook] Retrieved subscription:", {
              subscriptionId: subscription.id,
              status: subscription.status,
              priceId: subscription.items.data[0]?.price.id,
              metadata: subscription.metadata,
            });
            
            // Ensure subscription has firebaseUid in metadata (from session if not in subscription)
            // Check both firebaseUid and firebase_uid for backward compatibility
            const sessionUid = session.metadata?.firebaseUid || session.metadata?.firebase_uid;
            const subUid = subscription.metadata?.firebaseUid || subscription.metadata?.firebase_uid;
            
            if (!subUid && sessionUid) {
              console.log("[webhook] Updating subscription metadata with firebaseUid from session");
              // Update subscription metadata with firebaseUid from session
              await stripe.subscriptions.update(subscription.id, {
                metadata: {
                  ...subscription.metadata,
                  firebaseUid: sessionUid,
                },
              });
              subscription.metadata = {
                ...subscription.metadata,
                firebaseUid: sessionUid,
              };
            }
            
            await handleSubscriptionChange(subscription);
          } catch (subError: any) {
            // Phase WEBHOOK-B1-C2: do NOT swallow. Reconciliation failures here
            // used to be acknowledged with a 200, so Stripe never retried and a
            // brand-new customer's only checkout event was lost for good — the
            // request-time fallback cannot repair them, because it returns
            // early for a free plan with no stored customer id.
            console.error("[webhook] Error processing subscription from checkout session:", subError?.message);
            throw subError;
          }
        } else {
          console.warn("[webhook] checkout.session.completed but no subscription found", {
            sessionId: session.id,
            customerId: session.customer,
          });
          
          // Try to find subscription by customer ID as fallback
          if (session.customer && typeof session.customer === "string") {
            try {
              console.log("[webhook] Attempting to find subscription by customer ID:", session.customer);
              const subscriptions = await stripe.subscriptions.list({
                customer: session.customer,
                status: "all",
                limit: 1,
              });
              
              if (subscriptions.data.length > 0) {
                const subscription = subscriptions.data[0];
                console.log("[webhook] Found subscription by customer ID:", subscription.id);
                await handleSubscriptionChange(subscription);
              }
            } catch (fallbackError: any) {
              console.error("[webhook] Fallback subscription lookup failed:", fallbackError);
            }
          }
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        console.log("[webhook] Processing subscription event:", {
          eventType: event.type,
          subscriptionId: subscription.id,
          status: subscription.status,
          customerId: subscription.customer,
          priceId: subscription.items.data[0]?.price.id,
          metadata: subscription.metadata,
        });
        await handleSubscriptionChange(subscription);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        // Payment succeeded - subscription is active
        // invoice.subscription can be a string (subscription ID) or a Stripe.Subscription object
        // Use type assertion to access subscription property safely
        const invoiceWithSubscription = invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null };
        const subscriptionId = typeof invoiceWithSubscription.subscription === "string" 
          ? invoiceWithSubscription.subscription 
          : invoiceWithSubscription.subscription?.id;
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await handleSubscriptionChange(subscription);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const invoiceWithSubscription = invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null };
        const subscriptionId = typeof invoiceWithSubscription.subscription === "string" 
          ? invoiceWithSubscription.subscription 
          : invoiceWithSubscription.subscription?.id;
        console.warn("[webhook] Payment failed for subscription:", subscriptionId);
        // Optionally: send notification to user, mark account as past_due, etc.
        break;
      }

      default:
        console.log(`[webhook] Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error: any) {
    console.error("[webhook] Error processing webhook:", error);
    return NextResponse.json(
      { error: error.message || "Webhook processing failed" },
      { status: 500 }
    );
  }
}

/**
 * Handle subscription created or updated
 * 
 * Maps subscription's price ID to planId and billing interval,
 * then updates user's plan in Firestore.
 * 
 * This function:
 * 1. Extracts the active price ID from the subscription
 * 2. Maps it to an internal plan using getPlanFromPriceId
 * 3. Finds the Firebase user via metadata (checks subscription, customer, and session)
 * 4. Updates Firestore with the correct plan, limits, and subscription info
 * 
 * Events handled:
 * - checkout.session.completed (new subscriptions)
 * - customer.subscription.created (new subscriptions)
 * - customer.subscription.updated (plan changes, upgrades, downgrades)
 * - invoice.payment_succeeded (subscription is active)
 * 
 * EXPORTED for use in test endpoints
 */
export async function handleSubscriptionChange(subscription: Stripe.Subscription) {
  if (!adminDb) {
    console.error("[webhook] Firestore not available");
    return;
  }

  const customerId = subscription.customer as string;
  const subscriptionId = subscription.id;
  const subscriptionStatus = subscription.status;
  const priceId = subscription.items.data[0]?.price.id;

  // Log for debugging
  console.log("[webhook] Processing subscription change:", {
    subscriptionId,
    customerId,
    priceId,
    status: subscriptionStatus,
  });

  // Find Firebase UID from metadata (check multiple sources)
  // Support both firebaseUid and firebase_uid for backward compatibility
  let firebaseUid: string | null = null;

  // Priority 1: subscription metadata (firebaseUid or firebase_uid)
  firebaseUid = subscription.metadata?.firebaseUid || subscription.metadata?.firebase_uid || null;

  // Priority 2: customer metadata (fallback)
  if (!firebaseUid && stripe) {
    try {
      if (!stripe) {
        console.error("[webhook] Stripe client not available");
        return NextResponse.json({ error: "Stripe not configured" }, { status: 500 });
      }
      const customer = await stripe.customers.retrieve(customerId);
      if (!customer.deleted && typeof customer !== "string") {
        const customerMetadata = (customer as Stripe.Customer & { metadata?: { firebaseUid?: string; firebase_uid?: string } }).metadata;
        firebaseUid = customerMetadata?.firebaseUid || customerMetadata?.firebase_uid || null;
      }
    } catch (err) {
      console.error("[webhook] Failed to retrieve customer:", err);
    }
  }

  // Priority 3: Query Firestore by stripeCustomerId (reliable fallback)
  // This is the most reliable method since we always save stripeCustomerId to Firestore
  if (!firebaseUid && adminDb) {
    try {
      console.log("[webhook] No firebaseUid in metadata, querying Firestore by stripeCustomerId:", customerId);
      const usersSnapshot = await adminDb.collection("users")
        .where("stripeCustomerId", "==", customerId)
        .limit(1)
        .get();
      
      if (!usersSnapshot.empty) {
        firebaseUid = usersSnapshot.docs[0].id;
        console.log("[webhook] ✅ Found user by stripeCustomerId:", firebaseUid);
        
        // Also update the subscription metadata with firebaseUid for future lookups
        if (stripe) {
          try {
            await stripe.subscriptions.update(subscriptionId, {
              metadata: {
                ...subscription.metadata,
                firebaseUid: firebaseUid,
              },
            });
            console.log("[webhook] Updated subscription metadata with firebaseUid");
          } catch (metaErr) {
            console.warn("[webhook] Failed to update subscription metadata:", metaErr);
            // Non-critical, continue processing
          }
        }
      }
    } catch (err) {
      console.error("[webhook] Failed to lookup user by stripeCustomerId:", err);
    }
  }

  // Priority 4: fallback to email lookup (best effort, log warning)
  if (!firebaseUid) {
    const email = subscription.metadata?.email || (subscription as any).customer_email;
    if (email && adminDb) {
      console.warn("[webhook] No firebaseUid in metadata or stripeCustomerId, attempting email lookup:", email);
      try {
        const usersSnapshot = await adminDb.collection("users")
          .where("email", "==", email)
          .limit(1)
          .get();
        
        if (!usersSnapshot.empty) {
          firebaseUid = usersSnapshot.docs[0].id;
          console.log("[webhook] Found user by email:", firebaseUid);
        }
      } catch (err) {
        console.error("[webhook] Failed to lookup user by email:", err);
      }
    }
  }

  if (!firebaseUid) {
    console.error("[webhook] Missing firebaseUid - all lookup methods failed", {
      subscriptionId,
      customerId,
      subscriptionMetadata: subscription.metadata,
      priceId,
      customerEmail: subscription.metadata?.email,
    });
    
    // Try one more time: get customer and check metadata
    try {
      if (!stripe) {
        console.error("[webhook] Stripe client not available");
        return NextResponse.json({ error: "Stripe not configured" }, { status: 500 });
      }
      const customer = await stripe.customers.retrieve(customerId);
      if (!customer.deleted && typeof customer !== "string") {
        console.log("[webhook] Customer details:", {
          customerId: customer.id,
          email: customer.email,
          metadata: customer.metadata,
        });
        
        // Try email lookup if we have customer email
        if (customer.email && adminDb) {
          const usersSnapshot = await adminDb.collection("users")
            .where("email", "==", customer.email)
            .limit(1)
            .get();
          
          if (!usersSnapshot.empty) {
            firebaseUid = usersSnapshot.docs[0].id;
            console.log("[webhook] Found user by customer email:", firebaseUid);
          }
        }
      }
    } catch (err) {
      console.error("[webhook] Final customer lookup failed:", err);
    }
    
    if (!firebaseUid) {
      console.error("[webhook] CRITICAL: Cannot find user for subscription. Webhook will not update Firestore.", {
        subscriptionId,
        customerId,
      });
      return;
    }
  }

  // Phase WEBHOOK-B1-C1 — FRESHNESS. Webhook delivery is unordered, so the
  // event payload may describe OLDER state than what is already persisted.
  // Re-read the subscription from Stripe and reconcile against THAT, exactly
  // as the invoice path already did. A replayed old event then converges on
  // current state instead of regressing plan, cadence or period.
  let authoritative: Stripe.Subscription = subscription;
  if (stripe) {
    const fresh = await stripeLookup("subscriptions.retrieve", () => stripe!.subscriptions.retrieve(subscriptionId));
    if (fresh.kind === "absent") {
      // PROVEN absence: Stripe says this subscription no longer exists. There
      // is nothing to reconcile against, and no destructive action is implied
      // by an update event, so acknowledge without writing.
      logger.warn("[webhook] Subscription no longer exists at Stripe; nothing to reconcile");
      return;
    }
    authoritative = fresh.value;
  }

  // Phase WEBHOOK-B1-C1 — IDENTITY. An event about subscription A must never
  // write over a user whose current subscription is B. See
  // lib/billing/subscriptionAuthority.ts for the replacement rule.
  // Phase WEBHOOK-B1-C2: this read no longer swallows its error. A Firestore
  // failure here used to become `null`, which the authority check read as "no
  // stored subscription" — the P0 that let one transient blip downgrade a
  // paying customer. It now propagates and the delivery is retried.
  const existingSnap = await firestoreRead("users.get", () => adminDb!.collection("users").doc(firebaseUid!).get());
  const existingData = existingSnap.data() as Record<string, unknown> | undefined;
  const storedSubscriptionId = (existingData?.stripeSubscriptionId as string | undefined) ?? null;
  const storedCustomerId = (existingData?.stripeCustomerId as string | undefined) ?? null;

  // Phase WEBHOOK-B1-C2 — ASSOCIATION. The event's user id comes from Stripe
  // metadata, which is not proof that this subscription belongs to this user.
  // If the user is already bound to a different Stripe customer, refuse: an
  // event must never mutate a record bound to another customer, and must never
  // silently rebind `stripeCustomerId`. An unbound user is still bindable,
  // which is what keeps first-time checkout working.
  const eventCustomerId = typeof authoritative.customer === "string" ? authoritative.customer : authoritative.customer?.id ?? null;
  if (storedCustomerId && eventCustomerId && storedCustomerId !== eventCustomerId) {
    logger.error("[webhook] Refusing event whose Stripe customer does not match the user's stored customer binding", {
      subscriptionId,
      hasStoredCustomer: true,
    });
    return;
  }

  let storedSubscriptionStatus: string | null = null;
  if (storedSubscriptionId && storedSubscriptionId !== subscriptionId && stripe) {
    // A failure here must NOT be read as "the stored subscription is not
    // entitlement-bearing" — that would hand authority to the incoming
    // subscription on a timeout. Only a proven absence does that.
    const storedLookup = await stripeLookup("subscriptions.retrieve(stored)", () => stripe!.subscriptions.retrieve(storedSubscriptionId));
    storedSubscriptionStatus = storedLookup.kind === "found" ? storedLookup.value.status : null;
  }
  const authority = decideSubscriptionAuthority({
    eventSubscriptionId: subscriptionId,
    storedSubscriptionId,
    storedSubscriptionStatus,
    incomingSubscriptionStatus: authoritative.status,
  });
  if (!authority.allowed) {
    logger.warn("[webhook] Ignoring event for a subscription that is not authoritative for this user", {
      reason: authority.reason,
    });
    return;
  }

  // Map subscription to plan using the new mapper
  // This handles both price ID matching and metadata.targetPlan fallback
  const planMapping = mapSubscriptionToPlan(authoritative);
  
  console.log("[webhook] Mapped subscription to plan:", {
    subscriptionId,
    priceId,
    metadataTargetPlan: subscription.metadata?.targetPlan,
    subscriptionStatus,
    mappedPlan: planMapping.planId,
    monthlyLimit: planMapping.monthlyLimit,
    maxModelsPerRun: planMapping.maxModelsPerRun,
    isActive: planMapping.isActive,
  });

  // If we couldn't map to a paid plan and status suggests it should be paid, log warning
  if (planMapping.planId === "free" && (subscriptionStatus === "active" || subscriptionStatus === "trialing")) {
    console.warn("[webhook] Subscription is active but mapped to free plan:", {
      subscriptionId,
      priceId,
      metadata: subscription.metadata,
      availablePriceMappings: Object.keys(STRIPE_PRICE_TO_PLAN),
    });
  }

  // Phase WEBHOOK-B1: cadence and billing period both come from the canonical
  // resolver, which reads the PLAN-BEARING ITEM rather than `items.data[0]`
  // and prefers the item-level period over the subscription-level one (which
  // can be stale in flexible billing mode after an interval change).
  const billingStateResult = resolveSubscriptionBillingState(authoritative as never);
  if (!billingStateResult.ok) {
    logger.error("[webhook] Could not resolve canonical billing state — refusing to persist derived billing fields", {
      subscriptionId,
      reason: billingStateResult.reason,
    });
    return;
  }
  const billingState = billingStateResult.state;
  const billingInterval: BillingInterval = billingState.billingInterval;

  // Log for debugging
  console.log("[webhook] Processing subscription change:", {
    eventType: "subscription_change",
    subscriptionId,
    customerId,
    firebaseUid,
    priceId,
    resolvedPlan: planMapping.planId,
    monthlyLimit: planMapping.monthlyLimit,
    maxModelsPerRun: planMapping.maxModelsPerRun,
    subscriptionStatus,
    billingInterval,
  });

  // Update user plan in Firestore
  try {
    console.log(`[webhook] About to update Firestore for user ${firebaseUid} with plan ${planMapping.planId}`);
    await updateUserPlanInFirestore({
      uid: firebaseUid,
      customerId,
      subscriptionId,
      planMapping,
      status: authoritative.status,
      billingInterval,
      billingState,
    });
    console.log(`[webhook] ✅ Successfully processed subscription change for user ${firebaseUid}`);

    try {
      const ph = getPostHogClient();
      ph.capture({
        distinctId: firebaseUid,
        event: "subscription_created",
        properties: {
          plan: planMapping.planId,
          interval: billingInterval,
          subscription_id: subscriptionId,
        },
      });
      await ph.flush();
    } catch (phErr) {
      logger.warn("[webhook] PostHog capture failed (non-critical)", { error: phErr });
    }

    // Verify the update by reading back from Firestore
    if (adminDb) {
      try {
        const userDoc = await adminDb.collection("users").doc(firebaseUid).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          console.log(`[webhook] ✅ Verified Firestore update:`, {
            plan: userData?.plan,
            monthlyLimit: userData?.monthlyLimit,
            maxModelsPerRun: userData?.maxModelsPerRun,
            stripeSubscriptionId: userData?.stripeSubscriptionId,
          });
        }
      } catch (verifyErr) {
        console.warn("[webhook] Could not verify Firestore update:", verifyErr);
      }
    }
  } catch (updateError: any) {
    // Phase WEBHOOK-B1-C2: rethrow so the route answers a retryable 5xx.
    // Returning 200 here told Stripe the delivery had succeeded and dropped
    // the reconciliation permanently.
    console.error(`[webhook] ❌ CRITICAL: Failed to update user plan:`, updateError?.message);
    throw updateError;
  }
}

/**
 * Handle subscription deleted
 * 
 * Downgrades user to free plan when subscription is canceled.
 * 
 * This function:
 * 1. Finds the Firebase user via metadata
 * 2. Updates Firestore to set plan to "free" with free plan limits
 * 3. Clears subscription ID but keeps customer ID for potential future subscriptions
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  if (!adminDb) {
    console.error("[webhook] Firestore not available");
    return;
  }

  const customerId = subscription.customer as string;
  const subscriptionId = subscription.id;

  // Find Firebase UID from metadata (check multiple sources)
  // Support both firebaseUid and firebase_uid for backward compatibility
  let firebaseUid: string | null = null;

  // Priority 1: subscription metadata
  firebaseUid = subscription.metadata?.firebaseUid || subscription.metadata?.firebase_uid || null;

  // Priority 2: customer metadata (fallback)
  if (!firebaseUid && stripe) {
    try {
      if (!stripe) {
        console.error("[webhook] Stripe client not available");
        return NextResponse.json({ error: "Stripe not configured" }, { status: 500 });
      }
      const customer = await stripe.customers.retrieve(customerId);
      if (!customer.deleted && typeof customer !== "string") {
        const customerMetadata = (customer as Stripe.Customer & { metadata?: { firebaseUid?: string; firebase_uid?: string } }).metadata;
        firebaseUid = customerMetadata?.firebaseUid || customerMetadata?.firebase_uid || null;
      }
    } catch (err) {
      console.error("[webhook] Failed to retrieve customer:", err);
    }
  }

  // Priority 3: Query Firestore by stripeCustomerId (reliable fallback)
  if (!firebaseUid && adminDb) {
    try {
      console.log("[webhook] No firebaseUid in metadata, querying Firestore by stripeCustomerId:", customerId);
      const usersSnapshot = await adminDb.collection("users")
        .where("stripeCustomerId", "==", customerId)
        .limit(1)
        .get();
      
      if (!usersSnapshot.empty) {
        firebaseUid = usersSnapshot.docs[0].id;
        console.log("[webhook] ✅ Found user by stripeCustomerId:", firebaseUid);
      }
    } catch (err) {
      console.error("[webhook] Failed to lookup user by stripeCustomerId:", err);
    }
  }

  if (!firebaseUid) {
    console.error("[webhook] Missing firebaseUid - all lookup methods failed", {
      subscriptionId,
      customerId,
      subscriptionMetadata: subscription.metadata,
    });
    return;
  }

  // Log for debugging
  console.log("[webhook] Processing subscription deletion:", {
    eventType: "subscription_deleted",
    subscriptionId,
    customerId,
    firebaseUid,
  });

  // Phase WEBHOOK-B1-C1 — DELETION IDENTITY GUARD.
  //
  // A cancellation may only ever clear the subscription it is actually
  // about. Before this guard the handler downgraded whichever user it
  // resolved, so a delayed `deleted` for a former subscription A wiped a
  // paying customer whose current subscription is B — proven by execution in
  // the exact-head review. A deletion never grants authority, only removes
  // it, so there is no replacement branch here: anything other than the
  // stored subscription is ignored.
  // Phase WEBHOOK-B1-C2: read failures propagate — see the change handler.
  const existingSnapForDeletion = await firestoreRead("users.get", () => adminDb!.collection("users").doc(firebaseUid!).get());
  const existingDataForDeletion = existingSnapForDeletion.data() as Record<string, unknown> | undefined;
  const storedSubscriptionIdForDeletion = (existingDataForDeletion?.stripeSubscriptionId as string | undefined) ?? null;
  const storedCustomerIdForDeletion = (existingDataForDeletion?.stripeCustomerId as string | undefined) ?? null;

  // Association boundary, as on the change path.
  if (storedCustomerIdForDeletion && customerId && storedCustomerIdForDeletion !== customerId) {
    logger.error("[webhook] Refusing deletion whose Stripe customer does not match the user's stored binding", { subscriptionId });
    return;
  }

  if (storedSubscriptionIdForDeletion) {
    // A stored reference exists, so identity alone settles it: a deletion may
    // only ever clear the subscription it is actually about.
    if (!mayDeletionDowngrade({ deletedSubscriptionId: subscriptionId, storedSubscriptionId: storedSubscriptionIdForDeletion })) {
      logger.warn("[webhook] Ignoring deletion for a subscription that is not the user's current one", { subscriptionId });
      return;
    }
  } else {
    // Phase WEBHOOK-B1-C2 — NO STORED REFERENCE.
    //
    // C1 downgraded here on the reasoning that there was "nothing to protect".
    // The review disproved it: the paid `plan` field IS the thing destroyed,
    // and only Stripe can say whether a replacement subscription exists. A
    // customer whose reference was cleared but who holds a live subscription
    // was downgraded by a delayed cancellation of an old one.
    //
    // Absence must be proven, so ask Stripe. A transient failure propagates; a
    // live replacement, or several, blocks the downgrade rather than guessing.
    if (!stripe) {
      logger.error("[webhook] Cannot verify replacement subscriptions without a Stripe client; refusing to downgrade", { subscriptionId });
      return;
    }
    const candidates = await stripeLookup("subscriptions.list", () => stripe!.subscriptions.list({ customer: customerId, status: "all", limit: 100 }));
    if (candidates.kind === "absent") {
      logger.error("[webhook] Customer not found while checking for replacement subscriptions; refusing to downgrade", { subscriptionId });
      return;
    }
    const entitled = candidates.value.data.filter(
      (candidate) => candidate.id !== subscriptionId && isEntitlementBearingSubscriptionStatus(candidate.status)
    );
    if (entitled.length > 0) {
      logger.warn("[webhook] Refusing downgrade: the customer still has an entitlement-bearing subscription", {
        subscriptionId,
        entitledCount: entitled.length,
      });
      return;
    }
  }

  // Downgrade to free plan
  const freeMapping: SubscriptionPlanMapping = {
    planId: "free",
    monthlyLimit: PLAN_CONFIG.free.monthlyLimit,
    maxModelsPerRun: PLAN_CONFIG.free.maxModels,
    isActive: false,
  };

  try {
    await updateUserPlanInFirestore({
      uid: firebaseUid,
      customerId,
      subscriptionId,
      planMapping: freeMapping,
      status: "canceled",
    });
    console.log(`[webhook] ✅ Successfully downgraded user ${firebaseUid} to free plan`);

    try {
      const ph = getPostHogClient();
      ph.capture({
        distinctId: firebaseUid,
        event: "subscription_canceled",
        properties: { subscription_id: subscriptionId },
      });
      await ph.flush();
    } catch (phErr) {
      logger.warn("[webhook] PostHog capture failed (non-critical)", { error: phErr });
    }
  } catch (updateError: any) {
    // Phase WEBHOOK-B1-C2: rethrow so the delivery stays retryable.
    console.error(`[webhook] ❌ CRITICAL: Failed to downgrade user:`, updateError?.message);
    throw updateError;
  }
}

// Disable body parsing for webhook route (Stripe needs raw body for signature verification)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

