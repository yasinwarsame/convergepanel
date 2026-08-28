/**
 * Team Run Lists, Phase 8C-B2 — public HTTP mapping for
 * `resolveTeamRunWorkspaceAccess()`'s denial reasons. Deliberately
 * DIFFERENT from `teamProjectAuthorizationDeniedResponse()`/
 * `teamWorkspaceReadNotFoundResponse()` (`lib/projects/teamProjectErrorResponse.ts`)
 * in exactly one respect: `lookup_failed` maps to 503 here, not the same
 * concealed 404 every other denial reason gets — an infrastructure
 * failure is not evidence about whether the Workspace/membership exists,
 * and collapsing it into the same 404 as "genuinely not found" would
 * make a transient Firestore outage indistinguishable from (and
 * retried the same way as) a real absence.
 *
 * Phase 10C.1A (F1 concealment correction): `team_workspaces_disabled` is
 * now concealed identically to every other denial reason — Workspace
 * absent/malformed, wrong type, membership absent/removed/malformed,
 * owner-integrity violation — via the SAME 404. Previously it returned the
 * distinct shared 503 `teamWorkspacesDisabledResponse()`, which let a
 * caller who already knows a target Workspace ID distinguish "not
 * Workspace-canary admitted" (503) from "admitted but I have no access"
 * (404) — a rollout-cohort-membership oracle. `lookup_failed` is
 * deliberately NOT touched by this correction: it remains its own distinct
 * 503, since a genuine infrastructure failure is not evidence about
 * admission state either way.
 */

import type { TeamWorkspaceErrorBody } from "./teamWorkspaceErrorResponse";
import type { ResolveTeamRunWorkspaceAccessResult } from "./resolveTeamRunWorkspaceAccess";

type Denied = Extract<ResolveTeamRunWorkspaceAccessResult, { granted: false }>;

export function teamRunLookupUnavailableResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 503, body: { ok: false, errorCode: "team_workspace_unavailable", message: "We couldn't verify your access right now. Please try again in a moment." } };
}

export function teamRunWorkspaceNotFoundConcealedResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 404, body: { ok: false, errorCode: "team_workspace_not_found", message: "This Team Workspace could not be found." } };
}

export function teamRunInsufficientCapabilityResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 403, body: { ok: false, errorCode: "insufficient_capability", message: "You do not have permission to view research in this Workspace." } };
}

export function teamRunAccessDeniedResponse(reason: Denied["reason"]): { status: number; body: TeamWorkspaceErrorBody } {
  switch (reason) {
    case "lookup_failed":
      return teamRunLookupUnavailableResponse();
    case "team_workspaces_disabled":
    case "workspace_not_found":
    case "workspace_malformed":
    case "wrong_workspace_type":
    case "membership_not_found":
    case "membership_removed":
    case "membership_malformed":
    case "owner_integrity_violation":
      return teamRunWorkspaceNotFoundConcealedResponse();
  }
}
