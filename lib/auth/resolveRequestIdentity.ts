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
import { startVerificationDeadline, type VerificationDeadline, type VerificationOutcome } from "./authVerificationDeadline";

export type RequestIdentitySource = "session_cookie" | "bearer_token" | "matching_cookie_and_bearer";

export type RequestIdentityUnauthenticatedReason =
  | "missing_credentials"
  | "invalid_session_cookie"
  | "invalid_bearer_token"
  | "credential_mismatch"
  | "revoked_session"
  | "expired_session"
  // BEARERREV: the verifier itself could not run (Auth backend / network) —
  // the live `checkRevoked` read failed. Still `unauthenticated` (never an
  // allow); wrappers that can answer 503 do so (teamApiAuth.getRequestUid,
  // reportReviewCaller); every other route answers its existing 401.
  | "auth_unavailable";

/**
 * R4o C1 / R5 C — END-TO-END deadline for credential verification, per
 * request, covering every presented credential (cookie and bearer are
 * verified concurrently, so one deadline bounds both), plus the per-instance
 * cap on verifications abandoned at that deadline. Both live in
 * `./authVerificationDeadline` (shared with the session mint, POST
 * /api/auth/session); the rationale for 10 s and for the cap is there.
 * Re-exported here for existing importers.
 */
export { AUTH_VERIFICATION_DEADLINE_MS } from "./authVerificationDeadline";

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
/**
 * firebase-admin 12.x codes meaning "the verifier could not run", not "the
 * credential is bad" — raised by the `checkRevoked` `getUser` read (or the
 * SDK's own HTTP layer under it). Exact codes only; anything else is a
 * credential failure (see the policy note below).
 *
 *   auth/internal-error           — AuthClientErrorCode.INTERNAL_ERROR; also the
 *                                   SDK's mapping for any UNMAPPED server code
 *                                   (e.g. a 429/500 `RESOURCE_EXHAUSTED`/`INTERNAL` body)
 *   auth/quota-exceeded           — server `QUOTA_EXCEEDED` (Identity Toolkit project quota)
 *   auth/insufficient-permission  — server `PERMISSION_DENIED`: THIS server's service account
 *   auth/invalid-credential       — THIS server's Admin credential is unusable
 *   app/internal-error            — AppErrorCodes.INTERNAL_ERROR (e.g. empty HTTP response)
 *   app/network-error             — connection failure (after the SDK's own retries)
 *   app/network-timeout           — request timeout
 *   app/unable-to-parse-response  — non-JSON upstream body (e.g. an HTML 5xx page)
 *   app/invalid-credential        — the Admin access-token fetch failed
 *
 * None of these can be induced by the bytes of a caller's credential: a
 * malformed / mis-signed / wrong-project token fails as `auth/argument-error`,
 * expiry as `auth/*-expired`, revocation as `auth/*-revoked`, a disabled or
 * deleted account as `auth/user-disabled` / `auth/user-not-found` — all
 * credential failures (401).
 *
 * POLICY for an UNKNOWN or absent code (R4, deliberate): it is a credential
 * failure (`invalid_*`, 401) — never an allow. Rationale: a 503 tells the
 * client to retry the SAME credential, while a 401 sends it through re-auth,
 * so misclassifying an unlisted credential error as an outage would leave a
 * user stuck retrying a bad token; and the SDK already funnels every unmapped
 * server error into `auth/internal-error` (above), so new outage shapes still
 * land in this set. Pinned by bearerRevocationRealSdk.spec.ts ("classification
 * of EVERY firebase-admin Auth/App error code") and the near-miss tests.
 *
 * LIMITATION: a Google public-key fetch failure surfaces as
 * `auth/argument-error`, indistinguishable here from a forged token, so that
 * outage answers 401 — fail closed either way. S2-b
 * (privilegedCredentialAdapter) tells the two apart, and uses the inverse
 * default (unknown → 503), only because it pre-validates every credential's
 * structure before the SDK runs.
 */
const TRANSIENT_VERIFY_CODES: ReadonlySet<string> = new Set([
  "auth/internal-error",
  "auth/quota-exceeded",
  "auth/insufficient-permission",
  "auth/invalid-credential",
  "app/internal-error",
  "app/network-error",
  "app/network-timeout",
  "app/unable-to-parse-response",
  "app/invalid-credential",
]);

