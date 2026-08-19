import type { RunProjectAssociationErrorCode } from "@/lib/projects/runProjectAssociationResponse";

/** User-safe copy for every association mutation error code — never exposes internal Firestore/Workspace detail, never distinguishes "foreign resource" from "doesn't exist." */
export function runProjectAssociationErrorCopy(code: RunProjectAssociationErrorCode): string {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return "Please sign in again and try again.";
    case "run_not_found":
      return "This research could not be found.";
    case "project_not_found":
      return "That project is no longer available.";
    case "project_archived":
      return "This project is archived and can't accept new research right now.";
    case "project_association_conflict":
      return "This research changed. Review the latest version and try again.";
    case "project_association_unchanged":
      return "This research is already in that project.";
    case "rate_limited":
      return "Too many requests. Please try again shortly.";
    case "projects_disabled":
      return "Projects aren't available right now. Please try again.";
    case "invalid_request_body":
    case "unexpected_field":
    case "internal_error":
    case "network_error":
      return "Something went wrong. Please try again.";
  }
}

/** True when the run's own Unfiled state is what changed — the caller should refresh Unfiled, never retry the same PATCH. */
export function isStaleUnfiledAssociationError(code: RunProjectAssociationErrorCode): boolean {
  return code === "run_not_found" || code === "project_association_conflict" || code === "project_association_unchanged";
}

/** True when the CHOSEN TARGET is what's stale (no longer active/no longer exists) — the caller should refresh the chooser's own Active Project list and clear the selection, never retry the same PATCH. */
export function isStaleTargetAssociationError(code: RunProjectAssociationErrorCode): boolean {
  return code === "project_not_found" || code === "project_archived";
}
