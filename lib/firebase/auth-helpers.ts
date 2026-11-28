/**
 * Firebase Authentication Helpers (Server-Side)
 * 
 * These utilities verify Firebase ID tokens in API routes and check for admin claims.
 * They use the Firebase Admin SDK which can verify tokens and read custom claims.
 * 
 * IMPORTANT: These functions are server-only and must never run in the browser.
 */

import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import { NextRequest } from "next/server";
import {
  resolveLiveAuthIdentity,
  resolveVerifiedAdminScopes,
} from "@/lib/admin/verifiedAdminIdentity";
import { adminAuth } from "./admin";

/**
 * Verify Firebase ID token from request and check admin claim
 * 
 * This function:
 * 1. Extracts the Firebase ID token from the request (Authorization header only)
 * 2. Verifies the token using Firebase Admin SDK (ensures it's valid and not expired)
 * 3. Checks if the user has the admin custom claim
 * 4. Returns user info if valid, null if invalid
 * 
 * @param request - Next.js request object
 * @returns User ID and admin status, or null if token is invalid/missing
 */
export async function verifyAdminToken(
  request: NextRequest
): Promise<{ uid: string; isAdmin: boolean } | null> {
  try {
    // Check if adminAuth is available
    if (!adminAuth) {
      console.error("[auth-helpers] Firebase Admin Auth is not initialized");
      return null;
    }

    // Bearer token from the Authorization header — the only credential accepted.
    // ZCA L-8: bearer only (it used to fall back to the `__session` cookie). No route imports this legacy
    // helper (pinned by the authSurface static oracle); it must not become a cookie path if one ever does.
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.replace(/^Bearer\s+/i, "").trim() || "";

    if (!token) {
      // No token provided
      console.log("[auth-helpers] No token found in request");
      return null;
    }

    // Verify the token using Firebase Admin SDK
    // This ensures the token is valid, not expired, and issued by our Firebase project
    const decodedToken = await adminAuth.verifyIdToken(token, true);
    
    // Check if user has admin custom claim
    // IMPORTANT: Firebase Admin SDK returns custom claims as top-level properties on the decoded token,
    // NOT in a `claims` property. So we read `decodedToken.admin` directly, not `decodedToken.claims.admin`
    const isAdmin = decodedToken.admin === true;

    // Extract custom claims (non-reserved top-level keys)
    const RESERVED_TOKEN_KEYS = new Set([
      "aud", "auth_time", "email", "email_verified", "exp", "firebase",
      "iat", "iss", "name", "picture", "sub", "uid", "user_id"
    ]);
    const customClaims: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(decodedToken)) {
      if (!RESERVED_TOKEN_KEYS.has(key)) {
        customClaims[key] = value;
      }
    }
    const claimsKeys = Object.keys(customClaims);

    if (process.env.NODE_ENV !== "production") {
      console.log("[auth-helpers] Token verified:", {
        uid: decodedToken.uid,
        isAdmin,
        hasAdminClaim: decodedToken.admin,
      });
    }

    return {
      uid: decodedToken.uid,
      isAdmin,
    };
  } catch (error: any) {
    // Token verification failed (invalid, expired, or malformed)
    console.error("[auth-helpers] Token verification failed:", {
      message: error?.message,
      code: error?.code,
    });
    return null;
  }
}

/*
 * ZCA P3 R2 ("verify, don't mint"): the session-cookie verifiers that used to live here were removed.
 * No production code reads or verifies the `__session` cookie; the static oracle in
 * __tests__/authSurface/ bans their names everywhere outside tests.
 */

/**
 * SYSTEM_ADMIN — the stronger application-administration tier.
 *
 * SEC-3 / S2-b: NO ROUTE CALLS THIS ANY MORE. Every privileged route is gated
 * by `requirePrivilegedAccess` (lib/admin/privilegedAccess.ts). Kept only until
 * its remaining unit specs are retired; app/api/admin/__tests__/privilegedGuardPin.spec.ts
 * fails if any file under app/ (or middleware) calls it again.
 *
 * Source: the Firebase custom claim `admin === true` ONLY. It is never
 * email-derived, so an `ADMIN_EMAILS` member can never reach the capabilities
 * behind it: provider-credential access, admin-claim minting, bulk purge, and
 * destructive account and billing mutation. Widening any of those to the
 * allowlist would make the allowlist self-escalating.
 *
 * SYSTEM_ADMIN inherently satisfies ADMIN_PORTAL, because the same claim also
 * satisfies `requireAdminPortalAccess`.
 *
 * Require admin authentication for a route
 * 
 * This is a convenience function that verifies the token AND ensures the user is an admin.
 * Use this in API routes that require admin access.
 * 
 * @param request - Next.js request object
 * @returns User info if authenticated admin, null if not admin or not authenticated
 * 
 * Example usage in API route:
 *   const auth = await requireAdmin(request);
 *   if (!auth) {
 *     return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 *   }
 */
export async function requireSystemAdminAccess(
  request: NextRequest
): Promise<{ uid: string; isAdmin: boolean } | null> {
  const auth = await verifyAdminToken(request);

  // Return null if not authenticated or not an admin
  if (!auth || !auth.isAdmin) {
    return null;
  }

  return auth;
}

