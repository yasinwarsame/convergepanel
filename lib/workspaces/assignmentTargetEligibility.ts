/**
 * Project/Research Assignment (D2) — the two target-eligibility rules,
 * pure and zero-I/O, shared by the write path (validated against
 * transaction-read memberships) and the read path (deriving
 * `state: "active" | "stale"` from current memberships).
 *
 *   Project assignee: ANY active same-Workspace member role, including
 *   Reviewer and Viewer — responsibility for a Project is meaningful for
 *   someone who monitors it.
 *
 *   Run assignee: an active same-Workspace member whose role CURRENTLY
 *   holds `research.create` (today Owner/Admin/Member) — a run's
 *   researcher must be able to run research.
 *
 * ASSIGNMENT IS NOT AUTHORIZATION. Nothing here grants a capability, and
 * nothing in `resolveWorkspaceAccess`, `authorizeTeamWorkspaceMutationInTransaction`,
 * `capabilities`, or `workspaceReviewEligibility` reads an assignment field
 * (pinned by a structural test). "Same Workspace" is enforced by the caller
 * binding the membership document to `(workspaceId, uid)` via
 * `validateMembershipBinding` before this predicate ever sees it — a
 * membership that failed to bind is passed as `null`.
 */

import { roleHasCapability } from "@/lib/workspaces/capabilities";
import type { WorkspaceMembershipV1 } from "@/lib/workspaces/membershipTypes";

export type AssignmentTargetKind = "project" | "run";

export type AssigneeState = "active" | "stale";

/** Pure. `membership` is the BOUND membership for `(workspaceId, uid)` or `null` when absent/unbound/malformed. */
export function isEligibleAssignmentTarget(kind: AssignmentTargetKind, membership: WorkspaceMembershipV1 | null): boolean {
  if (!membership) return false;
  if (membership.status !== "active") return false;
  if (kind === "run" && !roleHasCapability(membership.role, "research.create")) return false;
  return true;
}

/** Pure. Presentation metadata only — no route branches on it for authorization. */
export function deriveAssigneeState(kind: AssignmentTargetKind, membership: WorkspaceMembershipV1 | null): AssigneeState {
  return isEligibleAssignmentTarget(kind, membership) ? "active" : "stale";
}
