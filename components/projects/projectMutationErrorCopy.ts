import type { ProjectMutationErrorCode } from "@/lib/projects/projectMutationResponse";

/** User-safe copy for every lifecycle mutation error code — never exposes internal Firestore/Workspace detail. */
export function projectMutationErrorCopy(code: ProjectMutationErrorCode): string {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return "Please sign in again and try again.";
    case "invalid_project_name":
      return "Project name must be 1–200 characters.";
    case "too_many_projects":
      return "This Workspace has reached its Project limit.";
    case "rate_limited":
      return "Too many requests. Please try again shortly.";
    case "conflict":
      return "This project changed. Refresh and try again.";
    case "invalid_project_status_transition":
      return "This project's status has already changed.";
    case "project_not_found":
    case "project_unavailable":
      return "This project could not be found.";
    case "projects_disabled":
    case "workspace_missing":
    case "workspace_invalid":
    case "workspace_unavailable":
      return "Projects aren't available right now. Please try again.";
    case "invalid_update_time":
    case "invalid_request_body":
    case "unexpected_field":
    case "internal_error":
    case "network_error":
      return "Something went wrong. Please try again.";
  }
}

/** True for the two 409 outcomes that mean "the Project changed under us" — the caller should perform a read refresh, never automatically resend the mutation. */
export function isStaleProjectMutationError(code: ProjectMutationErrorCode): boolean {
  return code === "conflict" || code === "invalid_project_status_transition";
}
