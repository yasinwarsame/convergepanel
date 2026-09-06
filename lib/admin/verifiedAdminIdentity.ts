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
import {
  isVerifiedApplicationAdminEmail,
  isVerifiedGovernanceAdminEmail,
} from "./config";

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
 * THE authoritative email-allowlist decisions — one per SCOPE.
 *
 * Phase FIRST-ADMIN-C1 replaced a single blended resolver. Previously either
 * allowlist granted application-admin APIs *and* governance-global scope, so
 * the operator could not enrol a governance administrator without also handing
 * over the admin API surface, or vice versa.
 *
 * Both take a uid ONLY and resolve their own live evidence, so no caller can
 * hand in a forged email or verification flag. Both fail closed on lookup
 * failure, and both require `emailVerified === true` on the record they read.
 *
 * Neither considers the `admin` custom claim: that is a separate, server-issued
 * authority honoured explicitly by the application-admin guard, and it must not
 * leak into governance.
 */
export async function hasVerifiedApplicationAdminAuthority(uid: string): Promise<boolean> {
  const identity = await resolveLiveAuthIdentity(uid);
  if (identity.status !== "resolved") return false;
  return isVerifiedApplicationAdminEmail({
    email: identity.email,
    emailVerified: identity.emailVerified,
  });
}

export async function hasVerifiedGovernanceAdminAuthority(uid: string): Promise<boolean> {
  const identity = await resolveLiveAuthIdentity(uid);
  if (identity.status !== "resolved") return false;
  return isVerifiedGovernanceAdminEmail({
    email: identity.email,
    emailVerified: identity.emailVerified,
  });
}
