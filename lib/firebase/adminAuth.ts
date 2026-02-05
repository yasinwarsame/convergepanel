/**
 * Admin Authentication Helper
 * 
 * Server-side helper to verify Firebase ID tokens and check admin claims.
 * Used by admin API routes to authenticate requests.
 */

import "server-only";
import { NextRequest } from "next/server";
import { adminAuth } from "./admin";

/**
 * Get authenticated user from request
 * 
 * Extracts and verifies Firebase ID token from Authorization header.
 * Returns decoded token with uid, email, and custom claims (including admin).
 * 
 * @param request - Next.js request object
 * @returns Decoded token with user info and claims, or null if invalid/missing
 * 
 * Example usage in API routes:
 *   const decoded = await getRequestUser(request);
 *   if (!decoded || !decoded.admin) {
 *     return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 *   }
 */
export async function getRequestUser(request: NextRequest) {
  if (!adminAuth) {
    console.error("[adminAuth] Firebase Admin Auth is not initialized");
    return null;
  }

  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/i);
  const idToken = match?.[1];

  if (!idToken) {
    console.log("[adminAuth] No ID token found in Authorization header");
    return null;
  }

  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    return decoded; // contains uid, email, and custom claims (e.g., decoded.admin)
  } catch (error: any) {
    console.error("[adminAuth] Token verification failed:", {
      message: error?.message,
      code: error?.code,
    });
    return null;
  }
}
