/**
 * Project Foundation, Phase 6C — shared sanitized error mappings for
 * every Project route. Structural mirror of
 * `lib/workspaces/personalWorkspaceErrorResponse.ts`.
 */

import type { ResolveProjectForOwnerResult } from "./resolveProjectForOwner";

export type ProjectErrorBody = { ok: false; errorCode: string; message: string };

/**
 * Maps every non-`found` `resolveProjectForOwner()` outcome to the public,
 * concealed response — the Phase 6A.2-frozen rule: an ID-based Project
 * route must never let an external caller distinguish "doesn't exist"
 * from "exists but isn't yours" from "exists but is structurally broken."
 * All of those collapse to the same 404 `project_not_found`. Only
 * `lookup_failed` — a genuine infrastructure fact, not an existence fact
 * — gets its own distinct 503; revealing "the system had a transient
 * error" leaks nothing about whether the Project exists.
 */
export function projectNotFoundConcealedResponse(status: Exclude<ResolveProjectForOwnerResult["status"], "found">): { status: number; body: ProjectErrorBody } {
  switch (status) {
    case "lookup_failed":
      return { status: 503, body: { ok: false, errorCode: "project_unavailable", message: "Couldn't load this Project right now. Please try again." } };
    case "invalid_project_id":
    case "not_found":
    case "malformed":
    case "workspace_mismatch":
    case "workspaces_disabled":
    case "workspace_missing":
    case "workspace_invalid":
    case "unsupported_workspace":
      return { status: 404, body: { ok: false, errorCode: "project_not_found", message: "This Project could not be found." } };
  }
}

/** The backend Projects-rollout gate is off for this uid — returned before any Project-specific data access is even attempted. Distinct from the per-Project 404s above: this is about the whole feature's availability, not any one Project's existence. */
export function projectsDisabledResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 503, body: { ok: false, errorCode: "projects_disabled", message: "Projects are not available right now." } };
}

export function invalidRequestBodyResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 400, body: { ok: false, errorCode: "invalid_request_body", message: "The request body is invalid." } };
}

export function unexpectedFieldResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 400, body: { ok: false, errorCode: "unexpected_field", message: "The request body contains a field that is not accepted here." } };
}

export function invalidProjectNameResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 400, body: { ok: false, errorCode: "invalid_project_name", message: "Project name must be 1–200 characters." } };
}

export function invalidUpdateTimeResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 400, body: { ok: false, errorCode: "invalid_update_time", message: "A valid expectedUpdateTime is required." } };
}

/** Best-effort abuse/storage guard, not a hard invariant — see `countProjectsInWorkspace()`'s own doc comment. Standard HTTP semantics for a quota/limit condition; no established precedent for this exact case existed elsewhere in this codebase. */
export function tooManyProjectsResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 429, body: { ok: false, errorCode: "too_many_projects", message: "This Workspace has reached its Project limit." } };
}

/** A stale (or concurrently-superseded) `expectedUpdateTime` — never echoes the Project's actual current state. */
export function staleUpdateTimeConflictResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "conflict", message: "This Project changed since you last loaded it. Please refresh and try again." } };
}

/** A fresh token, but the requested status transition doesn't apply to the Project's current state (e.g. archiving an already-archived Project). Distinct errorCode from the plain staleness conflict above, safe to expose because authorization/ownership has already been established by the time this is reached. */
export function invalidProjectStatusTransitionResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "invalid_project_status_transition", message: "This Project's status has already changed." } };
}

export function internalErrorResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 500, body: { ok: false, errorCode: "internal_error", message: "Something went wrong. Please try again." } };
}

/**
 * Run/Project Association, Phase 6D.4A — a run that doesn't exist,
 * doesn't belong to the caller, belongs to a different Workspace, or is a
 * legacy/unbound run (never Project-assignable) are all reported
 * identically: no distinguishing status, no distinguishing message. Same
 * concealment rationale as `projectNotFoundConcealedResponse()` above,
 * applied to run ids instead of Project ids.
 */
export function runNotFoundConcealedResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 404, body: { ok: false, errorCode: "run_not_found", message: "This run could not be found." } };
}

/** A target Project that doesn't exist, isn't structurally valid, or belongs to a different Workspace — concealed identically to a foreign Project lookup elsewhere in this file. Never reveals which of those three actually happened. */
export function runProjectAssociationTargetNotFoundResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 404, body: { ok: false, errorCode: "project_not_found", message: "This Project could not be found." } };
}

/** A target Project that IS the caller's own (ownership already established) but is archived — safe to reveal, distinct from the concealed 404 above. */
export function projectArchivedTargetResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "project_archived", message: "This Project is archived and cannot accept new run assignments." } };
}

/** The caller's `expectedProjectId` did not match the run's actual current association. Never echoes the actual current value — that would let a stale guess be used to probe organizational state. */
export function runProjectAssociationConflictResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "project_association_conflict", message: "This run's Project association changed since you last loaded it. Please refresh and try again." } };
}

/** The requested target is already the run's current association (post expected-state check) — never silently treated as success, never written, never emits an event. */
export function runProjectAssociationUnchangedResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 409, body: { ok: false, errorCode: "project_association_unchanged", message: "This run is already associated with the requested Project." } };
}

/** Project Read Foundation, Phase 7A.1 — an explicitly-supplied `?status=` value on `GET /api/user/projects` that isn't `"active"` or `"archived"`, or a duplicate `status` parameter. Never silently coerced to `"active"` — see `parseProjectListStatusQuery()`'s own doc comment for why that would be unsafe. */
export function invalidProjectListStatusResponse(): { status: number; body: ProjectErrorBody } {
  return { status: 400, body: { ok: false, errorCode: "invalid_status", message: "status must be 'active' or 'archived'." } };
}
