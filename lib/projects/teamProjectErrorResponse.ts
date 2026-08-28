/**
 * Team Project Backend, Phase 8C-A — sanitized error mappings genuinely
 * SPECIFIC to Team Project routes. Generic, authorization-neutral response
 * shapes (`invalidRequestBodyResponse`, `unexpectedFieldResponse`,
 * `invalidProjectNameResponse`, `invalidUpdateTimeResponse`,
 * `staleUpdateTimeConflictResponse`, `internalErrorResponse`,
 * `invalidProjectListStatusResponse`) are reused directly from
 * `lib/projects/projectErrorResponse.ts` by the route handlers — never
 * duplicated here. `teamWorkspacesDisabledResponse()` is likewise reused
 * directly from `lib/workspaces/teamWorkspaceErrorResponse.ts`.
 */

import type { TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";

export type TeamProjectErrorBody = { ok: false; errorCode: string; message: string };

/**
 * Maps every `authorizeTeamWorkspaceMutationInTransaction()` denial reason
 * to the public response. `insufficient_capability` is the ONE reason that
 * reveals anything (403 — the caller IS an authenticated, current member,
 * merely lacking the specific capability); every other reason (Workspace
 * absent/malformed, no/removed/malformed membership, owner-integrity
 * violation) collapses to the SAME concealed 404 — a non-member must never
 * learn which of those is actually true (Section 21).
 *
 * Phase 10C.1A (F1 concealment correction): the accepted reason type also
 * includes the rollout-admission denial `"team_workspaces_disabled"` —
 * which previously bypassed this function entirely in favor of a distinct
 * shared 503, letting a caller who already knows a target Workspace ID
 * distinguish "not Workspace-canary admitted" from "admitted but I have no
 * access." It now falls into the same concealed 404 branch as every other
 * non-capability reason, closing that oracle.
 */
export function teamProjectAuthorizationDeniedResponse(reason: TeamMutationAuthorizationDenialReason | "team_workspaces_disabled"): { status: number; body: TeamProjectErrorBody } {
  if (reason === "insufficient_capability") {
    return { status: 403, body: { ok: false, errorCode: "insufficient_capability", message: "You do not have permission to perform this action in this Workspace." } };
  }
  return { status: 404, body: { ok: false, errorCode: "team_workspace_not_found", message: "This Team Workspace could not be found." } };
}

/** A Project that doesn't exist, is malformed, or belongs to a different Workspace than the route's own `{workspaceId}` — concealed identically, never distinguishing which (Section 20 cross-Workspace concealment). */
export function teamProjectNotFoundConcealedResponse(): { status: number; body: TeamProjectErrorBody } {
  return { status: 404, body: { ok: false, errorCode: "project_not_found", message: "This Project could not be found." } };
}

/** A fresh OCC token, but the requested status transition doesn't apply to the Project's current state (e.g. archiving an already-archived Project). Safe to expose — authorization has already been established by the time this is reached. */
export function teamProjectInvalidStatusTransitionResponse(): { status: number; body: TeamProjectErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "invalid_project_status_transition", message: "This Project's status has already changed." } };
}

/**
 * For the read-only list route only — `resolveWorkspaceAccess()`'s own
 * denial reason set (`workspace_not_found`/`workspace_malformed`/
 * `lookup_failed`/`not_owner`/`membership_not_found`/`membership_removed`/
 * `membership_malformed`/`owner_integrity_violation`) is a DIFFERENT union
 * than `TeamMutationAuthorizationDenialReason` (no `insufficient_capability`
 * member — that resolver never denies on capability, it returns the
 * caller's full capability set for the route itself to check). Every one
 * of those reasons collapses to this same concealed 404, mirroring
 * `teamProjectAuthorizationDeniedResponse()`'s non-capability branch.
 */
export function teamWorkspaceReadNotFoundResponse(): { status: number; body: TeamProjectErrorBody } {
  return { status: 404, body: { ok: false, errorCode: "team_workspace_not_found", message: "This Team Workspace could not be found." } };
}
