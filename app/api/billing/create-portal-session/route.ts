/**
 * Create Stripe Customer Portal Session
 * 
 * Creates a Stripe billing portal session so users can manage their subscription,
 * update payment methods, and view invoices.
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { adminDb } from "@/lib/firebase/admin";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { logger } from "@/lib/logger";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Auth Identity Consistency Remediation, Step 7 — resolves via the
    // shared, hardened resolver rather than this route's own duplicated
    // cookie-first logic.
    const identity = await resolveRequestIdentity(req);
    if (identity.status !== "authenticated") {
      logIdentityResolutionFailure({ route: "POST /api/billing/create-portal-session", method: "POST", failureCategory: identity.reason });
      return NextResponse.json(
        { error: "Unauthorized. Please sign in." },
        { status: 401 }
      );
    }
    const uid = identity.uid;

    if (!stripe) {
      return NextResponse.json(
        { error: "Stripe is not configured." },
        { status: 500 }
      );
    }

    // Get user's Stripe customer ID
    if (!adminDb) {
      return NextResponse.json(
        { error: "Database not available." },
        { status: 500 }
      );
    }

    const userDoc = await adminDb.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      return NextResponse.json(
        { error: "User not found." },
        { status: 404 }
      );
    }

    const userData = userDoc.data();
    const customerId = userData?.stripeCustomerId;

    // Handle users without Stripe customer IDs gracefully
    if (!customerId) {
      return NextResponse.json(
        { error: "NO_STRIPE_CUSTOMER" },
        { status: 409 }
      );
    }

    // Create portal session
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${baseUrl}/billing`,
    });

    return NextResponse.json({ url: session.url });
  } catch (error: any) {
    logger.error("[create-portal-session] Error", { error: error?.message });
    return NextResponse.json(
      { error: error.message || "Failed to create portal session." },
      { status: 500 }
    );
  }
}

