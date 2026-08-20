/**
 * Team Workspace Core Foundation, Phase 8B — the one centralized
 * role/capability model. No new API route in this phase (or any future
 * phase) should compare `membership.role === "admin"` directly; every
 * authorization decision should go through `roleHasCapability()` (or
 * `resolveWorkspaceAccess()`, which already returns a resolved capability
 * set) so a future role/capability change never has to be re-derived at
 * every call site — the same anti-scattering rationale already documented
 * for `resolveWorkspaceContext()`/`checkWorkspaceAccess()`.
 *
 * This module defines the FOUNDATION only — no route in Phase 8B actually
 * calls `research.create`, `reviews.submit`, etc. Per-run reviewer
 * assignment remains an independent, later Phase 8F requirement; a
 * capability existing here does not imply its enforcement point exists
 * yet.
 */

import "server-only";
import type { WorkspaceMembershipRole } from "./membershipTypes";

export type WorkspaceCapability =
  | "workspace.read"
  | "members.read"
  | "members.invite"
  | "members.manage"
  | "audit.read"
  | "projects.read"
  | "projects.create"
  | "projects.manage"
  | "research.read"
  | "research.create"
  | "research.organize"
  | "reviews.read"
  | "reviews.submit"
  | "reviews.manage"
  | "reviews.override"
  | "exports.create"
  | "ownership.transfer"
  | "admins.manage";

const OWNER_CAPABILITIES: readonly WorkspaceCapability[] = [
  "workspace.read",
  "members.read",
  "members.invite",
  "members.manage",
  "audit.read",
  "projects.read",
  "projects.create",
  "projects.manage",
  "research.read",
  "research.create",
  "research.organize",
  "reviews.read",
  "reviews.submit",
  "reviews.manage",
  "reviews.override",
  "exports.create",
  "ownership.transfer",
  "admins.manage",
];

const ADMIN_CAPABILITIES: readonly WorkspaceCapability[] = [
  "workspace.read",
  "members.read",
  "members.invite",
  "members.manage", // Member/Reviewer/Viewer only — Admin cannot grant/revoke Admin or Owner. Not expressible in this flat role->capability set; enforced at the future member-management call site (Phase 8C+), not here.
  "audit.read",
  "projects.read",
  "projects.create",
  "projects.manage",
  "research.read",
  "research.create",
  "research.organize",
  "reviews.manage",
  "exports.create",
  // Deliberately absent: reviews.override, ownership.transfer, admins.manage.
];

const MEMBER_CAPABILITIES: readonly WorkspaceCapability[] = [
  "workspace.read",
  "members.read",
  "projects.read",
  "projects.create",
  "projects.manage",
  "research.read",
  "research.create",
  "research.organize",
  "exports.create",
  // Deliberately absent: reviews.submit (no reviews.submit by default for Member).
];

const REVIEWER_CAPABILITIES: readonly WorkspaceCapability[] = [
  "workspace.read",
  "research.read",
  "reviews.read",
  "reviews.submit",
  // Deliberately absent: reviews.manage, reviews.override, exports.create.
];

const VIEWER_CAPABILITIES: readonly WorkspaceCapability[] = [
  "workspace.read",
  "research.read",
  "reviews.read",
  // Deliberately absent: exports.create, reviews.submit.
];

/**
 * Frozen V1 role -> capability set matrix. `Object.freeze` on both the map
 * and every array it holds — this is authorization-relevant static data;
 * nothing in this codebase should ever be able to mutate it at runtime,
 * even accidentally (e.g. `capabilities.push(...)` on a returned array).
 */
export const ROLE_CAPABILITIES: Readonly<Record<WorkspaceMembershipRole, readonly WorkspaceCapability[]>> = Object.freeze({
  owner: Object.freeze(OWNER_CAPABILITIES),
  admin: Object.freeze(ADMIN_CAPABILITIES),
  member: Object.freeze(MEMBER_CAPABILITIES),
  reviewer: Object.freeze(REVIEWER_CAPABILITIES),
  viewer: Object.freeze(VIEWER_CAPABILITIES),
});

export function roleHasCapability(role: WorkspaceMembershipRole, capability: WorkspaceCapability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function capabilitiesForRole(role: WorkspaceMembershipRole): readonly WorkspaceCapability[] {
  return ROLE_CAPABILITIES[role];
}

/**
 * Roles a member-management mutation is ever allowed to SET. `"owner"` is
 * structurally excluded here, not merely by convention — this is the
 * single set any future generic role-mutation endpoint (Phase 8C+) must
 * intersect against before accepting a caller-supplied target role, so
 * ownership can never be granted or revoked through an ordinary role
 * change. Ownership only ever moves through the dedicated
 * `transferTeamWorkspaceOwnership()` transaction.
 */
export const ORDINARY_SETTABLE_ROLES: readonly Exclude<WorkspaceMembershipRole, "owner">[] = Object.freeze(["admin", "member", "reviewer", "viewer"]);
