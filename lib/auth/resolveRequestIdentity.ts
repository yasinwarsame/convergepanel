/**
 * Repository-Wide Auth Identity Consistency Remediation, Step 7 (Recovery
 * revision) — the ONE shared, hardened credential-resolution contract
 * every protected route uses. Generalizes the fix Step 6 applied to
 * `lib/teams/teamApiAuth.ts`'s `getRequestUid()` (team/governance routes)
 * so the same fix is reused verbatim by every other route that
 * independently duplicated the old, vulnerable pattern: checking the
 * `__session` cookie first and trusting it UNCONDITIONALLY whenever
 * present, never even inspecting a request's `Authorization: Bearer`
 * token. `getRequestUid()` and `resolveGovernanceRequestUser()` are both
 * thin wrappers around this module — this is the single source of truth,
 * never a forked implementation.
 *
 * **Recovery revision — strict dual-credential validation.** The
 * original Step 7 version deliberately preserved a narrower carve-out:
 * "valid cookie + merely invalid/expired bearer" authenticated via the
 * cookie alone, reasoning that an expiring access token is routine, not
 * evidence of conflict. Live verification against the real running server
 * exposed why that carve-out was still unsafe: a genuinely STALE cookie
 * for user A, presented alongside an EXPIRED bearer token that was
 * actually issued for a DIFFERENT user B, authenticated the request as A
 * — silently discarding the (expired, but real) evidence that the caller
 * was presenting credentials for two different identities. An expired
 * token cannot be verified for identity, but its mere presence, alongside
 * a cookie, is still a second, distinct credential the caller is
 * asserting — and an unverifiable second credential must never be
 * silently dropped in favor of the one that happens to work. This
 * revision closes that gap: whenever BOTH a cookie and a bearer credential
 * are PRESENT on a request (regardless of validity), BOTH must
 * independently verify AND resolve to the SAME uid, or the request fails
 * closed. There is no longer any "one wins over the other" case.
 *
 * Full root-cause writeup: docs/operations/auth-session-sync-runbook.md.
 */

import "server-only";
import type { NextRequest } from "next/server";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";

export type RequestIdentitySource = "session_cookie" | "bearer_token" | "matching_cookie_and_bearer";

export type RequestIdentityUnauthenticatedReason =
  | "missing_credentials"
  | "invalid_session_cookie"
  | "invalid_bearer_token"
  | "credential_mismatch"
  | "revoked_session"
  | "expired_session";

export type RequestIdentityResult =
  | { status: "authenticated"; uid: string; source: RequestIdentitySource }
  | { status: "unauthenticated"; reason: RequestIdentityUnauthenticatedReason };

type CredentialCheck =
  | { present: false }
  | { present: true; ok: true; uid: string }
  | { present: true; ok: false; reason: RequestIdentityUnauthenticatedReason };

/**
 * A credential is "present" whenever the caller sent SOMETHING in that
 * slot — an empty/absent value is `present: false` (that slot simply
 * wasn't used); anything else that fails to verify is `present: true, ok:
 * false` — a MALFORMED Authorization header (wrong scheme, empty token
 * after "Bearer ") counts as present-but-invalid, not absent, so it can
 * never be silently treated as "no bearer credential was offered."
 */
function extractBearerToken(request: NextRequest): { present: boolean; token: string | null } {
  const authHeader = request.headers.get("authorization");
  if (authHeader === null || authHeader.trim() === "") return { present: false, token: null };
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const token = match?.[1]?.trim();
  return { present: true, token: token && token.length > 0 ? token : null };
}

/**
 * Classifies a thrown Firebase Admin verification error into a specific,
 * safe (never includes the raw error message/token/uid) reason. Firebase
 * Admin SDK errors carry a stable `.code` (e.g.
 * `auth/session-cookie-revoked`, `auth/id-token-expired`) — falls back to
 * the generic `invalid_*` reason for anything else (malformed, wrong
 * project, signature failure, etc).
 */
function classifyVerificationError(err: unknown, kind: "cookie" | "bearer"): RequestIdentityUnauthenticatedReason {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code) : "";
  if (code.includes("revoked")) return "revoked_session";
  if (code.includes("expired")) return "expired_session";
  return kind === "cookie" ? "invalid_session_cookie" : "invalid_bearer_token";
}

/**
 * `verifySessionCookie()`'s own contract already distinguishes "absent"
 * (returns `null`) from "present but invalid/expired/revoked" (throws) —
 * deliberately relied on directly here rather than duplicating a raw
 * `request.cookies.get("__session")` presence check, which would both be
 * redundant and (if it read the raw request instead of trusting this
 * function's own return) diverge from what every existing caller already
 * mocks `verifySessionCookie` to represent.
 */
