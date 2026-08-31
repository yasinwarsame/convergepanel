/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — public HTTP mapping for
 * `resolveWorkspaceAuditAccess()`'s denial reasons. Structural mirror of
 * `teamRunAccessResponse.ts`: every denial reason except `lookup_failed`
 * collapses into the SAME concealed 404 (read-route convention, per the
 * Phase 10C.1A F1 concealment correction that `teamRunAccessResponse.ts`
 * itself documents) — a caller can never distinguish "Team Workspaces
 * disabled/not canary-admitted" from "genuinely not a member" from
 * "Workspace doesn't exist." `lookup_failed` is its own 503, since an
 * infrastructure failure is not evidence about admission/membership state.
 */

import type { TeamWorkspaceErrorBody } from "./teamWorkspaceErrorResponse";
import type { ResolveWorkspaceAuditAccessResult } from "./resolveWorkspaceAuditAccess";

type Denied = Extract<ResolveWorkspaceAuditAccessResult, { granted: false }>;

export function teamAuditLookupUnavailableResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 503, body: { ok: false, errorCode: "team_workspace_unavailable", message: "We couldn't verify your access right now. Please try again in a moment." } };
}

export function teamAuditWorkspaceNotFoundConcealedResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 404, body: { ok: false, errorCode: "team_workspace_not_found", message: "This Team Workspace could not be found." } };
}

export function teamAuditInsufficientCapabilityResponse(): { status: number; body: TeamWorkspaceErrorBody } {
  return { status: 403, body: { ok: false, errorCode: "insufficient_capability", message: "You do not have permission to view this Workspace's audit log." } };
}

export function teamAuditAccessDeniedResponse(reason: Denied["reason"]): { status: number; body: TeamWorkspaceErrorBody } {
  switch (reason) {
    case "lookup_failed":
      return teamAuditLookupUnavailableResponse();
    case "team_workspaces_disabled":
    case "workspace_not_found":
    case "workspace_malformed":
    case "wrong_workspace_type":
    case "membership_not_found":
    case "membership_removed":
    case "membership_malformed":
    case "owner_integrity_violation":
      return teamAuditWorkspaceNotFoundConcealedResponse();
  }
}
