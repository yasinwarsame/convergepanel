/**
 * SEC-3 / S2-a — THE PRIVILEGED-ACCESS GUARD. Wired into every privileged
 * route by S2-b (see docs/operations/s2b-route-inventory.md).
 *
 * Node runtime only: it depends on the Firebase Admin SDK, so every route that
 * adopts it must keep `export const runtime = "nodejs"`.
 *
 * SETTLED PRINCIPLES (S2 decision record SP-1..SP-8) this module implements:
 *
 *   SP-1  LIVE AUTHORIZATION. Privilege comes from ONE live `getUser()` read
 *         per request. The token's `admin` claim is recorded on the actor for
 *         mismatch telemetry ONLY and is never an input to any decision.
 *   SP-2  FAIL CLOSED ON UNAVAILABLE AUTH. Any failure to complete the live
 *         decision — Admin SDK absent, a non-auth verification error, a lookup
 *         error, an unexpected throw — is 503 for EVERY tier. There is no
 *         degraded mode and no fallback to token claims.
 *   SP-3  NO CROSS-REQUEST CACHE. Nothing about a decision survives the
 *         request. Every call performs its own verification and its own read.
 *   SP-4  ONE PRINCIPAL PER REQUEST. The actor has exactly one uid.
 *   SP-5  CONFLICTING CREDENTIALS ARE REJECTED. When a bearer token and a
 *         session cookie are both present, both must verify and name the same
 *         uid, or the request is 401. No slot falls back to the other; a
 *         present-but-empty or malformed `Authorization` header is a presented
 *         credential that failed, never "no bearer", and a present-but-empty
 *         `__session` cookie is likewise a presented credential that failed.
 *   A-2   A Google public-key fetch failure during verification is an
 *         AVAILABILITY event (503), never a credential outcome. How that is
 *         told apart from a bad credential without reading caller-controlled
 *         text is the subject of `lib/admin/privilegedCredentialAdapter.ts`:
 *         every credential is structurally pre-validated (compact JWS, RS256,
 *         `kid`, `sub`, `aud` = project id, `iss`, `exp`) BEFORE the SDK is
 *         called, so no claim value can reach an SDK error message, and the
 *         remaining `auth/argument-error` population is bounded.
 *   SP-8  The retired bootstrap shared secret is never consulted: nothing here
 *         reads a secret or an environment variable. (The secret's name is kept
 *         out of this file on purpose so the repository-wide operator-token
 *         discovery in docs/__tests__/bootstrapProbeInvariant.spec.ts does not
 *         classify this module as an operator site.)
 *
 * O-6 (step-up / MFA) is provisionally DECLINED for S2: no maximum `auth_time`
 * age is enforced. O-7 is provisionally logger-only: decisions emit structured
 * `logger` events and write no durable rows.
 *
 * TIERS (unchanged in meaning; only the source changes):
 *   SYSTEM_ADMIN      live `customClaims.admin === true`; bearer only.
 *   ADMIN_PORTAL      SYSTEM_ADMIN, or a live verified `ADMIN_EMAILS` member.
 *   GOVERNANCE_ADMIN  a live verified `GOVERNANCE_ADMIN_EMAILS` member ONLY.
 *                     Neither the claim nor `ADMIN_EMAILS` confers it.
 *
 * Every tier also requires the live account to be enabled (`disabled === false`
 * exactly; absent denies) and the presented credential not to predate the live
 * `tokensValidAfterTime` (revocation is checked here against the snapshot, so
 * the SDK is always called with `checkRevoked = false` and no second lookup is
 * made).
 */

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { adminAuth, getInitializedFirebaseProjectId } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import {
  errorCodeOf,
  verifyPrevalidatedCredential,
  type CredentialKind,
  type PrevalidatedCredential,
} from "./privilegedCredentialAdapter";
import { deriveVerifiedAdminScopes, readLiveAuthSnapshot, type LiveAuthSnapshot } from "./verifiedAdminIdentity";

export type PrivilegedTier = "SYSTEM_ADMIN" | "ADMIN_PORTAL" | "GOVERNANCE_ADMIN";

export type PrivilegedUnauthenticatedReason =
  | "missing_credentials"
  | "invalid_credential"
  | "credential_mismatch"
  | "credential_revoked"
  | "account_disabled"
  | "account_not_found"
  | "cookie_not_accepted_for_tier";

