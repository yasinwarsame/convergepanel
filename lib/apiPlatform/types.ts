/**
 * API platform record shapes (PRD §12.1; tenancy-and-auth.md). Stored only via the Admin SDK in
 * `api*` collections, which client Firestore rules deny (catch-all `match /{document=**}` deny).
 */
import type { KeyMode } from "@/lib/apiPlatform/keys";

export const API_SCOPES = Object.freeze([
  "verifications:write",
  "verifications:read",
  "verifications:delete",
  "model_responses:read",
  "usage:read",
  "models:read",
] as const);
export type ApiScope = (typeof API_SCOPES)[number];

/** Default scopes for a new key (PRD §7.3). `verifications:delete` and `model_responses:read` are never default. */
export const DEFAULT_KEY_SCOPES: readonly ApiScope[] = Object.freeze(["verifications:write", "verifications:read", "models:read"]);

export type OrgStatus = "active" | "suspended" | "canceled";

export interface ApiPlanAssignment {
  /** Compile-time beta plan id (Addendum 1 OD-1 narrowed); never a consumer plan id. */
  readonly planId: string;
  readonly status: "active" | "inactive";
}

export interface ApiOrganizationRecord {
  readonly orgId: string;
  readonly name: string;
  readonly status: OrgStatus;
  /** tenancy-and-auth.md §7 `plan` (the doc gives no shape; {planId,status} is this stage's shape). */
  readonly plan: ApiPlanAssignment | null;
  readonly createdBy: string;
  readonly createdAt: number;
}

export interface ApiApplicationRecord {
  readonly appId: string;
  readonly orgId: string;
  readonly name: string;
  readonly status: "active" | "disabled";
  readonly createdBy: string;
  readonly createdAt: number;
}

export interface ApiKeyRecord {
  readonly keyId: string;
  readonly orgId: string;
  readonly appId: string;
  readonly mode: KeyMode;
  readonly scopes: readonly ApiScope[];
  /** true (default): the key reads only its own application's verifications. */
  readonly appScoped: boolean;
  /** tenancy-and-auth.md §7 `hash`: see keys.ts for the construction (reconciliation R-4). */
  readonly hash: string;
  readonly hashVersion: 1;
  readonly prefix: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly revokedBy: string | null;
  readonly rotatedTo: string | null;
}

export type OrgRole = "owner" | "admin" | "developer" | "billing" | "viewer";

export interface ApiOrgMembershipRecord {
  readonly membershipId: string;
  readonly orgId: string;
  readonly uid: string;
  readonly role: OrgRole;
  readonly status: "active" | "removed";
  /** uid that added the member (the creator, for the founding owner). */
  readonly addedBy: string;
  readonly addedAt: number;
  /** The accepted invite; null for the founding owner (invites arrive in a later stage). */
  readonly inviteId: string | null;
}

export type AuditEventType =
  | "org.created"
  | "member.added"
  | "app.created"
  | "api_key.created"
  | "api_key.revoked"
  | "api_key.rotated";

export interface ApiAuditEventRecord {
  readonly auditId: string;
  readonly eventType: AuditEventType;
  readonly orgId: string;
  readonly actor: { readonly kind: "user"; readonly uid: string } | { readonly kind: "system" };
  readonly createdAt: number;
  readonly requestId: string;
  /** Identifiers only. Never secrets, key hashes or input text. */
  readonly target: {
    readonly appId?: string;
    readonly credentialPrefix?: string;
    readonly replacedCredentialPrefix?: string;
    readonly membershipRole?: OrgRole;
  };
}
