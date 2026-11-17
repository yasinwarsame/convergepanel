import "server-only";

/**
 * API-1a C-2 — THE MANAGEMENT-PLANE IDENTITY RESOLVER (dark: no route imports it yet).
 *
 * WHY A SEPARATE RESOLVER. `resolveRequestIdentity()` (lib/auth/resolveRequestIdentity.ts) returns only
 * `{ uid, source }`: no `auth_time`, no account state, and it verifies the bearer with `checkRevoked = false`.
 * The API-platform management plane (lib/apiPlatform/management.ts) needs all three — the 15-minute
 * fresh-session rule is fed by `auth_time`, a disabled account must obtain nothing
 * (docs/operations/admin-authority-tiers.md), and org management requires a verified email. This module
 * produces exactly that evidence. It is NOT a replacement for resolveRequestIdentity, which is unchanged.
 *
 * CONSISTENCY RULES — the same strict truth table as resolveRequestIdentity (kept in lockstep by
 * lib/auth/__tests__/resolveManagementIdentity.spec.ts "parity" cases). resolveRequestIdentity cannot be
 * composed directly: it is bound to its own Firebase imports, cannot take an injected port, and never
 * exposes the decoded token. So the table is restated here and the parity spec runs both on every row:
 *   - neither credential → unauthenticated (missing_credentials);
 *   - one credential → it must verify;
 *   - BOTH present (whatever their validity) → both must verify AND name the same uid, else fail.
 *
 * WHAT IS VERIFIED, AND HOW.
 *   1. `Authorization: Bearer cpk_…` (any case/spacing), or a `__session` cookie holding a `cpk_` value, is
 *      rejected BEFORE any Firebase call: an API key is never a management credential.
 *   2. Cookie: `verifySessionCookie(cookie, true)`; bearer: `verifyIdToken(token, true)`. Both WITH revocation
 *      checking, so a revoked session (tokensValidAfterTime) or a disabled account fails here already.
 *   3. `auth_time` comes ONLY from the verified decoded token: an integer number of seconds, > 0, not more
 *      than AUTH_TIME_FUTURE_SKEW_SECONDS in the future. Missing, string, float, or milliseconds (which is
 *      always "in the future") fail. It is never taken from request time or any client value. When both
 *      credentials verify, the OLDER auth_time is used (the conservative choice for the freshness rule).
 *   4. ONE `getUser(uid)` read of the live account: `record.uid` must equal the uid, `disabled === false`
 *      and `emailVerified === true` (strict: absent / null / "true" / 1 deny). The token's `email_verified`
 *      claim is never used (a session cookie bakes it in for five days; lib/admin/verifiedAdminIdentity.ts).
 *
 * VERIFIED EMAIL IS REQUIRED FOR EVERY ORG MANAGEMENT CAPABILITY. The owner's rule is "verified email where
 * the governing management contract requires it". The contract (tenancy-and-auth.md §2.1 / PRD §7.4) requires
 * it for invite acceptance, and an unverified account must not be able to create or own an org, mint keys or
 * read org usage (C-2), so this resolver requires it for ALL of them. There is no capability for which an
 * unverified account is accepted.
 *
 * FAIL CLOSED.
 *   - A credential that does not verify (invalid / expired / revoked / disabled) → `unauthenticated`.
 *   - A `getUser` failure (other than user-not-found), a nullish record or a uid anomaly → `unavailable`:
 *     the account state could not be read, which is never evidence of anything and never a success.
 *   - Disabled and deleted accounts are `unauthenticated` (the route answers 401 `session_required`), so the
 *     response does not reveal that the account exists.
 *
 * This module deliberately imports nothing from lib/apiPlatform (that library is dark and must have no
 * importer outside its directory — lib/apiPlatform/__tests__/apiPrincipalBoundary.spec.ts). The returned
 * shape is structurally compatible with management.ts's `SessionIdentity`; the error-code strings below are
 * the API error codes of lib/apiPlatform/errors.ts, pinned equal by the spec.
 */

/** The subset of firebase-admin `Auth` this resolver calls. `adminAuth` satisfies it structurally. */
export interface ManagementAuthPort {
  verifySessionCookie(sessionCookie: string, checkRevoked: boolean): Promise<{ uid: string; auth_time?: unknown }>;
  verifyIdToken(idToken: string, checkRevoked: boolean): Promise<{ uid: string; auth_time?: unknown }>;
  getUser(uid: string): Promise<unknown>;
}