export type PrivilegedUnavailableReason = "auth_unavailable" | "admin_sdk_uninitialized";

export type PrivilegedActor = Readonly<{
  uid: string;
  /** The tier REQUESTED and proven. */
  tier: PrivilegedTier;
  heldTiers: Readonly<{ systemAdmin: boolean; adminPortal: boolean; governanceAdmin: boolean }>;
  /** From the SAME live snapshot; descriptive / audit only. */
  email: string;
  emailVerified: boolean;
  credential: "bearer" | "cookie";
  /** Seconds, from the verified credential. */
  authTime: number;
  snapshotTokensValidAfter: string | null;
  /** Recorded for mismatch telemetry ONLY. Never an input to any decision. */
  tokenClaimAdmin: boolean;
}>;

export type PrivilegedDenial =
  | { ok: false; status: 401; reason: PrivilegedUnauthenticatedReason }
  | { ok: false; status: 403; reason: "tier_not_held"; tier: PrivilegedTier }
  | { ok: false; status: 503; reason: PrivilegedUnavailableReason };

export type PrivilegedDecision = { ok: true; actor: PrivilegedActor } | PrivilegedDenial;

const SESSION_COOKIE = "__session";

type Verified = { uid: string; authTime: unknown; tokenClaimAdmin: boolean };
type CredentialOutcome =
  | { present: false }
  | { present: true; ok: true; value: Verified }
  | { present: true; ok: false; unavailable: boolean; errorCode: string };

/**
 * SP-5: an `Authorization` header that EXISTS is a presented credential. An
 * empty or whitespace-only value, or one without the `Bearer` scheme, is a
 * presented credential that failed — it is never "no bearer", so it can never
 * hand the request over to the cookie slot. (Correction round: the previous
 * form returned `present: false` for an empty header, contradicting SP-5.)
 */
function extractBearer(request: NextRequest): { present: false } | { present: true; token: string | null } {
  const header = request.headers.get("authorization");
  if (header === null) return { present: false };
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return { present: true, token: token ? token : null };
}

/**
 * The SDK's decoded claims, bound to what pre-validation proved about the same
 * bytes: the SDK sets `uid = sub` (token-verifier.js:124), so the decoded
 * subject MUST equal the pre-validated one. A disagreement cannot be produced
 * by the caller (both parse the same bytes) and is reported as an anomaly.
 */
function verifiedFrom(decoded: unknown, proof: PrevalidatedCredential): Verified | null {
  if (decoded === null || typeof decoded !== "object") return null;
  const d = decoded as Record<string, unknown>;
  const uid = typeof d.uid === "string" && d.uid ? d.uid : typeof d.sub === "string" && d.sub ? d.sub : "";
  if (!uid || uid !== proof.sub) return null;
  return { uid, authTime: d.auth_time, tokenClaimAdmin: d.admin === true };
}

async function verifyCredential(
  kind: CredentialKind,
  raw: string,
  auth: NonNullable<typeof adminAuth>,
  projectId: string
): Promise<CredentialOutcome> {
  // checkRevoked is ALWAYS false: revocation is evaluated against the one
  // live snapshot below, so the SDK must not perform a second user lookup.
  const verify = (credential: string): Promise<unknown> =>
    kind === "bearer" ? auth.verifyIdToken(credential, false) : auth.verifySessionCookie(credential, false);
  const adapted = await verifyPrevalidatedCredential(kind, raw, projectId, Math.floor(Date.now() / 1000), verify);
  switch (adapted.kind) {
    case "rejected_shape":
      // Structural failure: a credential outcome, decided before the SDK saw the bytes.
      return { present: true, ok: false, unavailable: false, errorCode: `shape:${adapted.defect}` };
    case "credential_error":
      return { present: true, ok: false, unavailable: false, errorCode: adapted.errorCode };
    case "unavailable":
      return { present: true, ok: false, unavailable: true, errorCode: adapted.errorCode };
    case "verified": {
      const value = verifiedFrom(adapted.decoded, adapted.proof);
      // The SDK accepted the bytes but reported a different (or no) subject:
      // an integrity anomaly, not something the caller can induce → 503.
      if (!value) return { present: true, ok: false, unavailable: true, errorCode: "decoded_subject_mismatch" };
      return { present: true, ok: true, value };
    }
  }
}

