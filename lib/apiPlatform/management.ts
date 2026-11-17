/**
 * Session-only management-plane authorization (PRD §7.4; tenancy-and-auth.md §2). The route resolves a
 * Firebase identity with the existing resolveRequestIdentity() (cookie or Firebase bearer; fails closed on
 * mismatch) and passes it here. This module never sees a Firebase token and never grants admin authority.
 *
 * - Any `Authorization: Bearer cpk_…` is rejected outright: a leaked API key can never manage keys.
 * - Membership is read server-side from apiOrgMemberships/{am_…}; client-supplied role/org claims are ignored.
 * - Sensitive capabilities need a session no older than 15 minutes (token auth_time).
 */
import { FRESH_SESSION_CAPABILITIES, FRESH_SESSION_SECONDS, roleHasCapability, type OrgCapability } from "@/lib/apiPlatform/orgCapabilities";
import { computeApiOrgMembershipId } from "@/lib/apiPlatform/tenantPaths";
import { isOrgId } from "@/lib/apiPlatform/ids";
import type { ApiErrorCode } from "@/lib/apiPlatform/errors";
import type { OrgRole } from "@/lib/apiPlatform/types";

export interface SessionIdentity {
  readonly uid: string;
  /** Token `auth_time`, seconds since epoch. */
  readonly authTimeSeconds: number;
}

export type ManagementDecision =
  | { readonly ok: true; readonly uid: string; readonly orgId: string; readonly role: OrgRole }
  | { readonly ok: false; readonly code: Extract<ApiErrorCode, "api_key_not_accepted" | "session_required" | "not_found" | "insufficient_role" | "fresh_session_required" | "api_unavailable"> };

export interface ManagementDeps {
  readonly getMembership: (membershipId: string) => Promise<Record<string, unknown> | null>;
  readonly nowSeconds: () => number;
}

const API_KEY_BEARER = /^\s*bearer\s+cpk_/i;

export async function authorizeOrgManagement(
  headers: Headers,
  identity: SessionIdentity | null,
  orgId: string,
  capability: OrgCapability,
  deps: ManagementDeps,
): Promise<ManagementDecision> {
  if (API_KEY_BEARER.test(headers.get("authorization") ?? "")) return { ok: false, code: "api_key_not_accepted" };
  if (!identity || typeof identity.uid !== "string" || identity.uid.length === 0 || !Number.isFinite(identity.authTimeSeconds)) {
    return { ok: false, code: "session_required" };
  }
  if (!isOrgId(orgId)) return { ok: false, code: "not_found" };
  try {
    const m = await deps.getMembership(computeApiOrgMembershipId(orgId, identity.uid));
    // Non-members and removed members get not_found: org existence is not revealed.
    if (!m || m.orgId !== orgId || m.uid !== identity.uid || m.status !== "active") return { ok: false, code: "not_found" };
    if (!roleHasCapability(m.role, capability)) return { ok: false, code: "insufficient_role" };
    if (FRESH_SESSION_CAPABILITIES.has(capability) && deps.nowSeconds() - identity.authTimeSeconds > FRESH_SESSION_SECONDS) {
      return { ok: false, code: "fresh_session_required" };
    }
    return { ok: true, uid: identity.uid, orgId, role: m.role as OrgRole };
  } catch {
    return { ok: false, code: "api_unavailable" };
  }
}
