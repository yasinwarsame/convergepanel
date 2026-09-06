/**
 * Governance API access.
 *
 * Phase FIRESTORE-AUTHZ-P0.2: the email-allowlist grants here are the highest
 * authority in the product — `checkAdminOnly()` gates governance POLICY WRITES
 * and audit backfill, and the sibling `resolveGovernanceVisibleUserIds()`
 * returns global scope over every user's runs. They now require a VERIFIED
 * allowlisted address taken from the live Firebase Auth user record.
 *
 * Governance has never honoured the `admin` custom claim, and this phase does
 * not change that: widening it here would silently hand every application-admin
 * the global governance queue.
 *
 * Run-level scoping uses resolveGovernanceVisibleUserIds (queue / audit drilldown / review).
 */

import "server-only";
import type { NextRequest } from "next/server";
import {
  hasVerifiedGovernanceAdminAuthority,
  resolveLiveAuthIdentity,
} from "@/lib/admin/verifiedAdminIdentity";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminAuth } from "@/lib/firebase/admin";

/**
 * Governance support admin — grants governance POLICY WRITE and audit backfill.
 *
 * Phase FIRESTORE-AUTHZ-P0.2: resolves the caller's own live Auth record rather
 * than trusting a caller-supplied address, so there is no signature through
 * which an unverified or mismatched email can reach this decision. A Firestore
 * org "admin" role still does not grant policy edits.
 *
 * Phase FIRST-ADMIN-C1: this reads `GOVERNANCE_ADMIN_EMAILS` ONLY. Membership
 * of `ADMIN_EMAILS` no longer grants governance policy authority.
 */
export async function checkAdminOnly(uid: string): Promise<boolean> {
  return hasVerifiedGovernanceAdminAuthority(uid);
}

/**
 * Auth Identity Consistency Remediation, Step 7.15 — found during the
 * post-migration cross-route search, NOT in the originally-disclosed
 * 14-route inventory (that inventory only searched `app/api` directly;
 * this is a shared `lib/` helper five governance routes call indirectly).
 * Same root-cause pattern: previously checked the `__session` cookie
 * first and, on ANY thrown error (not just "absent"), silently swallowed
 * it and fell through to bearer — but if the cookie resolved to a valid
 * uid, bearer was NEVER even inspected, so a stale cookie still won
 * unconditionally over a fresh, different bearer token. Now a thin
 * wrapper around the shared `resolveRequestIdentity()`, same as every
 * other migrated route.
 */
export async function resolveGovernanceRequestUser(
  request: NextRequest
): Promise<{ ok: true; uid: string; email: string; emailVerified: boolean } | { ok: false; status: 401 }> {
  if (!adminAuth) {
    return { ok: false, status: 401 };
  }

  const identity = await resolveRequestIdentity(request);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: "resolveGovernanceRequestUser", failureCategory: identity.reason });
    return { ok: false, status: 401 };
  }

  // Phase FIRESTORE-AUTHZ-P0.2: `emailVerified` travels WITH the email, out of
  // the same live record read, so no downstream gate can honour an allowlisted
  // address without the proof of ownership that belongs to it.
  const live = await resolveLiveAuthIdentity(identity.uid);
  if (live.status !== "resolved") {
    return { ok: false, status: 401 };
  }
  return { ok: true, uid: identity.uid, email: live.email, emailVerified: live.emailVerified };
}
