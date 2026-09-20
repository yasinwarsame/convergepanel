import "server-only";
import { classifyRunWorkspaceBindingShape } from "@/lib/workspaces/classifyRunWorkspaceBindingShape";

/**
 * Phase 1 Review Stack Cross-Authority Guard — the exclusion that makes
 * Workspace authority EXCLUSIVE over a Workspace-bound run's human-review
 * state.
 *
 * THE PROBLEM THIS EXISTS FOR. Two independent mutation stacks write the
 * same documents — `runs/{runId}/humanReviewPanel/current`,
 * `runs/{runId}/humanReviewAssignment/current` and
 * `runs/{runId}/humanReviewVotes/*`:
 *
 *   - the LEGACY stack (`/api/teams/adaptive-runs/{runId}/…`), which
 *     authorizes through the legacy `teams` document — membership plus
 *     `isTeamAdmin()` — and a `teamRuns/{runId}` projection whose `teamId`
 *     equals the ACTOR's own team;
 *   - the canonical WORKSPACE stack
 *     (`/api/workspaces/{workspaceId}/runs/{runId}/…`), which authorizes
 *     through Team Workspace membership plus `reviews.manage` and
 *     `research.read`, checked inside the mutation transaction.
 *
 * A single run can hold BOTH bindings: `lib/runPanelExecution.ts` is shared
 * by the Personal and the Workspace run paths and writes a legacy
 * `teamRuns` projection whenever the run OWNER belongs to a legacy team
 * whose `adaptiveReviewSettings.enabled` is true. Nothing else prevented a
 * legacy team admin — holding no Workspace capability whatsoever — from
 * finalizing, overriding, cancelling, re-assigning or voting on a panel
 * that the Workspace stack governs.
 *
 * THE RULE. A run is eligible for LEGACY review mutation only when its
 * canonical record carries no Workspace binding at all. Anything else
 * belongs to Workspace authority and the legacy stack must refuse it.
 *
 * WHY THE CANONICAL RUN RECORD AND NOT THE PROJECTION. The `teamRuns`
 * projection is denormalized and secondary; treating it as authority is
 * precisely the confusion being closed. A projection can therefore neither
 * create legacy authority over a Workspace-bound run, nor — by being
 * absent or stale — weaken Workspace authority. The decision is read from
 * the run document alone.
 *
 * WHY `personal` IS ALSO EXCLUDED. A run bound to its owner's Personal
 * Workspace is not a legacy team run either, and a legacy team admin has
 * no authority over it. This costs nothing in practice: a run whose owner
 * holds a legacy team never receives a Personal Workspace binding in the
 * first place (see `RunDocument.workspaceId`'s own contract — the field is
 * absent when the owner has a team), so genuine legacy drain traffic is
 * classified `legacy` and passes.
 *
 * FAIL CLOSED. `invalid` — a malformed `workspaceId`, or a run whose own
 * `userId` cannot produce a deterministic Personal Workspace id — is
 * refused rather than guessed at. An unreadable binding is not evidence of
 * legacy eligibility.
 *
 * This predicate is NOT authorization on its own. It never proves the
 * caller may do anything; it only decides which authority DOMAIN owns the
 * run. Every existing legacy authorization check still applies on top.
 */
export function runIsLegacyOnlyForReviewMutation(runData: unknown): boolean {
  if (!runData || typeof runData !== "object") {
    // No readable run document — fail closed. Callers reach this only on a
    // run that exists, so an unreadable body is an anomaly, not a legacy run.
    return false;
  }
  const data = runData as Record<string, unknown>;
  const shape = classifyRunWorkspaceBindingShape({
    hasWorkspaceIdField: Object.prototype.hasOwnProperty.call(data, "workspaceId"),
    workspaceIdValue: data.workspaceId,
    userId: data.userId,
  });
  return shape.kind === "legacy";
}
