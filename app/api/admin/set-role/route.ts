/**
 * Admin Set Role Endpoint
 * 
 * Allows admins to update a user's role in both Firestore and Firebase Auth custom claims.
 * 
 * Security:
 * - Only admins can access (verified via getRequestUser() - same as /api/admin/users)
 * - Updates both Firestore role field and Firebase Auth custom claims
 * - Merges custom claims to preserve existing claims when updating admin status
 * 
 * Route: POST /api/admin/set-role
 * Body: { uid: string, role: "user" | "admin" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/firebase/adminAuth";
import { adminAuth, adminDb, firebaseAdmin } from "@/lib/firebase/admin";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

/**
 * POST - Update user role
 * 
 * Updates both:
 * 1. Firestore users/{uid} document: sets role field
 * 2. Firebase Auth custom claims: sets admin: true/false based on role
 * 
 * @param request - Next.js request object with { uid, role } in body
 * @returns Success response with updated role
 */
export async function POST(request: NextRequest) {
  // Verify admin authentication using the same logic as /api/admin/users
  const decoded = await getRequestUser(request);
  if (!decoded || !decoded.admin) {
    console.error("[admin/set-role] Unauthorized access attempt", {
      hasToken: !!decoded,
      isAdmin: decoded?.admin,
      uid: decoded?.uid,
    });
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  console.log("[admin/set-role] Admin request from uid:", decoded.uid);

  try {
    const body = await request.json();
    const { uid, role } = body;

    // Validate input
    if (!uid || typeof uid !== "string") {
      return NextResponse.json(
        { error: "uid is required and must be a string" },
        { status: 400 }
      );
    }

    if (role !== "user" && role !== "admin") {
      return NextResponse.json(
        { error: "role must be 'user' or 'admin'" },
        { status: 400 }
      );
    }

    // Prevent admins from removing their own admin status
    if (decoded.uid === uid && role === "user") {
      return NextResponse.json(
        { error: "You cannot remove your own admin status" },
        { status: 400 }
      );
    }

    console.log(`[admin/set-role] Updating role for uid=${uid} to role=${role} by admin=${decoded.uid}`);

    // Update Firebase Auth custom claims
    // Get existing claims first to merge with new admin claim
    if (!adminAuth) {
      console.error("[admin/set-role] Firebase Admin Auth is not available");
      return NextResponse.json(
        { error: "Firebase Admin Auth is not available" },
        { status: 500 }
      );
    }
    
    let existingClaims: Record<string, any> = {};
    try {
      const userRecord = await adminAuth.getUser(uid);
      existingClaims = userRecord.customClaims || {};
    } catch (error: any) {
      console.warn(`[admin/set-role] Could not fetch existing claims for uid=${uid}:`, error.message);
      // Continue with empty claims - will set admin claim only
    }

    // Merge existing claims with new admin claim
    const customClaims = {
      ...existingClaims,
      admin: role === "admin",
    };
    
    await adminAuth.setCustomUserClaims(uid, customClaims);
    console.log(`[admin/set-role] Updated custom claims for uid=${uid}`, {
      role,
      adminClaim: customClaims.admin,
    });

    // Update Firestore users document
    if (!adminDb || !firebaseAdmin) {
      console.error("[admin/set-role] Firestore is not available");
      return NextResponse.json(
        { error: "Firestore is not available" },
        { status: 500 }
      );
    }
    
    await adminDb.collection("users").doc(uid).set(
      {
        role,
        updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true } // Don't overwrite other fields
    );
    console.log(`[admin/set-role] Updated Firestore role for uid=${uid}`);

    return NextResponse.json({
      ok: true,
      uid,
      role,
      message: `User role updated to ${role}`,
    });
  } catch (error: any) {
    console.error("[admin/set-role] Error updating role:", error);
    return NextResponse.json(
      { error: "Internal server error", message: error.message },
      { status: 500 }
    );
  }
}
