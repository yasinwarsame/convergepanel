/**
 * Firebase Authentication Helpers
 */

import "server-only";
import { adminAuth, FIREBASE_PROJECT_ID } from "./admin";

export async function verifyIdToken(token: string) {
  // Diagnostic: log adminAuth state
  console.log("[auth] verifyIdToken called", {
    hasAdminAuth: !!adminAuth,
    verifyIdTokenType: typeof adminAuth?.verifyIdToken,
    tokenLength: token?.length || 0,
    projectId: FIREBASE_PROJECT_ID,
  });
  
  if (!adminAuth) {
    throw new Error(
      `Firebase Admin Auth is not initialized. Check FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY environment variables. Expected project ID: ${FIREBASE_PROJECT_ID}`
    );
  }
  
  if (typeof adminAuth.verifyIdToken !== "function") {
    throw new Error(
      `adminAuth.verifyIdToken is not a function (got ${typeof adminAuth.verifyIdToken}). Firebase Admin Auth may not be properly initialized.`
    );
  }
  
  try {
    // checkRevoked = true (BEARERREV): the SDK reads the live Auth record
    // (`getUser`) and rejects a DISABLED account (`auth/user-disabled`) and a
    // token whose `auth_time` predates `tokensValidAfterTime`
    // (`auth/id-token-revoked`). With `false` it checked signature and expiry
    // only, so a revoked or disabled identity's still-unexpired ID token (≤1 h)
    // authenticated every resolveRequestIdentity route as a bearer credential.
    const decoded = await adminAuth.verifyIdToken(token, true);
    return decoded;
  } catch (error: any) {
    // Enhanced diagnostic logging (no token contents)
    console.error("[auth] verifyIdToken error:", {
      message: error?.message,
      code: error?.code,
      name: error?.name,
      expectedProjectId: FIREBASE_PROJECT_ID,
      tokenLength: token?.length || 0,
      hasAdminAuth: !!adminAuth,
      verifyIdTokenType: typeof adminAuth?.verifyIdToken,
    });
    
    const authError = new Error("INVALID_ID_TOKEN");
    (authError as any).cause = error;
    // Carry the Firebase code (never the message) so the caller can tell a
    // revoked / disabled / expired credential from a verifier outage.
    // Without it every failure classified as a generic invalid token.
    if (typeof error?.code === "string") (authError as any).code = error.code;
    throw authError;
  }
}
