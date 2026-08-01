/**
 * Session Cookie API Endpoint — Auth Lifecycle Hardening, Step 6.4.
 *
 * Creates, clears, and reads the server `__session` cookie that every
 * protected API route resolves identity from first (`getRequestUid()`,
 * `lib/teams/teamApiAuth.ts`; `verifySessionCookie()`,
 * `lib/firebase/auth-helpers.ts`). This is the single place a client ID
 * token is ever exchanged for that cookie, and the single place it is ever
 * cleared — `lib/client/sessionSync.ts` is the only client-side caller.
 *
 * Route: POST/DELETE/GET /api/auth/session
 */

import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase/admin";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { logAuthSessionEvent } from "@/lib/authTelemetry";
import { logger } from "@/lib/logger";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

/**
 * Cookie attributes shared by every Set-Cookie this route issues — the
 * creation (`POST`) and deletion (`DELETE`) responses MUST use IDENTICAL
 * `path`/`secure`/`sameSite` (and no `domain` override, so both default to
 * the exact request host) or the browser can end up treating them as two
 * different cookies, leaving the original still present after a "delete."
 */
const SESSION_COOKIE_NAME = "__session";
const SESSION_COOKIE_BASE_ATTRS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};
const SESSION_MAX_AGE_MS = 60 * 60 * 24 * 5 * 1000; // 5 days

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(NextResponse.json({ error: "Invalid request body" }, { status: 400 }));
  }

  const idToken = (body as { idToken?: unknown } | null)?.idToken;
  if (!idToken || typeof idToken !== "string") {
    return noStore(NextResponse.json({ error: "ID token is required" }, { status: 400 }));
  }

  if (!adminAuth) {
    logger.error("[auth-session] POST failed: Firebase Admin Auth is not initialized");
    return noStore(NextResponse.json({ error: "Authentication service unavailable" }, { status: 500 }));
  }

  // uid is derived EXCLUSIVELY from server-side verification of the token
  // the client sent — the client never gets to assert its own uid, here or
  // anywhere else in this route.
  let decodedUid: string;
  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    decodedUid = decoded.uid;
  } catch {
    logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "invalid_token" });
    return noStore(NextResponse.json({ error: "Invalid or expired token" }, { status: 401 }));
  }

  let sessionCookie: string;
  try {
    sessionCookie = await adminAuth.createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_MS });
  } catch (err) {
    logger.error("[auth-session] POST failed: session cookie creation threw", { message: err instanceof Error ? err.message : String(err) });
    logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "cookie_creation_failed" });
    return noStore(NextResponse.json({ error: "Failed to create session" }, { status: 500 }));
  }

  const response = NextResponse.json({ authenticated: true, uid: decodedUid });
  response.cookies.set(SESSION_COOKIE_NAME, sessionCookie, {
    ...SESSION_COOKIE_BASE_ATTRS,
    maxAge: SESSION_MAX_AGE_MS / 1000,
  });
  logAuthSessionEvent("session_sync_succeeded", { route: "POST /api/auth/session" });
  return noStore(response);
}

/**
 * DELETE — clears the session cookie. Idempotent: always returns 200
 * whether or not a cookie was present, so a caller never needs to check
 * existence first, and a retried DELETE is always safe.
 */
export async function DELETE(_request: NextRequest) {
  const response = NextResponse.json({ authenticated: false });
  // `attributes` (not just the name) must match creation exactly — Next.js's
  // `.delete(name)` shorthand omits `secure`/`sameSite`, which can leave the
  // browser treating this as a different cookie and NOT actually clearing
  // the one `POST` set. Setting an already-expired cookie with the SAME
  // attributes is the only reliable way to delete it cross-browser.
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    ...SESSION_COOKIE_BASE_ATTRS,
    maxAge: 0,
  });
  logAuthSessionEvent("session_cleared", { route: "DELETE /api/auth/session" });
  return noStore(response);
}

/**
 * GET — reports whether the caller currently has a valid session, and if
 * so, its uid. Returns ONLY `{ authenticated, uid? }` — never email,
 * claims, the token/cookie itself, team data, or a raw verification error.
 * This is the read side of the Step 6.9 client/server identity check.
 */
export async function GET(request: NextRequest) {
  try {
    const result = await verifySessionCookie(request);
    if (!result) {
      return noStore(NextResponse.json({ authenticated: false }));
    }
    return noStore(NextResponse.json({ authenticated: true, uid: result.uid }));
  } catch {
    // Expired/revoked/malformed cookie — never a raw error, never a 500;
    // from the caller's point of view this is indistinguishable from "no
    // session," which is the correct, fail-closed behavior.
    logAuthSessionEvent("revoked_or_expired_session", { route: "GET /api/auth/session" });
    return noStore(NextResponse.json({ authenticated: false }));
  }
}