/** What the caller passes: a NextRequest satisfies it. Only `__session` and `authorization` are read. */
export interface ManagementRequestLike {
  readonly headers: { get(name: string): string | null };
  readonly cookies: { get(name: string): { value: string } | undefined };
}

export type ManagementIdentitySource = "session_cookie" | "bearer_token" | "matching_cookie_and_bearer";

export interface ManagementIdentity {
  readonly uid: string;
  /** Verified token `auth_time`, integer seconds since the epoch. */
  readonly authTimeSeconds: number;
  readonly emailVerified: true;
  readonly disabled: false;
  readonly source: ManagementIdentitySource;
}

export type ManagementIdentityFailureReason =
  | "api_key_not_accepted"
  | "missing_credentials"
  | "invalid_session_cookie"
  | "invalid_bearer_token"
  | "expired_session"
  | "revoked_session"
  | "credential_mismatch"
  | "invalid_auth_time"
  | "account_disabled"
  | "account_not_found"
  | "email_not_verified"
  | "auth_unavailable";

/** API error code each failure maps to (lib/apiPlatform/errors.ts names; equality pinned by the spec). */
export type ManagementIdentityErrorCode = "api_key_not_accepted" | "session_required" | "identity_not_verified" | "api_unavailable";

export type ManagementIdentityResult =
  | { readonly ok: true; readonly identity: ManagementIdentity }
  | { readonly ok: false; readonly reason: ManagementIdentityFailureReason; readonly code: ManagementIdentityErrorCode };

/** Clock skew tolerated for a token's `auth_time` (the same 300 s management.ts applies). */
export const AUTH_TIME_FUTURE_SKEW_SECONDS = 300;

const API_KEY_BEARER = /^\s*bearer\s+cpk_/i;
const API_KEY_VALUE = /^\s*cpk_/i;

const CODE_FOR: Readonly<Record<ManagementIdentityFailureReason, ManagementIdentityErrorCode>> = Object.freeze({
  api_key_not_accepted: "api_key_not_accepted",
  missing_credentials: "session_required",
  invalid_session_cookie: "session_required",
  invalid_bearer_token: "session_required",
  expired_session: "session_required",
  revoked_session: "session_required",
  credential_mismatch: "session_required",
  invalid_auth_time: "session_required",
  account_disabled: "session_required",
  account_not_found: "session_required",
  email_not_verified: "identity_not_verified",
  auth_unavailable: "api_unavailable",
});

const fail = (reason: ManagementIdentityFailureReason): ManagementIdentityResult => Object.freeze({ ok: false, reason, code: CODE_FOR[reason] });

type Check =
  | { present: false }
  | { present: true; ok: true; uid: string; authTime: unknown }
  | { present: true; ok: false; reason: ManagementIdentityFailureReason };

function errorCodeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

/** Same classification as resolveRequestIdentity, plus the disabled-account code `checkRevoked` can raise. */
function classify(err: unknown, kind: "cookie" | "bearer"): ManagementIdentityFailureReason {
  const code = errorCodeOf(err);
  if (code === "auth/user-disabled") return "account_disabled";
  if (code.includes("revoked")) return "revoked_session";
  if (code.includes("expired")) return "expired_session";
  return kind === "cookie" ? "invalid_session_cookie" : "invalid_bearer_token";
}

function decodedUid(decoded: unknown): string | null {
  const uid = typeof decoded === "object" && decoded !== null ? (decoded as { uid?: unknown }).uid : undefined;
  return typeof uid === "string" && uid.length > 0 && uid.length <= 128 ? uid : null;
}

async function checkCookie(value: string | undefined, port: ManagementAuthPort): Promise<Check> {
  if (value === undefined || value === "") return { present: false };
  try {
    const decoded = await port.verifySessionCookie(value, true);
    const uid = decodedUid(decoded);
    if (!uid) return { present: true, ok: false, reason: "invalid_session_cookie" };
    return { present: true, ok: true, uid, authTime: decoded.auth_time };
  } catch (err) {
    return { present: true, ok: false, reason: classify(err, "cookie") };
  }
}

