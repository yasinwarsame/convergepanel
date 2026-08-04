/**
 * Subscription Validation API Endpoint
 * 
 * Validates a user's Stripe subscription status and syncs Firestore if needed.
 * This is a best-effort validation that doesn't block the user if it fails.
 * 
 * Called:
 * - On login (for paid plan users)
 * - Before panel runs (for paid plan users)
 * - When usage data is fetched (for paid plan users)
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { validateUserSubscription } from "@/lib/stripe/subscriptionValidation";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";
// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
 export const dynamic = "force-dynamic";


export async function POST(req: NextRequest) {
  try {
    // Auth Identity Consistency Remediation, Step 7 — resolves via the
    // shared, hardened resolver rather than this route's own duplicated
    // cookie-first logic.
    const identity = await resolveRequestIdentity(req);
    if (identity.status !== "authenticated") {
      logIdentityResolutionFailure({ route: "POST /api/billing/validate-subscription", method: "POST", failureCategory: identity.reason });
      return NextResponse.json(
        { error: "Unauthorized. Please sign in." },
        { status: 401 }
      );
    }
    const uid = identity.uid;

    // Validate subscription (defensive - never throws)
    const validationResult = await validateUserSubscription(uid);
    
    if (validationResult) {
      return NextResponse.json({
        success: true,
        message: "Subscription validated successfully",
      });
    } else {
      // Validation failed but don't block user
      return NextResponse.json({
        success: false,
        message: "Subscription validation failed, but user access is not blocked",
      });
    }
  } catch (error: any) {
    // Defensive: log error but return success to not block user
    console.error("[validate-subscription] Error:", {
      message: error?.message,
      stack: error?.stack,
    });
    return NextResponse.json({
      success: false,
      message: "Validation error occurred, but user access is not blocked",
    });
  }
}