/**
 * `auth_time` must be a finite positive integer number of seconds.
 * Exported (behaviour unchanged) so the mixed-audience governance resolver
 * (`lib/governance/authCheck.ts`) applies the same rule to its bearer path.
 */
export function validAuthTime(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Revocation against the snapshot. Absent (`undefined` / `null`) allows; any
 * other value must parse to a finite instant, else the credential is treated as
 * revoked (stricter than the SDK). The comparison is the SDK's own: strictly
 * earlier than `validSince` is revoked, equal is not.
 * Exported (behaviour unchanged) for the same governance resolver.
 */
export function revokedBySnapshot(authTimeSeconds: number, tokensValidAfterTime: unknown): boolean {
  if (tokensValidAfterTime === undefined || tokensValidAfterTime === null) return false;
  if (typeof tokensValidAfterTime !== "string") return true;
  const validSince = Date.parse(tokensValidAfterTime);
  if (!Number.isFinite(validSince)) return true;
  return authTimeSeconds * 1000 < validSince;
}

function deny401(reason: PrivilegedUnauthenticatedReason): PrivilegedDenial {
  return { ok: false, status: 401, reason };
}
function deny503(reason: PrivilegedUnavailableReason): PrivilegedDenial {
  return { ok: false, status: 503, reason };
}

function logDenial(route: string, tier: PrivilegedTier | "AUTHENTICATED", d: PrivilegedDenial, errorCode?: string): void {
  if (d.status === 503) {
    logger.error("privileged_auth_unavailable", { route, tier, reason: d.reason, errorCode: errorCode ?? "" });
  } else {
    logger.warn("privileged_access_denied", { route, tier, status: d.status, reason: d.reason });
  }
}

type Authenticated = {
  uid: string;
  credential: "bearer" | "cookie";
  primary: Verified;
  snapshot: LiveAuthSnapshot;
  heldTiers: Readonly<{ systemAdmin: boolean; adminPortal: boolean; governanceAdmin: boolean }>;
  email: string;
  emailVerified: boolean;
};

/**
 * Steps 1–6 of the decision, shared by the tier guard and by
 * `authenticatePrivilegedPrincipal`: credential extraction (SP-5), verification
 * of EVERY presented credential (A-2), one principal (SP-4), ONE live read
 * (SP-1), account state, revocation of every presented credential against the
 * snapshot, and the held tiers derived from that same snapshot.
 * `bearerOnly` is the SYSTEM_ADMIN transport rule (D5).
 */
async function authenticate(
  request: NextRequest,
  bearerOnly: boolean
): Promise<{ ok: true; value: Authenticated } | { ok: false; decision: PrivilegedDenial; errorCode?: string }> {
  // Step 1. The Admin SDK must exist, and the project id it was initialised
  // with must be known: pre-validation binds `aud`/`iss` to it, and without it
  // the SDK must not be called at all (its content errors would quote the
  // credential). Either absence is an availability failure.
  const auth = adminAuth;
  if (!auth) return { ok: false, decision: deny503("admin_sdk_uninitialized") };
  const projectId = getInitializedFirebaseProjectId();
  if (typeof projectId !== "string" || projectId === "") {
    return { ok: false, decision: deny503("auth_unavailable"), errorCode: "project_id_unavailable" };
  }

  // Step 2. Credential extraction. Presence is decided per slot, before any
  // verification, so a failing slot can never be silently skipped. A cookie
  // that EXISTS (even with an empty value) is a presented credential, by the
  // same SP-5 rule as the header.
  const bearerSlot = extractBearer(request);
  const cookieRaw = request.cookies.get(SESSION_COOKIE)?.value;
  const cookiePresent = cookieRaw !== undefined;

  if (!bearerSlot.present && !cookiePresent) return { ok: false, decision: deny401("missing_credentials") };
  // D5: SYSTEM_ADMIN is bearer-only. A cookie alone never reaches it.
  if (bearerOnly && !bearerSlot.present) return { ok: false, decision: deny401("cookie_not_accepted_for_tier") };

  // Step 3. Verify EVERY presented credential (structure, then signature /
  // expiry via the SDK — see privilegedCredentialAdapter.ts).
  const bearer: CredentialOutcome = !bearerSlot.present
    ? { present: false }
    : bearerSlot.token === null
      ? { present: true, ok: false, unavailable: false, errorCode: "malformed_authorization_header" }
      : await verifyCredential("bearer", bearerSlot.token, auth, projectId);
  const cookie: CredentialOutcome = !cookiePresent
    ? { present: false }
    : cookieRaw === ""
      ? { present: true, ok: false, unavailable: false, errorCode: "empty_session_cookie" }
      : await verifyCredential("cookie", cookieRaw, auth, projectId);

  const presented = [bearer, cookie].filter((c): c is Exclude<CredentialOutcome, { present: false }> => c.present);
  const failed = presented.filter((c): c is Extract<CredentialOutcome, { ok: false }> => !c.ok);
  if (failed.length > 0) {
    const unavailable = failed.find((f) => f.unavailable);
    if (unavailable) return { ok: false, decision: deny503("auth_unavailable"), errorCode: unavailable.errorCode };
    return { ok: false, decision: deny401("invalid_credential") };
  }
  const verified = presented.map((c) => (c as Extract<CredentialOutcome, { ok: true }>).value);
  // SP-4 / SP-5: one principal. Two valid credentials for different uids fail.
  const uid = verified[0].uid;
  if (verified.some((v) => v.uid !== uid)) return { ok: false, decision: deny401("credential_mismatch") };
  for (const v of verified) {
    if (!validAuthTime(v.authTime)) return { ok: false, decision: deny401("invalid_credential") };
  }
  const primary = bearer.present ? (bearer as Extract<CredentialOutcome, { ok: true }>).value : verified[0];
  const credential: "bearer" | "cookie" = bearer.present ? "bearer" : "cookie";

  // Step 4. EXACTLY ONE live read.
  const live = await readLiveAuthSnapshot(uid);
  if (live.status === "not_found") return { ok: false, decision: deny401("account_not_found") };
  if (live.status !== "resolved") {
    return {
      ok: false,
      decision: deny503(live.reason === "admin_sdk_uninitialized" ? "admin_sdk_uninitialized" : "auth_unavailable"),
      errorCode: live.errorCode,
    };
  }
  const snapshot = live.snapshot;
  if (snapshot.recordUid !== uid) {
    // Integrity anomaly: the record returned is not the one asked for.
    return { ok: false, decision: deny503("auth_unavailable"), errorCode: "record_uid_mismatch" };
  }

  // Step 5. Account state, from the snapshot. Strict: only an explicit `false`
  // is proof that the account is usable.
  if (snapshot.disabled !== false) return { ok: false, decision: deny401("account_disabled") };

  // Step 6. Revocation, from the snapshot, for every presented credential.
  for (const v of verified) {
    if (revokedBySnapshot(v.authTime as number, snapshot.tokensValidAfterTime)) {
      return { ok: false, decision: deny401("credential_revoked") };
    }
  }

  // Step 7a. Tiers held, from the snapshot. The token claim is NOT read here.
  const systemAdmin = snapshot.claimAdmin === true;
  const scopes = deriveVerifiedAdminScopes(snapshot);
  const emailPortal = scopes.lookupStatus === "resolved" && scopes.adminPortal === true;
  const governanceAdmin = scopes.lookupStatus === "resolved" && scopes.governanceAdmin === true;
  const heldTiers = Object.freeze({
    systemAdmin,
    adminPortal: systemAdmin || emailPortal,
    governanceAdmin,
  });
  return {
    ok: true,
    value: { uid, credential, primary, snapshot, heldTiers, email: scopes.email, emailVerified: scopes.emailVerified },
  };
}

async function decide(
  request: NextRequest,
  tier: PrivilegedTier,
  route: string
): Promise<{ decision: PrivilegedDecision; errorCode?: string }> {
  const authn = await authenticate(request, tier === "SYSTEM_ADMIN");
  if (!authn.ok) return { decision: authn.decision, errorCode: authn.errorCode };
  const { uid, credential, primary, snapshot, heldTiers } = authn.value;
  const systemAdmin = heldTiers.systemAdmin;

  if (primary.tokenClaimAdmin !== systemAdmin) {
    // Field names avoid "token"/"key": the logger redacts those.
    logger.warn("privileged_claim_mismatch", { uid, route, presentedClaimAdmin: primary.tokenClaimAdmin, liveAdmin: systemAdmin });
  }

  // Step 7b. The requested tier.
  const held =
    tier === "SYSTEM_ADMIN" ? heldTiers.systemAdmin : tier === "ADMIN_PORTAL" ? heldTiers.adminPortal : heldTiers.governanceAdmin;
  if (!held) return { decision: { ok: false, status: 403, reason: "tier_not_held", tier } };

  const actor: PrivilegedActor = Object.freeze({
    uid,
    tier,
    heldTiers,
    email: authn.value.email,
    emailVerified: authn.value.emailVerified,
    credential,
    authTime: primary.authTime as number,
    snapshotTokensValidAfter: typeof snapshot.tokensValidAfterTime === "string" ? snapshot.tokensValidAfterTime : null,
    tokenClaimAdmin: primary.tokenClaimAdmin,
  });
  return { decision: { ok: true, actor } };
}

/**
 * The single entry point. Never throws; any unexpected failure is 503.
 */
export async function requirePrivilegedAccess(
  request: NextRequest,
  tier: PrivilegedTier,
  opts: { route: string }
): Promise<PrivilegedDecision> {
  const route = opts?.route ?? "";
  let result: { decision: PrivilegedDecision; errorCode?: string };
  try {
    result = await decide(request, tier, route);
  } catch (err) {
    result = { decision: deny503("auth_unavailable"), errorCode: errorCodeOf(err) || "unexpected_error" };
  }
  const { decision } = result;
  if (decision.ok) {
    logger.info("privileged_access_granted", { route, tier, uid: decision.actor.uid, credential: decision.actor.credential });
  } else {
    logDenial(route, tier, decision, result.errorCode);
  }
  return decision;
}

/**
 * SEC-3 / S2-b correction (owner ruling D) — AUTHENTICATION WITHOUT A TIER.
 *
 * For the mixed-audience governance handlers, whose audience is not one tier
 * (Governance Admin OR assigned reviewer OR full plan OR self-service). Runs
 * exactly the guard's steps 1–6 — SP-5 credential handling (no slot ever falls
 * back to the other), A-2 classification (verifier / lookup outage is 503,
 * never a grant), one principal, ONE live read, `disabled === false`, and
 * revocation of every presented credential against the live
 * `tokensValidAfterTime` — and reports the tiers held in that same snapshot.
 * It makes no tier decision: the caller decides scope from `heldTiers`.
 * Cookie and bearer are both accepted (the SYSTEM_ADMIN bearer-only rule does
 * not apply: no SYSTEM_ADMIN capability is reachable through this result).
 * Never throws; any unexpected failure is 503.
 */
export type AuthenticatedPrincipal = Readonly<{
  uid: string;
  heldTiers: Readonly<{ systemAdmin: boolean; adminPortal: boolean; governanceAdmin: boolean }>;
  email: string;
  emailVerified: boolean;
  credential: "bearer" | "cookie";
  authTime: number;
}>;
export type PrincipalDenial = Extract<PrivilegedDenial, { status: 401 } | { status: 503 }>;

export async function authenticatePrivilegedPrincipal(
  request: NextRequest,
  opts: { route: string }
): Promise<{ ok: true; principal: AuthenticatedPrincipal } | PrincipalDenial> {
  const route = opts?.route ?? "";
  let result: Awaited<ReturnType<typeof authenticate>>;
  try {
    result = await authenticate(request, false);
  } catch (err) {
    result = { ok: false, decision: deny503("auth_unavailable"), errorCode: errorCodeOf(err) || "unexpected_error" };
  }
  if (!result.ok) {
    logDenial(route, "AUTHENTICATED", result.decision, result.errorCode);
    return result.decision as PrincipalDenial;
  }
  const v = result.value;
  return {
    ok: true,
    principal: Object.freeze({
      uid: v.uid,
      heldTiers: v.heldTiers,
      email: v.email,
      emailVerified: v.emailVerified,
      credential: v.credential,
      authTime: v.primary.authTime as number,
    }),
  };
}

const DENIAL_MESSAGE: Record<401 | 403 | 503, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  503: "Authorization is temporarily unavailable",
};

/** Uniform denial: neutral JSON, the status, the reason code, never cached. */
export function privilegedDenialResponse(decision: PrivilegedDenial): NextResponse {
  if (!decision || decision.ok !== false) {
    // A programming error: a grant is never turned into a response here.
    throw new Error("privilegedDenialResponse called with a non-denial decision");
  }
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (decision.status === 503) headers["Retry-After"] = "5";
  return NextResponse.json({ error: DENIAL_MESSAGE[decision.status], reason: decision.reason }, { status: decision.status, headers });
}
