/**
 * Repository-Wide Auth Identity Consistency Remediation, Step 7 — the ONE shared credential-resolution
 * contract every protected route uses. `getRequestUid()` (lib/teams/teamApiAuth.ts) and
 * `resolveGovernanceRequestUser()` are thin wrappers around this module — the single source of truth,
 * never a forked implementation.
 *
 * ZERO COOKIE AUTHORITY (ZCA L-8, then P3 R2 "verify, don't mint"): identity comes from the
 * `Authorization: Bearer` ID token ONLY, verified revocation-checked on every request. The `__session`
 * cookie is never read, never verified and never compared: a request is decided exactly as the same
 * request without it (same status, same reason, same uid, same number of live reads). History: Step 7
 * once trusted the cookie first; the Recovery revision then required cookie and bearer to agree
 * ("matching" source and a mismatch veto); L-8 stopped a cookie alone from authenticating; P3 R2
 * removed the cookie from the decision entirely, veto included.
 *
 * Full root-cause writeup: docs/operations/auth-session-sync-runbook.md.
 */

import "server-only";
import type { NextRequest } from "next/server";
import { verifyIdToken } from "@/lib/firebase/auth";
import { startVerificationDeadline, type VerificationDeadline, type VerificationOutcome } from "./authVerificationDeadline";

/** The only identity source: a verified bearer (ZCA L-8 removed the cookie-only source, P3 R2 the cookie+bearer one). */
export type RequestIdentitySource = "bearer_token";

export type RequestIdentityUnauthenticatedReason =
  | "missing_credentials"
  | "invalid_bearer_token"
  | "revoked_session"
  | "expired_session"
  // BEARERREV: the verifier itself could not run (Auth backend / network) —
  // the live `checkRevoked` read failed. Still `unauthenticated` (never an
  // allow); wrappers that can answer 503 do so (teamApiAuth.getRequestUid,
  // reportReviewCaller); every other route answers its existing 401.
  | "auth_unavailable";

/**
 * R4o C1 / R5 C — END-TO-END deadline for credential verification, per
 * request, covering the bearer verification, plus the per-instance
 * HARD cap on upstream verification calls in flight (start to settle, shared
 * with the session mint), with its rate-limited saturation signal. Both live in
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
 * The bearer is "present" whenever the caller sent SOMETHING in the
 * Authorization header — an empty/absent value is `present: false`; anything
 * else that fails to verify is `present: true, ok: false` — a MALFORMED
 * Authorization header (wrong scheme, empty token after "Bearer ") counts as
 * present-but-invalid, never as "no bearer credential was offered."
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
 * `auth/id-token-revoked`, `auth/id-token-expired`) — falls back to
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
 * failure (`invalid_*`, 401) — never an allow. Rationale: a 503 says "the
 * credential was not judged", while a 401 says "re-authenticate"; a client that
 * treats the 503 as temporary (today only AuthProvider's same-uid token refresh
 * does, via the session mint) would keep a bad token if an unlisted credential
 * error were misclassified as an outage; and the SDK already funnels every unmapped
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

/**
 * The ONE outage-code predicate (Stage 0 F1): `POST /api/auth/session` (the
 * verification handshake) uses it for its `verifyIdToken(…, true)` failures, so the
 * handshake and every `resolveRequestIdentity` caller agree on "could not run" vs
 * "credential failure". Exact match on the code string only.
 */
export function isVerifierUnavailableCode(code: string): boolean {
  return TRANSIENT_VERIFY_CODES.has(code);
}

function classifyVerificationError(err: unknown): RequestIdentityUnauthenticatedReason {
  const raw = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
  const code = typeof raw === "string" ? raw : "";
  if (TRANSIENT_VERIFY_CODES.has(code)) return "auth_unavailable";
  if (code.includes("revoked")) return "revoked_session";
  if (code.includes("expired")) return "expired_session";
  return "invalid_bearer_token";
}

/**
 * What the bearer check becomes when its verification is still pending at the
 * deadline, or was refused at the in-flight verification cap: the verifier
 * could not answer in time — `auth_unavailable`, never an allow. Frozen.
 */
export const DEADLINE_EXCEEDED: CredentialCheck = Object.freeze({ present: true, ok: false, reason: "auth_unavailable" } as const);

function credentialOutcome<T>(
  outcome: VerificationOutcome<T>,
  onValue: (value: T) => CredentialCheck
): CredentialCheck {
  switch (outcome.kind) {
    case "fulfilled":
      return onValue(outcome.value);
    case "rejected":
      return { present: true, ok: false, reason: classifyVerificationError(outcome.error) };
    default:
      // "deadline" | "capped" — the log line distinguishing them is written by the deadline module.
      return DEADLINE_EXCEEDED;
  }
}

async function checkBearer(request: NextRequest, deadline: VerificationDeadline): Promise<CredentialCheck> {
  const { present, token } = extractBearerToken(request);
  if (!present) return { present: false };
  if (!token) return { present: true, ok: false, reason: "invalid_bearer_token" };
  const outcome = await deadline.run(() => verifyIdToken(token));
  return credentialOutcome(outcome, (decoded) => ({ present: true, ok: true, uid: decoded.uid }));
}

/**
 * Resolves the authenticated identity for a request — BEARER ONLY.
 *
 * | Bearer | Result |
 * |---|---|
 * | none | unauthenticated: missing_credentials (no verification, no deadline slot, no live read) |
 * | valid (signature, expiry, revocation, enabled) | authenticated via bearer_token |
 * | invalid / malformed | unauthenticated: invalid_bearer_token |
 * | expired | unauthenticated: expired_session |
 * | revoked | unauthenticated: revoked_session |
 * | verifier could not run, deadline, cap | unauthenticated: auth_unavailable |
 *
 * The `__session` cookie is not an input: this function never reads it, so it can neither grant nor
 * veto (P3 R2; the behavioural differential in __tests__/authSurface/ proves it on every route).
 * The verification runs under ONE per-request deadline (AUTH_VERIFICATION_DEADLINE_MS) and the shared
 * in-flight cap; a result that arrives after the deadline is never read.
 */
export async function resolveRequestIdentity(request: NextRequest): Promise<RequestIdentityResult> {
  // No bearer → anonymous, decided BEFORE any verification.
  if (!extractBearerToken(request).present) {
    return { status: "unauthenticated", reason: "missing_credentials" };
  }
  const deadline = startVerificationDeadline("request_identity");
  let bearer: CredentialCheck;
  try {
    bearer = await checkBearer(request, deadline);
  } finally {
    deadline.dispose();
  }
  if (!bearer.present) {
    // Unreachable (presence was checked above); kept as an explicit fail-closed fallback.
    return { status: "unauthenticated", reason: "missing_credentials" };
  }
  return bearer.ok
    ? { status: "authenticated", uid: bearer.uid, source: "bearer_token" }
    : { status: "unauthenticated", reason: bearer.reason };
}
