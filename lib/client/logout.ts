"use client";

/**
 * The ONE explicit-logout sequence, shared by every user-initiated sign-out entry point (TopNav and
 * the profile page). ZCA P3 R2 "verify, don't mint": there is no server session to clear, so logout
 * is purely local.
 *
 *   1. `beginLogout()` — protected operations are disabled at once (`canMutate` false).
 *   2. Firebase `signOut` — LOCAL: it clears the persisted Firebase user in this browser and notifies
 *      every tab. After it there is no token, so every API call is anonymous. The AuthProvider's null
 *      branch aborts any in-flight handshake and clears identity-scoped client data.
 *   3. If the local sign-out THREW: `cancelLogout()` (AuthProvider). If Firebase still reports a user,
 *      the tab is re-verified from scratch (`canMutate` stays false until a fresh server verification
 *      for that uid) and the logout is NOT reported as completed. If Firebase reports nobody, the tab
 *      takes the ordinary signed-out transition and the logout is reported as completed.
 *
 * Nothing here sends a request: no client DELETE exists anywhere (R2 MA, invariant 5).
 */
import { signOut as firebaseSignOut, type Auth } from "firebase/auth";

/** Where every completed logout goes. */
export const LOGIN_HREF_AFTER_LOGOUT = "/login?signedOut=1";

export type LogoutResult = { signedOut: true } | { signedOut: false };

export type LogoutDeps = {
  auth: Auth;
  beginLogout: () => void;
  cancelLogout: () => void;
  /** Injection point for tests; production uses Firebase `signOut`. */
  signOut?: (auth: Auth) => Promise<void>;
};

export async function performLogout(deps: LogoutDeps): Promise<LogoutResult> {
  deps.beginLogout();
  try {
    await (deps.signOut ?? firebaseSignOut)(deps.auth);
  } catch {
    // The local sign-out failed. Hand the tab back to the AuthProvider (re-verify, or the signed-out
    // transition), and report completion only if Firebase really reports nobody.
    deps.cancelLogout();
    return deps.auth.currentUser === null ? { signedOut: true } : { signedOut: false };
  }
  return { signedOut: true };
}
