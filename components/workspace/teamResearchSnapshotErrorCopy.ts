/**
 * ADD-TO-TEAM-PROJECT — user-facing copy for
 * `TeamResearchSnapshotErrorCode`. No workspace/project/run identifier is
 * ever included in any message, and a concealed server denial is
 * described only as the concealment itself.
 */

import type { TeamResearchSnapshotErrorCode } from "@/lib/workspaces/teamResearchSnapshotResponse";

export function teamResearchSnapshotErrorCopy(code: TeamResearchSnapshotErrorCode): string {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return "Please sign in again to add this research to a Team Project.";
    case "rate_limited":
      return "You've added research to Team Projects very quickly. Please wait a moment and try again.";
    case "insufficient_capability":
      return "You don't have permission to add research to this Workspace.";
    case "team_workspace_not_found":
      return "This Workspace could not be found.";
    case "project_not_found":
      return "This Project could not be found. It may have been removed.";
    case "project_archived":
      return "This Project is archived. Restore it, or choose an active Project.";
    case "source_not_found":
      return "This research could not be copied. It may have been deleted, or it may not belong to your account.";
    case "snapshot_too_large":
      return "This research is too large to copy into a Team Project.";
    case "invalid_request_body":
    case "unexpected_field":
    case "internal_error":
      return "Something went wrong while copying this research. Nothing was changed.";
    case "network_error":
      return "We couldn't reach the server. Check your connection and try again.";
  }
}

/**
 * After one of these the chosen Project is stale — it changed status,
 * disappeared, or the caller's authority changed — so the Project list is
 * refetched before any further attempt. Transient failures are NOT here:
 * nothing about the selection is known to be stale, so the user may retry.
 */
export function shouldReloadProjectsAfterSnapshotError(code: TeamResearchSnapshotErrorCode): boolean {
  return code === "project_not_found" || code === "project_archived" || code === "insufficient_capability" || code === "team_workspace_not_found";
}
