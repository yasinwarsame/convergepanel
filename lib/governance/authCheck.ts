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
import { hasVerifiedGovernanceAdminAuthority } from "@/lib/admin/verifiedAdminIdentity";
import { authenticatePrivilegedPrincipal } from "@/lib/admin/privilegedAccess";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { logger } from "@/lib/logger";

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
 *
 * SEC-3 / S2-b: NO ROUTE CALLS THIS ANY MORE. Policy write and audit backfill
 * are gated by `requirePrivilegedAccess(..., "GOVERNANCE_ADMIN")`
 * (lib/admin/privilegedAccess.ts), which applies the same live-record rule plus
 * credential revocation. Kept only until its remaining unit specs are retired;
 * app/api/admin/__tests__/privilegedGuardPin.spec.ts forbids any app/ caller.
 */
export async function checkAdminOnly(uid: string): Promise<boolean> {
  return hasVerifiedGovernanceAdminAuthority(uid);
}

/**
 * Step 6.0b — who may READ the full governance policy.
 *
 * Exactly the audience that can open the governance dashboard: a verified
 * Governance Admin, OR a caller whose CURRENT effective plan is `full`. Both are
 * derived here, server-side, from the caller's own uid — never from a client
 * `governanceDashboardEligible` flag, a Firestore role string, or any
 * request-supplied identity. Writes are GOVERNANCE_ADMIN only, via the
 * privileged-access guard (SEC-3 / S2-b).
 *
 * An entitlement lookup failure is `unavailable` (fail closed), never `allowed`.
 */
export async function checkGovernancePolicyReadAccess(
  uid: string
): Promise<"allowed" | "forbidden" | "unavailable"> {
  if (await hasVerifiedGovernanceAdminAuthority(uid)) return "allowed";
  try {
    const entitlements = await getEffectiveEntitlements(uid);
    return entitlements.planId === "full" ? "allowed" : "forbidden";
  } catch (err: unknown) {
    logger.warn("[governance/authCheck] policy read entitlement lookup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "unavailable";
  }
}

/**
 * Authentication for the MIXED-AUDIENCE governance handlers (policy GET, audit
 * GET, queue GET, review POST, reviewer GET/POST).
 *
 * History: Step 7.15 moved this onto the shared `resolveRequestIdentity()`
 * (strict cookie + bearer agreement); Phase FIRST-ADMIN-C6 added the live
 * `disabled` refusal. SEC-3 / S2-b correction (owner ruling D): it is now the
 * privileged-access guard's own authentication, without a tier decision —
 * `authenticatePrivilegedPrincipal` (lib/admin/privilegedAccess.ts):
 *
 *   - every presented credential is verified; a present-but-invalid,
 *     malformed, expired or REVOKED bearer never falls back to a cookie (or
 *     the reverse), and two credentials must name the same uid (SP-5);
 *   - ONE live Auth read; `disabled === false` is required; EVERY presented
 *     credential (bearer and cookie) is checked against the live
 *     `tokensValidAfterTime`, so `revokeRefreshTokens(uid)` takes effect on the
 *     next request rather than when the ID token expires;
 *   - a verifier or lookup outage is 503 (A-2 / SP-2), never a grant and never
 *     a silent 401.
 *
 * Scope is NOT decided here: ordinary reviewer / Team / full-plan access and
 * GOVERNANCE_ADMIN global scope are decided downstream, from the uid, by the
 * same live-record resolvers as before (`resolveGovernanceVisibleUserIds*`,
 * `checkGovernancePolicyReadAccess`).
 */
export type GovernanceRequestUser =
  | { ok: true; uid: string; email: string; emailVerified: boolean }
  | { ok: false; status: 401 | 503 };

export async function resolveGovernanceRequestUser(
  request: NextRequest,
  opts: { route?: string } = {}
): Promise<GovernanceRequestUser> {
  const authn = await authenticatePrivilegedPrincipal(request, { route: opts.route ?? "governance" });
  if (!authn.ok) return { ok: false, status: authn.status };
  const p = authn.principal;
  return { ok: true, uid: p.uid, email: p.email, emailVerified: p.emailVerified };
}
