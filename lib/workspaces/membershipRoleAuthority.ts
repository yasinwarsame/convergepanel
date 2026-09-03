/**
 * Team Member Management, Phase 12B — the ONE canonical "is this caller
 * allowed to assign THIS destination role" policy for active-member role
 * changes. Deliberately a SEPARATE function from
 * `canManageMembershipTargetRole()` (`membershipTargetAuthority.ts`),
 * never a shared/generalized one, even though the two matrices are
 * numerically identical under the current frozen policy (Owner ->
 * {admin,member,reviewer,viewer}, Admin -> {member,reviewer,viewer}) —
 * mirroring this codebase's own established precedent for exactly this
 * situation (`membershipTargetAuthority.ts`'s own doc comment explaining
 * why IT is kept separate from `canManageInvitationTargetRole()` despite
 * an identical matrix): "may I act on this row at all" (target authority)
 * and "may I assign this specific value" (destination authority) are
 * conceptually distinct questions that only happen to share an answer set
 * today. A future divergence (e.g. a destination role gated behind a
 * feature flag, or a caller permitted to view/act on a target role it may
 * not assign) should never have to fight an artificially shared
 * abstraction to happen.
 *
 * A role-change mutation must pass BOTH `canManageMembershipTargetRole()`
 * (may the caller touch this target row at all) AND this function (may the
 * caller assign this specific destination role) — neither check alone is
 * sufficient. See `changeTeamWorkspaceMemberRole()`
 * (`lib/firestore/workspaceMemberships.ts`) for where both are applied.
 */

import "server-only";
import type { WorkspaceMembershipRole } from "./membershipTypes";
import type { MembershipTargetRole } from "./membershipTargetAuthority";

const OWNER_ASSIGNABLE_DESTINATIONS: ReadonlySet<MembershipTargetRole> = new Set(["admin", "member", "reviewer", "viewer"]);
const ADMIN_ASSIGNABLE_DESTINATIONS: ReadonlySet<MembershipTargetRole> = new Set(["member", "reviewer", "viewer"]);

/**
 * Pure, zero I/O. `destinationRole: "owner"` is always `false`, for every
 * caller role — ownership is never assignable through an ordinary role
 * change (see `ORDINARY_SETTABLE_ROLES` in `capabilities.ts`); it only
 * ever moves through the dedicated `transferTeamWorkspaceOwnership()`
 * transaction.
 *
 *   owner caller -> admin/member/reviewer/viewer: true
 *   admin caller -> member/reviewer/viewer: true; admin: false (an Admin
 *     can never assign Admin — promoting someone to Admin is reserved for
 *     the Owner)
 *   member/reviewer/viewer caller: always false (no role-management
 *     authority ever reaches this check in practice, but the policy is
 *     still explicit and total, never assumed unreachable)
 */
export function canAssignMembershipDestinationRole(args: { callerRole: WorkspaceMembershipRole; destinationRole: WorkspaceMembershipRole }): boolean {
  if (args.destinationRole === "owner") return false;
  const destinationRole = args.destinationRole as MembershipTargetRole;
  if (args.callerRole === "owner") return OWNER_ASSIGNABLE_DESTINATIONS.has(destinationRole);
  if (args.callerRole === "admin") return ADMIN_ASSIGNABLE_DESTINATIONS.has(destinationRole);
  return false;
}