function classifyVerificationError(err: unknown, kind: "cookie" | "bearer"): RequestIdentityUnauthenticatedReason {
  const raw = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
  const code = typeof raw === "string" ? raw : "";
  if (TRANSIENT_VERIFY_CODES.has(code)) return "auth_unavailable";
  if (code.includes("revoked")) return "revoked_session";
  if (code.includes("expired")) return "expired_session";
  return kind === "cookie" ? "invalid_session_cookie" : "invalid_bearer_token";
}

/**
 * What a credential slot becomes when its verification is still pending at the
 * deadline, or was refused at the abandoned-verification cap: the verifier
 * could not answer in time — `auth_unavailable`, never an allow. Frozen.
 */
export const DEADLINE_EXCEEDED: CredentialCheck = Object.freeze({ present: true, ok: false, reason: "auth_unavailable" } as const);

function credentialOutcome<T>(
  outcome: VerificationOutcome<T>,
  onValue: (value: T) => CredentialCheck,
  kind: "cookie" | "bearer"
): CredentialCheck {
  switch (outcome.kind) {
    case "fulfilled":
      return onValue(outcome.value);
    case "rejected":
      return { present: true, ok: false, reason: classifyVerificationError(outcome.error, kind) };
    default:
      // "deadline" | "capped" — the log line distinguishing them is written by the deadline module.
      return DEADLINE_EXCEEDED;
  }
}

/**
 * `verifySessionCookie()`'s own contract already distinguishes "absent"
 * (returns `null`) from "present but invalid/expired/revoked" (throws) —
 * deliberately relied on directly here rather than duplicating a raw
 * `request.cookies.get("__session")` presence check, which would both be
 * redundant and (if it read the raw request instead of trusting this
 * function's own return) diverge from what every existing caller already
 * mocks `verifySessionCookie` to represent.
 *
 * (R5: the raw cookie is read below ONLY to decide whether this check can go
 * upstream, i.e. whether the abandoned-verification cap applies — never to
 * decide present/absent, which stays verifySessionCookie's own answer.)
 */
async function checkCookie(request: NextRequest, deadline: VerificationDeadline): Promise<CredentialCheck> {
  // Only a presented cookie can make an upstream call; without one,
  // verifySessionCookie answers `null` locally, so it is not subject to the cap
  // (a request with no credential must still answer missing_credentials).
  const presented = Boolean(request.cookies.get("__session")?.value);
  const outcome = await deadline.run(() => verifySessionCookie(request), { upstream: presented });
  return credentialOutcome(outcome, (auth) => (auth ? { present: true, ok: true, uid: auth.uid } : { present: false }), "cookie");
}

async function checkBearer(request: NextRequest, deadline: VerificationDeadline): Promise<CredentialCheck> {
  const { present, token } = extractBearerToken(request);
  if (!present) return { present: false };
  if (!token) return { present: true, ok: false, reason: "invalid_bearer_token" };
  const outcome = await deadline.run(() => verifyIdToken(token));
  return credentialOutcome(outcome, (decoded) => ({ present: true, ok: true, uid: decoded.uid }), "bearer");
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
 * Both credential checks run independently and concurrently — whenever BOTH
 * are present, BOTH must be inspected before a decision is
 * made; neither is ever skipped merely because the other already failed
 * or succeeded. This is the direct fix for a live-verified gap: a stale
 * cookie for user A alongside an EXPIRED bearer token actually issued for
 * a DIFFERENT user B must not authenticate as A — the expired token is
 * still evidence of a second, unverifiable identity claim, not something
 * to silently discard.
 */
export async function resolveRequestIdentity(request: NextRequest): Promise<RequestIdentityResult> {
  // Both credentials are ALWAYS evaluated (see above), so they are verified
  // concurrently: with checkRevoked on both slots each check makes one live
  // Firebase Auth read, and running them in sequence doubled the latency of
  // every cookie+bearer request. Neither check can reject (each catches its
  // own verification error), so Promise.all never short-circuits a decision.
  //
  // Each check runs against ONE per-request deadline (AUTH_VERIFICATION_DEADLINE_MS,
  // ./authVerificationDeadline): a slot still pending when it fires — or refused
  // because the instance is at its abandoned-verification cap — becomes
  // `auth_unavailable`, and the truth table below decides once; a result that
  // arrives later is never read. The deadline is per request (no shared timer
  // between concurrent requests) and is always cleared.
  const deadline = startVerificationDeadline("request_identity");
  let cookie: CredentialCheck;
  let bearer: CredentialCheck;
  try {
    [cookie, bearer] = await Promise.all([checkCookie(request, deadline), checkBearer(request, deadline)]);
  } finally {
    deadline.dispose();
  }

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
