/**
 * Phase FIRESTORE-AUTHZ-P0.2 — LIVE FIREBASE AUTH EVIDENCE for every
 * email-allowlist authority decision.
 *
 * WHY A LIVE RECORD AND NOT THE TOKEN.
 *
 * Session cookies are minted by `createSessionCookie` with a FIVE DAY life and
 * bake `email_verified` in at mint time; nothing re-mints them when a user
 * verifies. Deriving allowlist authority from that claim would therefore be
 * wrong in both directions:
 *
 *   - a legitimate administrator who verifies mid-session would be denied for
 *     up to five days (an availability defect), and
 *   - a claim asserting verified that the live record no longer supports would
 *     still be honoured (a security defect).
 *
 * Reading the live record costs one Auth lookup, on admin-only paths, and is
 * correct in both directions immediately.
 *
 * WHY ONE FUNCTION RETURNS BOTH FIELDS.
 *
 * The email and the verification flag are returned TOGETHER out of a single
 * `getUser()` result, so a caller cannot pair one source's address with another
 * source's proof even by accident. That pairing is the actual invariant; making
 * it structural rather than a convention is the point of this module.
 *
 * FAIL CLOSED. An unavailable Admin SDK or a throwing lookup yields
 * `lookup_failed`, which grants nothing. An absent lookup is never authority.
 */

import "server-only";
import { adminAuth } from "@/lib/firebase/admin";
import { isApplicationAdminEmail, isGovernanceAdminEmail } from "./config";

/**
 * SEC-3 / S2-a — THE LIVE AUTH SNAPSHOT.
 *
 * Every authority decision in this module, and in the privileged-access guard
 * (`lib/admin/privilegedAccess.ts`), is derived from ONE `getUser()` result
 * captured here. The snapshot is a frozen copy of exactly the fields any tier
 * decision reads, so the claim decision, the email decision, the account-state
 * decision and the revocation decision can never come from two different reads
 * of the record (a demotion or disable landing between two reads would
 * otherwise split one request's authority across two states).
 *
 * Raw values are kept RAW. Each consumer applies its own strict predicate
 * (`disabled === false`, `admin === true`, `emailVerified === true`) so that
 * the coercion a caller relies on is visible at the decision site.
 *
 * BRAND. A snapshot is only accepted by `deriveVerifiedAdminScopes` if THIS
 * module constructed it (a module-private WeakSet; nothing is cached — the set
 * only answers "did this module build this object?" and holds it weakly). A
 * caller therefore still cannot hand in an email and a verification flag of its
 * own choosing: the P0.2 "uid-only, never caller-supplied evidence" rule holds.
 */
export type LiveAuthSnapshot = Readonly<{
  /** The uid that was looked up. */
  requestedUid: string;
  /** `record.uid` exactly as returned — the guard treats a mismatch as an anomaly. */
  recordUid: unknown;
  email: unknown;
  emailVerified: unknown;
  disabled: unknown;
  /** `record.customClaims?.admin`, raw. */
  claimAdmin: unknown;
  /** `record.tokensValidAfterTime`, raw (UTC date string when set). */
  tokensValidAfterTime: unknown;
}>;

export type LiveAuthSnapshotResult =
  | { status: "resolved"; snapshot: LiveAuthSnapshot }
  | { status: "not_found" }
  | { status: "unavailable"; reason: "admin_sdk_uninitialized" | "lookup_error" | "invalid_uid"; errorCode: string };

const SNAPSHOTS_BUILT_HERE = new WeakSet<object>();

function errorCodeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

/**
 * Exactly ONE `adminAuth.getUser(uid)` call. Never throws. `auth/user-not-found`
 * is reported separately (a deleted account is an authentication outcome);
 * every other failure is `unavailable` (the record could not be read, which is
 * never evidence of anything).
 */
export async function readLiveAuthSnapshot(uid: string): Promise<LiveAuthSnapshotResult> {
  if (typeof uid !== "string" || !uid) return { status: "unavailable", reason: "invalid_uid", errorCode: "" };
  if (!adminAuth) return { status: "unavailable", reason: "admin_sdk_uninitialized", errorCode: "" };
  let snapshot: LiveAuthSnapshot;
  try {
    const record = (await adminAuth.getUser(uid)) as unknown as Record<string, unknown>;
    // Mirrors the pre-snapshot behaviour exactly: a nullish result could not be
    // read (the old `record.email` access threw and was caught).
    if (record === null || record === undefined) {
      return { status: "unavailable", reason: "lookup_error", errorCode: "" };
    }
    const claims = record.customClaims;
    snapshot = Object.freeze({
      requestedUid: uid,
      recordUid: record.uid,
      email: record.email,
      emailVerified: record.emailVerified,
      disabled: record.disabled,
      claimAdmin: claims !== null && typeof claims === "object" ? (claims as Record<string, unknown>).admin : undefined,
      tokensValidAfterTime: record.tokensValidAfterTime,
    });
  } catch (err) {
    const code = errorCodeOf(err);
    if (code === "auth/user-not-found") return { status: "not_found" };
    return { status: "unavailable", reason: "lookup_error", errorCode: code };
  }
  SNAPSHOTS_BUILT_HERE.add(snapshot);
  return { status: "resolved", snapshot };
}

export type LiveAuthIdentity =
  | { status: "resolved"; email: string; emailVerified: boolean; disabled: boolean }
  | { status: "lookup_failed" };

/**
 * The legacy projection of a snapshot. Field semantics are UNCHANGED from the
 * pre-snapshot implementation and must stay so (`user/usage` and the existing
 * guards depend on them).
 */
