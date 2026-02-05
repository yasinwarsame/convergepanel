/**
 * Create Stripe Customer Portal Session
 * 
 * Creates a Stripe billing portal session so users can manage their subscription,
 * update payment methods, and view invoices.
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { adminDb } from "@/lib/firebase/admin";
import { verifyIdToken } from "@/lib/firebase/auth";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { logger } from "@/lib/logger";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Verify authentication (try session cookie first, then Bearer token)
    const auth = await verifySessionCookie(req);
    let uid: string;

    if (auth) {
      uid = auth.uid;
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
    }

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