/**
 * ADMIN_PORTAL — the portal/support capability family.
 *
 * SEC-3 / S2-b: NO ROUTE CALLS THIS ANY MORE. Every privileged route is gated
 * by `requirePrivilegedAccess` (lib/admin/privilegedAccess.ts). Kept only until
 * its remaining unit specs are retired; app/api/admin/__tests__/privilegedGuardPin.spec.ts
 * fails if any file under app/ (or middleware) calls it again.
 *
 * Source: the Firebase `admin` custom claim (which is SYSTEM_ADMIN, and
 * therefore also satisfies this) OR a VERIFIED `ADMIN_EMAILS` member.
 *
 * This is deliberately NOT "full application admin": it grants only the routes
 * intentionally guarded by this function. The stronger tier is SYSTEM_ADMIN
 * (`requireSystemAdminAccess`), which is claim-only.
 *
 * Phase FIRESTORE-AUTHZ-P0.2. This guard previously granted admin authority on
 * `isAdminEmail(email)` where `email` came from the ID token — or, when the
 * token carried none, from the Auth record — with no proof that the identity
 * owned the address. Since any registration claims any unclaimed address, that
 * handed an attacker `/api/admin/users`, `/api/admin/runs`,
 * `/api/admin/sync-subscription` and the rest of this surface.
 *
 * The two authorities are now explicitly separate:
 *
 *   1. `decoded.admin === true` — server-issued custom claim, independently
 *      trusted, UNCHANGED. It deliberately does not require a verified email:
 *      it carries its own proof, and a custom-claim admin may legitimately hold
 *      an address that is on no allowlist.
 *   2. the APPLICATION-ADMIN allowlist (`ADMIN_EMAILS`) — requires a LIVE Auth
 *      record whose email is on that list AND whose `emailVerified` is true.
 *      The token's email never grants anything, so a token address and a
 *      record's verification flag can never be combined.
 *
 * Phase FIRST-ADMIN-C1: this reads `ADMIN_EMAILS` ONLY. It previously used a
 * blended predicate, so a governance administrator silently received this
 * entire admin API surface. Governance membership alone now grants nothing
 * here.
 *
 * Auth lookup failure denies.
 */
export async function requireAdminPortalAccess(
  request: NextRequest
): Promise<{ uid: string; email: string } | null> {
  if (!adminAuth) return null;
  // ZCA L-8: bearer only, revocation-checked (it used to fall back to the `__session` cookie and to
  // the session-cookie verifier). No route imports this legacy helper (pinned by the authSurface static oracle).
  const authHeader = request.headers.get("authorization");
  const raw = authHeader?.replace(/^Bearer\s+/i, "")?.trim();
  if (!raw) return null;

  const allow = async (decoded: DecodedIdToken): Promise<{ uid: string; email: string } | null> => {
    // (1) Server-issued custom claim — independently sufficient, as before. The
    // returned email is descriptive only; it is not what granted access, so
    // falling back to the record for a display value cannot widen authority.
    if (decoded.admin === true) {
      let email = typeof decoded.email === "string" ? decoded.email : "";
      if (!email) {
        const live = await resolveLiveAuthIdentity(decoded.uid);
        if (live.status === "resolved") email = live.email;
      }
      return { uid: decoded.uid, email };
    }

    // (2) ADMIN_PORTAL via the ADMIN_EMAILS allowlist — resolved by a uid-only
    // authority function that performs its own live Auth read. Nothing here can
    // hand it an email or a verification flag.
    const scopes = await resolveVerifiedAdminScopes(decoded.uid);
    if (!scopes.adminPortal) return null;
    return { uid: decoded.uid, email: scopes.email };
  };

  try {
    const decoded = await adminAuth.verifyIdToken(raw, true);
    return await allow(decoded);
  } catch {
    return null;
  }
}

/**
 * Check if a user is an admin from a decoded ID token
 * 
 * Server-side helper that checks admin status from Firebase custom claims.
 * This is the source of truth for admin access control.
 * 
 * @param decodedToken - Decoded Firebase ID token (from verifyIdToken)
 * @returns true if user has admin custom claim, false otherwise
 * 
 * Example usage:
 *   const decoded = await verifyIdToken(token);
 *   const isAdmin = checkIsAdmin(decoded);
 */
export function checkIsAdmin(decodedToken: { admin?: boolean }): boolean {
  // Custom claims are top-level properties on the decoded token, not in a claims object
  return decodedToken.admin === true;
}

/**
 * Check if a user is an admin from an ID token string
 * 
 * Convenience function that verifies the token and checks admin status in one call.
 * 
 * @param token - Firebase ID token string
 * @returns true if user has admin custom claim, false otherwise
 * @throws Error if token verification fails
 * 
 * Example usage:
 *   const isAdmin = await checkIsAdminFromToken(token);
 */
export async function checkIsAdminFromToken(token: string): Promise<boolean> {
  if (!adminAuth) {
    throw new Error("Firebase Admin Auth is not initialized");
  }
  
  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    // Custom claims are top-level properties on the decoded token, not in a claims object
    return decodedToken.admin === true;
  } catch (error) {
    // Token verification failed - user is not authenticated, so not admin
    return false;
  }
}


/**
 * @deprecated Ambiguous name. Use `requireAdminPortalAccess` (ADMIN_PORTAL) or
 * `requireSystemAdminAccess` (SYSTEM_ADMIN) so the tier is explicit at the call
 * site. Kept only so an unmigrated caller fails loudly in review rather than
 * silently choosing the wrong tier.
 */
export const requireAdminApiAccess = requireAdminPortalAccess;

/** @deprecated Ambiguous name. Use `requireSystemAdminAccess`. */
export const requireAdmin = requireSystemAdminAccess;
