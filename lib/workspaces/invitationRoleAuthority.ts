/**
 * Team Workspace Invitations, Phase 8D.1 — the ONE canonical
 * "is this caller allowed to create/resend/revoke an invitation targeting
 * this role" policy. Deliberately INDEPENDENT of `capabilities.ts`'s flat
 * role -> capability set: a caller can hold the `members.invite`/
 * `members.manage` capability (i.e. pass the operation-level gate) while
 * still being forbidden from acting on a SPECIFIC target role — this
 * module is that second, orthogonal check every invitation
 * create/resend/revoke path must apply in addition to (never instead of)
 * its capability check.
 *
 * Implements the restriction `capabilities.ts`'s own `ADMIN_CAPABILITIES`
 * doc comment already names as intended policy ("Admin cannot grant/
 * revoke Admin or Owner... enforced at the future member-management call
 * site") — this is that call site, for the invitation surface. Does not
 * modify `capabilities.ts`.
 */

import "server-only";
import type { WorkspaceMembershipRole } from "./membershipTypes";

/** The role set an invitation may ever target — `"owner"` is structurally excluded, mirroring `capabilities.ts`'s `ORDINARY_SETTABLE_ROLES`. */
export type InvitationTargetRole = Exclude<WorkspaceMembershipRole, "owner">;

const OWNER_MANAGEABLE_TARGETS: ReadonlySet<InvitationTargetRole> = new Set(["admin", "member", "reviewer", "viewer"]);
const ADMIN_MANAGEABLE_TARGETS: ReadonlySet<InvitationTargetRole> = new Set(["member", "reviewer", "viewer"]);

/**
 * Pure, zero I/O. `targetRole: "owner"` is always `false`, for every
 * caller role — an invitation can never target Owner regardless of who is
 * asking; this is checked here structurally, never inferred from
 * capability presence alone.
 *
 *   owner caller -> admin/member/reviewer/viewer: true
 *   admin caller -> member/reviewer/viewer: true; admin: false
 *   member/reviewer/viewer caller: always false (no invitation-management
 *     capability ever reaches this check in practice, but the policy is
 *     still explicit and total, never assumed unreachable)
 */
export function canManageInvitationTargetRole(args: { callerRole: WorkspaceMembershipRole; targetRole: WorkspaceMembershipRole }): boolean {
  if (args.targetRole === "owner") return false;
  const targetRole = args.targetRole as InvitationTargetRole;
  if (args.callerRole === "owner") return OWNER_MANAGEABLE_TARGETS.has(targetRole);
  if (args.callerRole === "admin") return ADMIN_MANAGEABLE_TARGETS.has(targetRole);
  return false;
}
