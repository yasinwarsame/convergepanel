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

export type LiveAuthIdentity =
  | { status: "resolved"; email: string; emailVerified: boolean }
  | { status: "lookup_failed" };

/**
 * The caller's email and verification state, read together from the live
 * Firebase Auth user record. Never throws.
 */
export async function resolveLiveAuthIdentity(uid: string): Promise<LiveAuthIdentity> {
  if (!adminAuth || !uid) return { status: "lookup_failed" };
  try {
    const record = await adminAuth.getUser(uid);
    return {
      status: "resolved",
      email: record.email ?? "",
      emailVerified: record.emailVerified === true,
    };
  } catch {
    // Deleted user, disabled lookup, transient Auth outage — none of these are
    // evidence of ownership, so none of them may grant authority.
    return { status: "lookup_failed" };
  }
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
type Evidence = { email: string; emailVerified: boolean };
function verifiedApplicationScope(e: Evidence): boolean {
  return e.emailVerified === true && isApplicationAdminEmail(e.email);
}
function verifiedGovernanceScope(e: Evidence): boolean {
  return e.emailVerified === true && isGovernanceAdminEmail(e.email);
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
};

export async function resolveVerifiedAdminScopes(uid: string): Promise<VerifiedAdminScopes> {
  const identity = await resolveLiveAuthIdentity(uid);
  if (identity.status !== "resolved") {
    return {
      lookupStatus: "lookup_failed",
      adminPortal: false,
      governanceAdmin: false,
      email: "",
      emailVerified: false,
    };
  }
  const evidence = { email: identity.email, emailVerified: identity.emailVerified };
  return {
    lookupStatus: "resolved",
    adminPortal: verifiedApplicationScope(evidence),
    governanceAdmin: verifiedGovernanceScope(evidence),
    email: identity.email,
    emailVerified: identity.emailVerified,
  };
}

/** Convenience wrappers. Both take a uid only and fail closed. */
export async function hasVerifiedApplicationAdminAuthority(uid: string): Promise<boolean> {
  return (await resolveVerifiedAdminScopes(uid)).adminPortal;
}

export async function hasVerifiedGovernanceAdminAuthority(uid: string): Promise<boolean> {
  return (await resolveVerifiedAdminScopes(uid)).governanceAdmin;
}
