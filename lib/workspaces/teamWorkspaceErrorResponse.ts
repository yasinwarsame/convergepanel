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
