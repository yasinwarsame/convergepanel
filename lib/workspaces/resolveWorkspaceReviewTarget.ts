/**
 * Workspace Review Authorization Core, Phase 9B.1 — pure, zero-I/O
 * classification of whether a `runs/{runId}` document is a valid target
 * for a Workspace-qualified review operation scoped to a specific
 * `requestedWorkspaceId`.
 *
 * Deliberately NOT a new general-purpose run classifier — Phase 8C already
 * owns that: this composes `classifyRunWorkspaceBindingShape()` (the
 * structural Personal/non-Personal/legacy/invalid shape check) and
 * `classifyProjectIdFieldState()` (the existing `projectId` field-shape
 * classifier `validateTeamRunRowShape()` also builds on) rather than
 * re-deriving either. The only genuinely new logic here is the
 * `requestedWorkspaceId` exact-match check and surfacing the run's
 * `userId` as an explicit, named "creator" field — `validateTeamRunRowShape()`
 * doesn't expose that, because Project association has no self-review
 * concept; review does.
 *
 * This function answers ONLY "is this run a well-formed, Workspace-bound
 * review target at the requested scope" — it never touches Firestore,
 * never proves the requested Workspace actually exists or is `type ===
 * "team"`, and never proves the caller may access it. Callers MUST
 * additionally run the requested Workspace through
 * `resolveTeamRunWorkspaceAccess()` (read paths) or
 * `authorizeTeamWorkspaceMutationInTransaction()` (write paths, within the
 * same transaction as any resulting mutation) — this function's
 * `valid_workspace_review_target` result is a necessary precondition for
 * a review operation, never a sufficient one.
 *
 * The path-supplied `requestedWorkspaceId` is only ever a requested scope.
 * The run's own stored `workspaceId` is the sole ownership authority —
 * this function fails closed (`wrong_workspace`) rather than trusting the
 * caller-supplied value, exactly mirroring `validateTeamRunRowShape()`'s
 * own `expectedWorkspaceId` exact-match discipline.
 */

import { classifyRunWorkspaceBindingShape } from "./classifyRunWorkspaceBindingShape";
import { classifyProjectIdFieldState } from "@/lib/projects/runProjectNormalizationEligibility";

export type WorkspaceReviewTargetResult =
  | { kind: "valid_workspace_review_target"; workspaceId: string; projectId: string | null; creatorUid: string }
  | { kind: "not_workspace_bound" } // classifyRunWorkspaceBindingShape -> "legacy": no workspaceId field at all. Not this helper's concern — the legacy Team path owns it.
  | { kind: "not_team_workspace" } // classifyRunWorkspaceBindingShape -> "personal": bound, but to the run owner's own Personal Workspace.
  | { kind: "wrong_workspace" } // non_personal_bound, but stored workspaceId !== requestedWorkspaceId.
  | { kind: "invalid_run"; reason: "malformed_workspace_id" | "run_owner_invalid" | "malformed_project_id" };

export interface WorkspaceReviewTargetInput {
  requestedWorkspaceId: string;
  hasWorkspaceIdField: boolean;
  workspaceIdValue: unknown;
  userId: unknown;
  hasProjectIdField: boolean;
  projectIdValue: unknown;
}

export function resolveWorkspaceReviewTarget(input: WorkspaceReviewTargetInput): WorkspaceReviewTargetResult {
  const binding = classifyRunWorkspaceBindingShape({
    hasWorkspaceIdField: input.hasWorkspaceIdField,
    workspaceIdValue: input.workspaceIdValue,
    userId: input.userId,
  });

  if (binding.kind === "legacy") {
    return { kind: "not_workspace_bound" };
  }
  if (binding.kind === "personal") {
    return { kind: "not_team_workspace" };
  }
  if (binding.kind === "invalid") {
    return { kind: "invalid_run", reason: binding.reason };
  }

  // binding.kind === "non_personal_bound" from here on.
  if (binding.workspaceId !== input.requestedWorkspaceId) {
    return { kind: "wrong_workspace" };
  }

  const projectIdState = classifyProjectIdFieldState({ hasProjectIdField: input.hasProjectIdField, projectIdValue: input.projectIdValue });
  if (projectIdState === "absent" || projectIdState === "malformed") {
    return { kind: "invalid_run", reason: "malformed_project_id" };
  }

  return {
    kind: "valid_workspace_review_target",
    workspaceId: binding.workspaceId,
    projectId: projectIdState === "null" ? null : (input.projectIdValue as string),
    // classifyRunWorkspaceBindingShape's "non_personal_bound"/"personal" branches are only reachable
    // after getPersonalWorkspaceId(input.userId) succeeded internally — userId is therefore already
    // proven to be a non-empty, Firestore-safe, control-character-free string by this point.
    creatorUid: input.userId as string,
  };
}
