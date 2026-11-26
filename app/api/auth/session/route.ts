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
import { adminAuth as firebaseAdminAuth } from "@/lib/firebase/admin";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { logAuthSessionEvent } from "@/lib/authTelemetry";
import { logger } from "@/lib/logger";
import { startVerificationDeadline, type VerificationOutcome } from "@/lib/auth/authVerificationDeadline";
import { isVerifierUnavailableCode } from "@/lib/auth/resolveRequestIdentity";

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

/**
 * "The verifier could not run" vs "the credential is bad" (Stage 0 F1): the SAME
 * nine exact firebase-admin codes as `resolveRequestIdentity`
 * (`isVerifierUnavailableCode`, listed and justified there), applied to both the
 * `checkRevoked` live read and `createSessionCookie`. Anything else is a
 * credential failure (401) or, for cookie creation, the existing 500.
 * LIMITATION: a Google public-key fetch failure surfaces as
 * `auth/argument-error`, indistinguishable from a forged token, so that outage
 * answers 401 — fail closed either way.
 */
function errorCodeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

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

  // A local const: its null-check narrowing also holds inside the deadline closures below.
  const adminAuth = firebaseAdminAuth;
  if (!adminAuth) {
    logger.error("[auth-session] POST failed: Firebase Admin Auth is not initialized");
    return noStore(NextResponse.json({ error: "Authentication service unavailable" }, { status: 500 }));
  }

  // uid is derived EXCLUSIVELY from server-side verification of the token
  // the client sent — the client never gets to assert its own uid, here or
  // anywhere else in this route.
  //
  // checkRevoked = true (SESSREV): the SDK then reads the live Auth record
  // (`getUser`) and rejects a DISABLED account (`auth/user-disabled`) and a
  // token whose `auth_time` predates `tokensValidAfterTime`
  // (`auth/id-token-revoked`). Without it, `verifyIdToken` checks signature and
  // expiry only, and `createSessionCookie` performs no live-record check of
  // its own in the SDK — so a still-unexpired ID token of a revoked or disabled
  // identity would be exchanged for a fresh five-day cookie. Downstream cookie
  // verifiers re-check both on every request, but the mint itself must refuse.
  //
  // R5 (deadline): the live read and the cookie creation are each an Identity
  // Toolkit round trip, and firebase-admin has no per-call timeout we can set
  // (a hung upstream held this route ~132 s). Both run under ONE end-to-end
  // deadline (AUTH_VERIFICATION_DEADLINE_MS, shared with resolveRequestIdentity,
  // including its per-instance cap on in-flight verifications). A call still
  // pending at the deadline — or refused at the cap — answers the same 503 as a
  // verifier outage; a result that arrives later is never read, so a late valid
  // verification can never reach createSessionCookie and a late cookie is never set.
  const deadline = startVerificationDeadline("session_mint");
  try {
    const verified = await deadline.run(() => adminAuth.verifyIdToken(idToken, true));
    if (verified.kind === "deadline" || verified.kind === "capped") {
      return verificationUnavailable("identity verification unavailable", verified.kind);
    }
    let decodedUid: string;
    try {
      if (verified.kind === "rejected") throw verified.error;
      const decoded = verified.value;
      if (typeof decoded?.uid !== "string" || decoded.uid === "") {
        throw Object.assign(new Error("decoded token has no uid"), { code: "auth/invalid-id-token" });
      }
      decodedUid = decoded.uid;
    } catch (err) {
      const code = errorCodeOf(err);
      if (isVerifierUnavailableCode(code)) {
        // The verifier could not run (Auth backend / network) — not a verdict on
        // the credential. Fail closed with 503 so no cookie is minted, but do not
        // tell the client its token is bad.
        logger.error("[auth-session] POST failed: identity verification unavailable", { errorCode: code });
        logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "auth_unavailable" });
        return authUnavailableResponse();
      }
      // Disabled and revoked are deliberately indistinguishable from an invalid
      // token in the response body (no account-state disclosure); the category
      // is recorded server-side only.
      const failureCategory =
        code === "auth/user-disabled" ? "account_disabled" : code.includes("revoked") ? "revoked_token" : "invalid_token";
      logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory });
      return noStore(NextResponse.json({ error: "Invalid or expired token" }, { status: 401 }));
    }

    const created = await deadline.run(() => adminAuth.createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_MS }));
    if (created.kind === "deadline" || created.kind === "capped") {
      return verificationUnavailable("session cookie creation unavailable", created.kind);
    }
    if (created.kind === "rejected") {
      // Code only: a provider error message may echo request content (the ID token); never log it.
      const createCode = errorCodeOf(created.error);
      if (isVerifierUnavailableCode(createCode)) {
        // The same "service could not run" codes as the verifier above. The identity was verified, but no cookie
        // could be created, so fail closed with the same 503 (no cookie set) — not a verdict on the credential.
        logger.error("[auth-session] POST failed: session cookie creation unavailable", { errorCode: createCode });
        logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "auth_unavailable" });
        return authUnavailableResponse();
      }
      logger.error("[auth-session] POST failed: session cookie creation threw", { errorCode: createCode });
      logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "cookie_creation_failed" });
      return noStore(NextResponse.json({ error: "Failed to create session" }, { status: 500 }));
    }
    return mintedResponse(decodedUid, created.value);
  } finally {
    deadline.dispose();
  }
}

/**
 * The deadline / cap answer: the route's existing verifier-outage 503 (same
 * body and telemetry category). The cut-off itself is logged by the deadline
 * module (`[auth-verification] deadline_exceeded`; cap refusals are counted and
 * reported by the rate-limited `[auth-verification] saturated` signal).
 */
function verificationUnavailable(step: string, cause: Exclude<VerificationOutcome<unknown>["kind"], "fulfilled" | "rejected">): NextResponse {
  logger.error(`[auth-session] POST failed: ${step}`, { cause });
  logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "auth_unavailable" });
  return authUnavailableResponse();
}

/**
 * Stage 0 (identity isolation, owner D-7): the single "verification could not run" answer: HTTP 503 plus the
 * machine-readable `code: "auth_unavailable"` (the same code that getRequestUid / reportReviewCaller answer). No
 * cookie is set, and the body says nothing about the account. How the current client handles it
 * (`lib/client/sessionSync.ts`, `components/AuthProvider.tsx`, Stage 0 F3):
 *  - a same-uid token refresh of an already-confirmed session keeps its existing cookie and state (no sign-out);
 *  - every other mint (sign-in, cold load, account switch) ends as `server_error`: the cookie is cleared and Firebase
 *    is signed out, exactly as for any other failure. The client never retries a 503 automatically.
 */
const SESSION_AUTH_UNAVAILABLE_CODE = "auth_unavailable";
function authUnavailableResponse(): NextResponse {
  return noStore(
    NextResponse.json({ error: "Authentication service unavailable", code: SESSION_AUTH_UNAVAILABLE_CODE }, { status: 503 })
  );
}

function mintedResponse(decodedUid: string, sessionCookie: string): NextResponse {
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
