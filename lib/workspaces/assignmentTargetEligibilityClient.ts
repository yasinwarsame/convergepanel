/**
 * Project/Research Assignment (D2) — the CLIENT-SIDE UX MIRROR of the
 * server's run-assignee rule ("an active member whose role holds
 * `research.create`"). The server predicate lives in
 * `lib/workspaces/assignmentTargetEligibility.ts` (transaction-scoped,
 * authoritative) and reads the frozen role matrix in
 * `lib/workspaces/capabilities.ts`, which is `server-only` and therefore
 * cannot be imported here. This constant is pinned to that matrix by a
 * source test; it exists ONLY so the run-assignee picker can pre-filter
 * its options. It is never an authorization decision — the route
 * re-validates the target inside its own transaction on every write.
 */

import type { WorkspaceMemberRole } from "@/lib/client/workspaceTeamClient";

/** Roles whose members may be a run's primary assignee — mirror of `roleHasCapability(role, "research.create")`. */
export const RUN_ASSIGNEE_ELIGIBLE_ROLES: ReadonlySet<WorkspaceMemberRole> = new Set<WorkspaceMemberRole>(["owner", "admin", "member"]);

export function isRunAssigneeEligibleRoleMirror(role: WorkspaceMemberRole): boolean {
  return RUN_ASSIGNEE_ELIGIBLE_ROLES.has(role);
}
