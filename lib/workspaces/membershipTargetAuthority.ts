/**
 * Team Member Management, Phase 12A — the ONE canonical "is this caller
 * allowed to act on this specific target member's role" policy for active-
 * membership removal. Structural mirror of `invitationRoleAuthority.ts`'s
 * `canManageInvitationTargetRole()` — deliberately a SEPARATE function, not
 * a shared one, since invitation-targeting and membership-removal are
 * different domains that only happen to share an identical Owner/Admin
 * policy matrix today; a future divergence (e.g. a differently-scoped
 * removal policy) should never have to fight an artificially shared
 * abstraction to happen.
 *
 * Deliberately INDEPENDENT of `capabilities.ts`'s flat role -> capability
 * set: a caller can hold `members.manage` (the operation-level gate) while
 * still being forbidden from acting on a SPECIFIC target role — this module
 * is that second, orthogonal check, applied in addition to (never instead
 * of) the capability check. Implements the restriction `capabilities.ts`'s
 * own `ADMIN_CAPABILITIES` doc comment already names as intended policy.
 */

import "server-only";
import type { WorkspaceMembershipRole } from "./membershipTypes";

/** The role set a removal action may ever target — `"owner"` is structurally excluded, mirroring `capabilities.ts`'s `ORDINARY_SETTABLE_ROLES` and `invitationRoleAuthority.ts`'s `InvitationTargetRole`. */
export type MembershipTargetRole = Exclude<WorkspaceMembershipRole, "owner">;

const OWNER_MANAGEABLE_TARGETS: ReadonlySet<MembershipTargetRole> = new Set(["admin", "member", "reviewer", "viewer"]);
const ADMIN_MANAGEABLE_TARGETS: ReadonlySet<MembershipTargetRole> = new Set(["member", "reviewer", "viewer"]);

/**
 * Pure, zero I/O. `targetRole: "owner"` is always `false`, for every caller
 * role — this is a role-string-level policy check only; it does NOT know
 * whether a `role: "owner"` row is the genuine canonical Owner or a corrupt
 * extra row (that classification is `isCanonicalTeamOwnerMembership()`'s
 * job, checked separately by the caller before or alongside this). Either
 * way, no caller may ever target a row whose role string reads "owner"
 * through this policy — a corrupt non-canonical "owner"-role row is denied
 * here on the same footing as the real one, never granted a pass merely for
 * failing the canonical-Owner check.
 *
 *   owner caller -> admin/member/reviewer/viewer: true
 *   admin caller -> member/reviewer/viewer: true; admin: false
 *   member/reviewer/viewer caller: always false (no removal capability ever
 *     reaches this check in practice, but the policy is still explicit and
 *     total, never assumed unreachable)
 */
export function canManageMembershipTargetRole(args: { callerRole: WorkspaceMembershipRole; targetRole: WorkspaceMembershipRole }): boolean {
  if (args.targetRole === "owner") return false;
  const targetRole = args.targetRole as MembershipTargetRole;
  if (args.callerRole === "owner") return OWNER_MANAGEABLE_TARGETS.has(targetRole);
  if (args.callerRole === "admin") return ADMIN_MANAGEABLE_TARGETS.has(targetRole);
  return false;
}
