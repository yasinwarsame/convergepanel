/**
 * The ONE place API platform Firestore paths are built (tenancy-and-auth.md §5 rule 2).
 * Data-plane paths take an authenticated principal, never a request parameter.
 */
import { createHash } from "node:crypto";
import { isAppId, isKeyId, isOrgId } from "@/lib/apiPlatform/ids";

export const API_COLLECTIONS = Object.freeze({
  organizations: "apiOrganizations",
  applications: "apiApplications",
  keys: "apiKeys",
  memberships: "apiOrgMemberships",
  audit: "apiAuditEvents",
} as const);

function assertId(ok: boolean, what: string): void {
  if (!ok) throw new Error(`tenantPaths: invalid ${what}`);
}

export const orgPath = (orgId: string) => (assertId(isOrgId(orgId), "orgId"), `${API_COLLECTIONS.organizations}/${orgId}`);
export const appPath = (appId: string) => (assertId(isAppId(appId), "appId"), `${API_COLLECTIONS.applications}/${appId}`);
export const keyPath = (keyId: string) => (assertId(isKeyId(keyId), "keyId"), `${API_COLLECTIONS.keys}/${keyId}`);
export const membershipPath = (membershipId: string) => (
  assertId(/^am_[0-9a-f]{64}$/.test(membershipId), "membershipId"), `${API_COLLECTIONS.memberships}/${membershipId}`
);
export const auditPath = (auditId: string) => (assertId(/^aud_[0-9A-Za-z]{24}$/.test(auditId), "auditId"), `${API_COLLECTIONS.audit}/${auditId}`);

/** Frozen domain separator — never edited in place (same discipline as lib/workspaces/membershipId.ts). */
const MEMBERSHIP_DOMAIN = "convergepanel.api-org-membership.v1";

function lp(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([prefix, bytes]);
}

/** Injective, deterministic `(orgId, uid)` → `am_<sha256 hex>`; its own domain, never the workspace one. */
export function computeApiOrgMembershipId(orgId: string, uid: string): string {
  assertId(isOrgId(orgId), "orgId");
  if (typeof uid !== "string" || uid.length === 0 || uid.length > 128) throw new Error("tenantPaths: invalid uid");
  return `am_${createHash("sha256").update(Buffer.concat([Buffer.from(MEMBERSHIP_DOMAIN, "utf8"), lp(orgId), lp(uid)])).digest("hex")}`;
}
