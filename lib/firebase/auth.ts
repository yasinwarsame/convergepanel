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
    const decoded = await adminAuth.verifyIdToken(token, false);
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
    throw authError;
  }
}
