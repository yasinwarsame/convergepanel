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
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { validateUserSubscription } from "@/lib/stripe/subscriptionValidation";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";
// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
 export const dynamic = "force-dynamic";


export async function POST(req: NextRequest) {
  try {
    // Authenticate user
    let uid: string;
    try {
      const auth = await verifySessionCookie(req);
      
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
        if (!token) {
          return NextResponse.json(
            { error: "Unauthorized. Please sign in." },
            { status: 401 }
          );
        }
        const decodedToken = await verifyIdToken(token);
        uid = decodedToken.uid;
      }
    } catch (authError: any) {
      console.error("[validate-subscription] Authentication error:", {
        message: authError?.message,
        code: authError?.code,
      });
      return NextResponse.json(
        { error: "Unauthorized. Please sign in." },
        { status: 401 }
      );
    }

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