/** Present whenever the header is non-blank; a malformed one is present-but-invalid (resolveRequestIdentity rule). */
async function checkBearer(header: string | null, port: ManagementAuthPort): Promise<Check> {
  if (header === null || header.trim() === "") return { present: false };
  const token = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
  if (!token) return { present: true, ok: false, reason: "invalid_bearer_token" };
  try {
    const decoded = await port.verifyIdToken(token, true);
    const uid = decodedUid(decoded);
    if (!uid) return { present: true, ok: false, reason: "invalid_bearer_token" };
    return { present: true, ok: true, uid, authTime: decoded.auth_time };
  } catch (err) {
    return { present: true, ok: false, reason: classify(err, "bearer") };
  }
}

function validAuthTime(v: unknown, nowSeconds: number): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= nowSeconds + AUTH_TIME_FUTURE_SKEW_SECONDS;
}

export const systemNowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Resolves the verified management identity for a request. Never throws.
 * `port` is the Firebase Admin Auth (production: `adminAuth`); tests inject a fake.
 */
export async function resolveManagementIdentity(
  request: ManagementRequestLike,
  port: ManagementAuthPort,
  nowSeconds: () => number = systemNowSeconds,
): Promise<ManagementIdentityResult> {
  try {
    const authorization = request.headers.get("authorization");
    const cookieValue = request.cookies.get("__session")?.value;
    // (1) An API key is never a management credential: refused before any Firebase call.
    if (API_KEY_BEARER.test(authorization ?? "") || API_KEY_VALUE.test(cookieValue ?? "")) return fail("api_key_not_accepted");

    // (2) Strict dual-credential table (resolveRequestIdentity parity). Both checks always run.
    const cookie = await checkCookie(cookieValue, port);
    const bearer = await checkBearer(authorization, port);
    if (!cookie.present && !bearer.present) return fail("missing_credentials");
    if (cookie.present && !cookie.ok) return fail(cookie.reason);
    if (bearer.present && !bearer.ok) return fail(bearer.reason);

    const verified = [cookie, bearer].filter((c): c is Extract<Check, { ok: true }> => c.present && c.ok);
    if (verified.length === 0) return fail("missing_credentials"); // unreachable; explicit fail-closed
    const uid = verified[0].uid;
    if (verified.some((c) => c.uid !== uid)) return fail("credential_mismatch");
    const source: ManagementIdentitySource =
      verified.length === 2 ? "matching_cookie_and_bearer" : cookie.present ? "session_cookie" : "bearer_token";

    // (3) auth_time ONLY from the verified token(s); every verified credential must carry a valid one.
    const now = nowSeconds();
    if (!Number.isSafeInteger(now)) return fail("auth_unavailable");
    const times = verified.map((c) => c.authTime);
    if (!times.every((t) => validAuthTime(t, now))) return fail("invalid_auth_time");
    const authTimeSeconds = Math.min(...(times as number[]));

    // (4) ONE live account read.
    let record: unknown;
    try {
      record = await port.getUser(uid);
    } catch (err) {
      return errorCodeOf(err) === "auth/user-not-found" ? fail("account_not_found") : fail("auth_unavailable");
    }
    if (typeof record !== "object" || record === null) return fail("auth_unavailable");
    const r = record as { uid?: unknown; disabled?: unknown; emailVerified?: unknown };
    if (r.uid !== uid) return fail("auth_unavailable"); // anomaly: the record is not the account asked for
    if (r.disabled !== false) return fail("account_disabled");
    if (r.emailVerified !== true) return fail("email_not_verified");

    const identity: ManagementIdentity = Object.freeze({ uid, authTimeSeconds, emailVerified: true, disabled: false, source });
    return Object.freeze({ ok: true, identity });
  } catch {
    return fail("auth_unavailable");
  }
}

/**
 * Production entry point: the Firebase Admin `Auth` instance as the port, loaded lazily (the same pattern as
 * `verifySessionCookieValue`). An uninitialised Admin SDK is `auth_unavailable`, never a success.
 */
export async function resolveManagementIdentityWithFirebase(
  request: ManagementRequestLike,
  nowSeconds: () => number = systemNowSeconds,
): Promise<ManagementIdentityResult> {
  let port: ManagementAuthPort | undefined;
  try {
    port = (await import("@/lib/firebase/admin")).adminAuth;
  } catch {
    port = undefined;
  }
  if (!port) return fail("auth_unavailable");
  return resolveManagementIdentity(request, port, nowSeconds);
}