async function checkCookie(request: NextRequest): Promise<CredentialCheck> {
  try {
    const auth = await verifySessionCookie(request);
    if (auth) return { present: true, ok: true, uid: auth.uid };
    return { present: false };
  } catch (err) {
    return { present: true, ok: false, reason: classifyVerificationError(err, "cookie") };
  }
}

async function checkBearer(request: NextRequest): Promise<CredentialCheck> {
  const { present, token } = extractBearerToken(request);
  if (!present) return { present: false };
  if (!token) return { present: true, ok: false, reason: "invalid_bearer_token" };
  try {
    const decoded = await verifyIdToken(token);
    return { present: true, ok: true, uid: decoded.uid };
  } catch (err) {
    return { present: true, ok: false, reason: classifyVerificationError(err, "bearer") };
  }
}

/**
 * Resolves the authenticated identity for a request, considering BOTH the
 * `__session` cookie and an `Authorization` header when either is
 * present. Strict truth table — no case falls through to "whichever
 * credential happened to validate":
 *
 * | Cookie present? | Bearer present? | Result |
 * |---|---|---|
 * | no | no | unauthenticated: missing_credentials |
 * | no | valid | authenticated via bearer_token |
 * | no | invalid/expired/revoked/malformed | unauthenticated (bearer's own reason) |
 * | valid | no | authenticated via session_cookie |
 * | invalid/expired/revoked | no | unauthenticated (cookie's own reason) |
 * | valid | valid, SAME uid | authenticated via matching_cookie_and_bearer |
 * | valid | valid, DIFFERENT uid | unauthenticated: credential_mismatch |
 * | valid | invalid/expired/revoked/malformed | unauthenticated (bearer's own reason) — no cookie fallback |
 * | invalid/expired/revoked | valid | unauthenticated (cookie's own reason) — no bearer fallback |
 * | invalid/expired/revoked | invalid/expired/revoked | unauthenticated (cookie's own reason) |
 *
 * Both credential checks run independently (cookie first, then bearer) —
 * whenever BOTH are present, BOTH must be inspected before a decision is
 * made; neither is ever skipped merely because the other already failed
 * or succeeded. This is the direct fix for a live-verified gap: a stale
 * cookie for user A alongside an EXPIRED bearer token actually issued for
 * a DIFFERENT user B must not authenticate as A — the expired token is
 * still evidence of a second, unverifiable identity claim, not something
 * to silently discard.
 */
export async function resolveRequestIdentity(request: NextRequest): Promise<RequestIdentityResult> {
  const cookie = await checkCookie(request);
  const bearer = await checkBearer(request);

  if (!cookie.present && !bearer.present) {
    return { status: "unauthenticated", reason: "missing_credentials" };
  }

  if (cookie.present && !bearer.present) {
    return cookie.ok
      ? { status: "authenticated", uid: cookie.uid, source: "session_cookie" }
      : { status: "unauthenticated", reason: cookie.reason };
  }

  if (!cookie.present && bearer.present) {
    return bearer.ok
      ? { status: "authenticated", uid: bearer.uid, source: "bearer_token" }
      : { status: "unauthenticated", reason: bearer.reason };
  }

  // Both present — strict: both must independently validate AND agree.
  // (TypeScript can't narrow `present: boolean` across the two earlier,
  // independent `if` blocks above, so re-assert both are the `present:
  // true` variant explicitly here rather than relying on elimination.)
  if (!cookie.present || !bearer.present) {
    // Unreachable given the three branches above already handle every
    // other combination — kept as an explicit fail-closed fallback
    // rather than a non-null assertion.
    return { status: "unauthenticated", reason: "missing_credentials" };
  }
  if (cookie.ok && bearer.ok) {
    if (cookie.uid !== bearer.uid) {
      return { status: "unauthenticated", reason: "credential_mismatch" };
    }
    return { status: "authenticated", uid: cookie.uid, source: "matching_cookie_and_bearer" };
  }
  // At least one of the two presented credentials failed to validate —
  // fail closed, reporting whichever one failed (cookie's reason takes
  // precedence if BOTH failed, matching the pre-recovery convention of
  // treating the cookie as the primary credential for error reporting).
  if (!cookie.ok) return { status: "unauthenticated", reason: cookie.reason };
  return { status: "unauthenticated", reason: (bearer as { ok: false; reason: RequestIdentityUnauthenticatedReason }).reason };
}
