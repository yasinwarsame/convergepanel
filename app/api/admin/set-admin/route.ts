/**
 * Set Admin Custom Claim Endpoint
 * 
 * This is a one-time setup endpoint to grant admin privileges to a user.
 * It sets the `admin: true` custom claim in Firebase Auth.
 * 
 * IMPORTANT: This endpoint is NOT linked in the UI for security.
 * It should only be called manually (e.g., via curl) during initial setup.
 * 
 * Security:
 * - Requires ADMIN_SECRET environment variable
 * - Only sets custom claims (doesn't expose sensitive data)
 * 
 * Usage:
 *   curl -X POST http://localhost:3000/api/admin/set-admin \
 *     -H "Content-Type: application/json" \
 *     -d '{"uid": "USER_UID", "secret": "ADMIN_SECRET"}'
 * 
 * After calling this, the user must sign out and sign back in for
 * the admin claim to take effect (Firebase tokens are cached).
 */

import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase/admin";
import { checkRateLimit } from "@/lib/security/rateLimit";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const rl = await checkRateLimit({
      maxRequests: 3,
      windowSeconds: 300,
      identifier: `set-admin:${ip}`,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
    }

    const body = await request.json();
    const { uid, secret } = body;

    const adminSecret = process.env.ADMIN_SECRET ?? "";
    const provided = typeof secret === "string" ? secret : "";
    const secretValid =
      adminSecret.length > 0 &&
      provided.length === adminSecret.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(adminSecret));

    if (!secretValid) {
      return NextResponse.json(
        { error: "Invalid secret" },
        { status: 401 }
      );
    }

    // Validate UID is provided
    if (!uid || typeof uid !== "string") {
      return NextResponse.json(
        { error: "UID is required" },
        { status: 400 }
      );
    }

    /**
     * Set admin custom claim
     * 
     * This adds `admin: true` to the user's ID token claims.
     * The claim will be available after the user's next token refresh
     * (they need to sign out and sign back in).
     */
    if (!adminAuth) {
      console.error("[admin/set-admin] Firebase Admin Auth is not available");
      return NextResponse.json(
        { error: "Firebase Admin Auth is not available" },
        { status: 500 }
      );
    }
    
    await adminAuth.setCustomUserClaims(uid, { admin: true });

    /**
     * Update Firestore user document
     * 
     * Also update the user's role in Firestore for consistency.
     * This allows querying users by role if needed.
     */
    const { adminDb } = await import("@/lib/firebase/admin");
    if (!adminDb) {
      console.error("[admin/set-admin] Firestore is not available");
      return NextResponse.json(
        { error: "Firestore is not available" },
        { status: 500 }
      );
    }
    
    await adminDb.collection("users").doc(uid).set(
      {
        role: "admin",
      },
      { merge: true } // Don't overwrite existing fields
    );

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Error setting admin:", error);
    return NextResponse.json(
      { error: "Internal server error", message: error.message },
      { status: 500 }
    );
  }
}

