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
import { isVerifiedAdminEmail } from "./config";

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
 * THE single authoritative email-allowlist admin decision. `true` only when the
 * live Auth record carries a verified, allowlisted address.
 *
 * This deliberately does NOT consider the `admin` custom claim: that is an
 * independent, server-issued authority which callers honour explicitly where it
 * applies, and which must not be silently widened into paths (governance) that
 * do not grant it today.
 */
export async function hasVerifiedAllowlistAdminAuthority(uid: string): Promise<boolean> {
  const identity = await resolveLiveAuthIdentity(uid);
  if (identity.status !== "resolved") return false;
  return isVerifiedAdminEmail({ email: identity.email, emailVerified: identity.emailVerified });
}
