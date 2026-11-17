/**
 * Session-only management-plane authorization (PRD §7.4; tenancy-and-auth.md §2–3). The route resolves the
 * caller with lib/auth/resolveManagementIdentity.ts (outside this library, which imports no Firebase code)
 * and passes the verified result here. That resolver verifies the `__session` cookie / Firebase bearer WITH
 * revocation checking, applies the strict cookie/bearer consistency rules, takes `auth_time` only from the
 * verified token, and reads the live account (`disabled === false`, `emailVerified === true`). This module
 * never sees a Firebase token and never grants admin authority.
 *
 * Checks, in order (each is also re-applied here as defence in depth, so a caller that builds the identity
 * any other way still cannot pass an unverified or disabled account):
 * - Any `Authorization: Bearer cpk_…` is rejected outright: a leaked API key can never manage keys.
 * - No identity, an empty uid, or a malformed `auth_time` (non-integer, milliseconds, > 300 s in the future)
 *   → 401 `session_required`.
 * - A disabled account (`disabled !== false`) → 401 `session_required`, the same answer as no session, so
 *   the response does not reveal that the account exists.
 * - An unverified email (`emailVerified !== true`) → 403 `identity_not_verified`. A verified email is
 *   required for EVERY org management capability (see resolveManagementIdentity.ts for the rationale).
 * - Membership is read server-side from apiOrgMemberships/{am_…}; client-supplied role/org claims are ignored.
 *   Non-members, removed members and records bound to another org or uid are 404 `not_found`.
 * - Sensitive capabilities need a session no older than 15 minutes (token auth_time).
 * - Only OWN fields of the identity and the membership record are read (an inherited property never counts).
 *
 * PROVENANCE IS NOT TYPE-ENFORCED (deferred: api-1a-contract-reconciliation.md R-11): a branded
 * type would have to be shared between lib/auth and this library, which may import nothing outside itself.
 * The re-checks above are the runtime substitute: any hand-built identity must still be well-formed, enabled,
 * verified and fresh, and membership is always read server-side.
 */
import { FRESH_SESSION_CAPABILITIES, FRESH_SESSION_SECONDS, roleHasCapability, type OrgCapability } from "@/lib/apiPlatform/orgCapabilities";
import { computeApiOrgMembershipId } from "@/lib/apiPlatform/tenantPaths";
import { isOrgId } from "@/lib/apiPlatform/ids";
import type { ApiErrorCode } from "@/lib/apiPlatform/errors";
import type { OrgRole } from "@/lib/apiPlatform/types";

/** Structurally satisfied by lib/auth/resolveManagementIdentity.ts `ManagementIdentity`. */
export interface SessionIdentity {
  readonly uid: string;
  /** Verified token `auth_time`, seconds since epoch. */
  readonly authTimeSeconds: number;
  /** Live Firebase Auth record `emailVerified`; only exactly `true` is accepted. */
  readonly emailVerified: boolean;
  /** Live Firebase Auth record `disabled`; only exactly `false` is accepted. */
  readonly disabled: boolean;
}

export type ManagementDecision =
  | { readonly ok: true; readonly uid: string; readonly orgId: string; readonly role: OrgRole }
  | {
      readonly ok: false;
      readonly code: Extract<
        ApiErrorCode,
        "api_key_not_accepted" | "session_required" | "identity_not_verified" | "not_found" | "insufficient_role" | "fresh_session_required" | "api_unavailable"
      >;
    };

export interface ManagementDeps {
  readonly getMembership: (membershipId: string) => Promise<Record<string, unknown> | null>;
  readonly nowSeconds: () => number;
}

const API_KEY_BEARER = /^\s*bearer\s+cpk_/i;

/** Null-prototype copy of an object's OWN enumerable fields (null for a non-object); never modifies the input. */
function ownRecord(r: unknown): Record<string, unknown> | null {
  return typeof r === "object" && r !== null && !Array.isArray(r) ? Object.assign(Object.create(null) as Record<string, unknown>, r) : null;
}

export async function authorizeOrgManagement(
  headers: Headers,
  identity: SessionIdentity | null,
  orgId: string,
  capability: OrgCapability,
  deps: ManagementDeps,
): Promise<ManagementDecision> {
  if (API_KEY_BEARER.test(headers.get("authorization") ?? "")) return { ok: false, code: "api_key_not_accepted" };
  // Own fields only: an inherited `disabled: false` / `emailVerified: true` / role can never satisfy a check.
  const id = ownRecord(identity);
  if (!id || typeof id.uid !== "string" || id.uid.length === 0 || !Number.isInteger(id.authTimeSeconds)) {
    return { ok: false, code: "session_required" };
  }
  const uid = id.uid;
  const authTimeSeconds = id.authTimeSeconds as number;
  // auth_time must be seconds and not in the future (300 s skew): a millisecond value would otherwise look fresh forever.
  if (authTimeSeconds > deps.nowSeconds() + 300) return { ok: false, code: "session_required" };
  // A disabled account obtains nothing, and is indistinguishable from "no session" (admin-authority-tiers.md).
  if (id.disabled !== false) return { ok: false, code: "session_required" };
  if (id.emailVerified !== true) return { ok: false, code: "identity_not_verified" };
  if (!isOrgId(orgId)) return { ok: false, code: "not_found" };
  try {
    const m = ownRecord(await deps.getMembership(computeApiOrgMembershipId(orgId, uid)));
    // Non-members and removed members get not_found: org existence is not revealed.
    if (!m || m.orgId !== orgId || m.uid !== uid || m.status !== "active") return { ok: false, code: "not_found" };
    if (!roleHasCapability(m.role, capability)) return { ok: false, code: "insufficient_role" };
    if (FRESH_SESSION_CAPABILITIES.has(capability) && deps.nowSeconds() - authTimeSeconds > FRESH_SESSION_SECONDS) {
      return { ok: false, code: "fresh_session_required" };
    }
    return { ok: true, uid, orgId, role: m.role as OrgRole };
  } catch {
    return { ok: false, code: "api_unavailable" };
  }
}