function identityFromSnapshot(s: LiveAuthSnapshot): { email: string; emailVerified: boolean; disabled: boolean } {
  return {
    email: (s.email ?? "") as string,
    emailVerified: s.emailVerified === true,
    // Phase FIRST-ADMIN-C4. `getUser()` returns a record for a DISABLED
    // account without throwing, and this module previously read only the
    // address and the verification flag — so disabling a compromised
    // administrator did not remove their email-derived authority. Since the
    // whole point of reading the live record is that it is stronger evidence
    // than a token claim, the account's enabled state has to come out of the
    // same read. Absent or non-boolean is treated as ENABLED here and denied
    // by the predicates below only when explicitly `true`; see the strict
    // `disabled === false` requirement there.
    disabled: s.disabled === true,
  };
}

/**
 * The caller's email and verification state, read together from the live
 * Firebase Auth user record. Never throws.
 */
export async function resolveLiveAuthIdentity(uid: string): Promise<LiveAuthIdentity> {
  // Deleted user, disabled lookup, transient Auth outage — none of these are
  // evidence of ownership, so none of them may grant authority.
  const result = await readLiveAuthSnapshot(uid);
  if (result.status !== "resolved") return { status: "lookup_failed" };
  return { status: "resolved", ...identityFromSnapshot(result.snapshot) };
}

/**
 * PRIVATE verified predicates. They take evidence, so they are deliberately not
 * exported: the review found that exported evidence-taking predicates are a
 * standing invitation to pass a session cookie's stale `email_verified`, which
 * would reopen the P0.2 provenance defect while type-checking cleanly. The only
 * public way to an authority answer is a uid-only resolver below.
 *
 * `emailVerified` must be exactly `true`; absent, `null`, `false`, `"true"`, `0`
 * and `1` all deny.
 */
type Evidence = { email: string; emailVerified: boolean; disabled: boolean };

/**
 * Phase FIRST-ADMIN-C4 — `disabled === false` is required for BOTH scopes.
 *
 * Written as `=== false` rather than `!disabled` so that a missing, undefined
 * or non-boolean value denies rather than grants: the only accepted proof that
 * an account is usable is an explicit `false` derived from the live record.
 */
function verifiedApplicationScope(e: Evidence): boolean {
  return e.disabled === false && e.emailVerified === true && isApplicationAdminEmail(e.email);
}
function verifiedGovernanceScope(e: Evidence): boolean {
  return e.disabled === false && e.emailVerified === true && isGovernanceAdminEmail(e.email);
}

/**
 * THE ADMINISTRATOR TIER CONTRACT — resolved from ONE live Auth record.
 *
 *   ADMIN_PORTAL      verified `ADMIN_EMAILS` member, OR the `admin` custom
 *                     claim (the claim is applied by the API guard, not here).
 *   GOVERNANCE_ADMIN  verified `GOVERNANCE_ADMIN_EMAILS` member.
 *
 * These are INDEPENDENT. `ADMIN_EMAILS` never confers governance authority and
 * `GOVERNANCE_ADMIN_EMAILS` never confers portal authority — the two lists fed
 * one predicate before this work, which made least privilege unachievable.
 *
 * SYSTEM_ADMIN is deliberately absent here: it derives ONLY from the custom
 * claim, is never email-derived, and so is resolved from the verified token
 * rather than from any allowlist. An `ADMIN_EMAILS` member must never be able to
 * reach credential access, role minting, bulk purge or destructive account and
 * billing mutation.
 *
 * `email`/`emailVerified` are returned for display, audit and cache-key use.
 * They are outputs of the trusted read, never inputs a caller may supply.
 */
export type VerifiedAdminScopes = {
  lookupStatus: "resolved" | "lookup_failed";
  adminPortal: boolean;
  governanceAdmin: boolean;
  email: string;
  emailVerified: boolean;
  disabled: boolean;
};

const LOOKUP_FAILED_SCOPES: VerifiedAdminScopes = Object.freeze({
  lookupStatus: "lookup_failed",
  adminPortal: false,
  governanceAdmin: false,
  email: "",
  emailVerified: false,
  // A lookup we could not perform is not evidence that the account is
  // usable. Reported as disabled so every consumer fails closed.
  disabled: true,
}) as VerifiedAdminScopes;

/**
 * The tier contract evaluated over a snapshot THIS module built. A forged or
 * copied object is not a snapshot: it yields the lookup-failed answer, which
 * grants nothing. The email scopes here are email-derived ONLY; the `admin`
 * claim is applied by the guard, never here.
 */
export function deriveVerifiedAdminScopes(snapshot: LiveAuthSnapshot): VerifiedAdminScopes {
  if (typeof snapshot !== "object" || snapshot === null || !SNAPSHOTS_BUILT_HERE.has(snapshot)) {
    return { ...LOOKUP_FAILED_SCOPES };
  }
  const evidence = identityFromSnapshot(snapshot);
  return {
    lookupStatus: "resolved",
    adminPortal: verifiedApplicationScope(evidence),
    governanceAdmin: verifiedGovernanceScope(evidence),
    email: evidence.email,
    emailVerified: evidence.emailVerified,
    disabled: evidence.disabled,
  };
}

export async function resolveVerifiedAdminScopes(uid: string): Promise<VerifiedAdminScopes> {
  const result = await readLiveAuthSnapshot(uid);
  if (result.status !== "resolved") return { ...LOOKUP_FAILED_SCOPES };
  return deriveVerifiedAdminScopes(result.snapshot);
}

/** Convenience wrappers. Both take a uid only and fail closed. */
export async function hasVerifiedApplicationAdminAuthority(uid: string): Promise<boolean> {
  return (await resolveVerifiedAdminScopes(uid)).adminPortal;
}

export async function hasVerifiedGovernanceAdminAuthority(uid: string): Promise<boolean> {
  return (await resolveVerifiedAdminScopes(uid)).governanceAdmin;
}
