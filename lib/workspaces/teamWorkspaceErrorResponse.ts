/**
 * Team Workspace Core Foundation, Phase 8B (route namespace corrected in
 * Phase 8B.1; canary rollout gate reinstated in Phase 8B.2) — shared
 * sanitized error mappings for `POST /api/workspaces` and
 * `POST /api/workspaces/[workspaceId]/transfer-ownership`. Structural
 * mirror of `lib/projects/projectErrorResponse.ts`. Never forwards a raw
 * Firestore error, and never distinguishes, in a single response, which
 * of several internal checks specifically failed when doing so could
 * help an attacker enumerate another workspace's/membership's state.
 */

export type TeamWorkspaceErrorBody = { ok: false; errorCode: string; message: string };

export function teamWorkspacesDisabledResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 503, body: { ok: false, errorCode: "team_workspaces_disabled", message: "Team Workspaces are not available right now." } };
}

export function invalidRequestBodyResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 400, body: { ok: false, errorCode: "invalid_request_body", message: "The request body is invalid." } };
}

export function unexpectedFieldResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 400, body: { ok: false, errorCode: "unexpected_field", message: "The request body contains a field that is not accepted here." } };
}

export function invalidTeamWorkspaceNameResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 400, body: { ok: false, errorCode: "invalid_team_workspace_name", message: "Team Workspace name must be 1-200 characters." } };
}

export function internalErrorResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 500, body: { ok: false, errorCode: "internal_error", message: "Something went wrong. Please try again." } };
}

export function invalidUpdateTimeResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 400, body: { ok: false, errorCode: "invalid_update_time", message: "A valid expectedUpdateTime is required for the Workspace and both memberships." } };
}

/** The caller isn't the workspace's canonical current Owner — covers "not found," "not a member," "removed," "wrong role," and the Owner-integrity-violation deny, all collapsed into one concealed response so a non-Owner caller can never distinguish which of those is actually true. */
export function notCanonicalOwnerResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 403, body: { ok: false, errorCode: "not_workspace_owner", message: "Only the current Workspace Owner can perform this action." } };
}

/** The target Workspace doesn't exist, isn't a Team Workspace, or is otherwise unusable — concealed, never distinguishing which. */
export function teamWorkspaceNotFoundResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 404, body: { ok: false, errorCode: "team_workspace_not_found", message: "This Team Workspace could not be found." } };
}

export function selfTransferRejectedResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "self_transfer_rejected", message: "You already own this Workspace." } };
}

/** The proposed new Owner doesn't have an eligible (existing, active, non-Owner) membership on this Workspace — never reveals which specific condition failed. */
export function newOwnerNotEligibleResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "new_owner_not_eligible", message: "The proposed new Owner must be an active member of this Workspace." } };
}

/** Any of the three OCC tokens was stale — never echoes which one, and never echoes current server state. */
export function staleUpdateTimeConflictResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "conflict", message: "This Workspace changed since you last loaded it. Please refresh and try again." } };
}

/**
 * Phase 10B.2 — the Workspace-canary member-capacity limit has been
 * reached. Safe to be relatively transparent to the caller here (unlike
 * `team_workspace_not_found`'s concealment): by the time this can occur,
 * the caller has already passed target-Workspace admission AND normal
 * membership/capability authorization, so they already know the target
 * Workspace exists and that they administer it — there is no Workspace-
 * canary state left to hide from them. Never echoes `reservedCount` or
 * the configured limit itself, only the fact that capacity is exhausted.
 */
export function workspaceMemberCapacityReachedResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "workspace_member_capacity_reached", message: "This Workspace has reached its member limit." } };
}

/**
 * Phase 12A — the target of a member-removal action doesn't exist as an
 * active member of this Workspace, or is malformed. Concealed identically
 * for both cases (never distinguishing "never existed" from "malformed" or
 * "belongs to another Workspace") — `computeMembershipId(workspaceId, uid)`
 * already scopes the lookup to exactly this Workspace, so this response
 * alone reveals nothing about any OTHER Workspace's membership state.
 */
export function membershipTargetNotFoundResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 404, body: { ok: false, errorCode: "member_not_found", message: "This member could not be found." } };
}

/** The caller attempted to remove themselves through the ordinary member-management action. Safe to be explicit — the caller already knows who they targeted. A future "Leave Workspace" is a separate, not-yet-built feature. */
export function selfRemovalRejectedResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "self_removal_rejected", message: "You cannot remove yourself from this Workspace." } };
}

/**
 * Phase 12A.1S.1 — the permanent `TEAM_WORKSPACE_COLLABORATOR_SEAT_LIMIT`
 * has been reached. Deliberately DISTINCT from
 * `workspaceMemberCapacityReachedResponse()`'s `workspace_member_capacity_reached`
 * (the Tier-2 rollout canary's own error) — this is the always-on,
 * permanent product limit, and callers must be able to tell the two apart.
 * Safe to be relatively transparent here (unlike `team_workspace_not_found`'s
 * concealment): by the time this can occur, the caller has already passed
 * target-Workspace admission and normal membership/capability
 * authorization. Never echoes `reservedCount`/the configured limit itself,
 * or the identity/email of any conflicting member or invitation.
 */
export function seatLimitReachedResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "workspace_collaborator_limit_reached", message: "This Workspace has reached its collaborator limit." } };
}

/** The target is the Workspace's canonical current Owner — ownership can only change through the dedicated ownership-transfer workflow, never through ordinary member removal, regardless of the caller's own role or capability. */
export function targetIsCanonicalOwnerResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "target_is_canonical_owner", message: "The Workspace Owner cannot be removed. Transfer ownership first." } };
}

/** The caller's role is not permitted to remove a member at the target's specific role (e.g. an Admin targeting another Admin) — safe to be explicit, mirroring `role_target_forbidden`'s existing invitation-side precedent. */
export function membershipTargetRoleNotManageableResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 403, body: { ok: false, errorCode: "role_target_forbidden", message: "You do not have permission to remove a member at this role." } };
}

/**
 * Phase 12B — the caller's role is not permitted to manage this specific
 * target row, OR is not permitted to assign this specific destination
 * role. Deliberately collapses BOTH `target_role_not_manageable` and
 * `destination_role_not_permitted` (two distinct backend checks — see
 * `changeTeamWorkspaceMemberRole()`) into the same concealed response:
 * the caller never needs to distinguish "you can't touch this member" from
 * "you can't assign that specific role" to correct their own action, and
 * collapsing avoids revealing which of the two independent policies
 * specifically fired.
 */
export function membershipRoleChangeNotPermittedResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 403, body: { ok: false, errorCode: "role_change_forbidden", message: "You do not have permission to change this member's role." } };
}

/** The target membership isn't active (already removed) — role changes never reactivate a membership as a side effect. Concealed identically to `membershipTargetNotFoundResponse()`, consistent with this route family's existing posture: a role-change attempt against a stale Members-list row should prompt a refresh, not distinguish "removed" from "never existed." */
export function membershipTargetNotActiveResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 404, body: { ok: false, errorCode: "member_not_found", message: "This member could not be found." } };
}

/** The caller attempted to change their own role through the ordinary member-management action — unconditionally denied, no exceptions, even for the canonical Owner (who can never reach this action against themself in the first place, since the canonical-Owner check also fires). Safe to be explicit — the caller already knows who they targeted. */
export function selfRoleChangeRejectedResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "self_role_change_rejected", message: "You cannot change your own role." } };
}
