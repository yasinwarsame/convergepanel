/**
 * Team Project lifecycle UI, Phase PROJECT-UI-AR-I1 — user-facing copy for
 * `TeamProjectMutationErrorCode` (`hooks/useTeamProjectLifecycle.ts`).
 * Delegates every Personal-shaped code to the shared, pure
 * `projectMutationErrorCopy()` and adds only the two Team-route denials
 * that mapping has no member for: a 403 `insufficient_capability` (the
 * caller's role lost `projects.manage` after the page rendered, or the UI
 * showed a control it should not have) must never read as a generic
 * "Something went wrong" — the user needs to know the action was not
 * permitted — and a 404 `team_workspace_not_found` (concealed non-member
 * / non-admitted / missing Workspace) gets equally concealed copy. No
 * workspace/project/document identifier is ever included in any message.
 */

import { projectMutationErrorCopy } from "@/components/projects/projectMutationErrorCopy";
import type { TeamProjectMutationErrorCode } from "@/hooks/useTeamProjectLifecycle";

export function teamProjectMutationErrorCopy(code: TeamProjectMutationErrorCode): string {
  switch (code) {
    case "insufficient_capability":
      return "You don't have permission to do that in this Workspace.";
    case "team_workspace_not_found":
      return "This Workspace could not be found.";
    default:
      return projectMutationErrorCopy(code);
  }
}

/**
 * After one of these denials the row the user acted on is stale — the
 * Project changed, moved status, disappeared, or the caller's authority
 * changed — so the lists must be refetched from the server before any
 * further action, and the failed request must never be retried
 * automatically. Generic/transient failures (`internal_error`,
 * `network_error`, ...) are deliberately NOT in this set: nothing about
 * the row is known to be stale, so the user may retry manually with the
 * same token.
 */
export function shouldRefreshAfterTeamProjectMutationError(code: TeamProjectMutationErrorCode): boolean {
  return code === "conflict" || code === "invalid_project_status_transition" || code === "project_not_found" || code === "insufficient_capability" || code === "team_workspace_not_found";
}
