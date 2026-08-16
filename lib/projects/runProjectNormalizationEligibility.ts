/**
 * Phase 6D.1 — pure classification logic for the future bounded
 * `projectId: null` normalization (Phase 6D.3). This module contains NO
 * Firestore access and NO write primitive of any kind — it only answers
 * "given already-resolved facts about a run, what would normalization do
 * with it?" Firestore reads live in `runProjectNormalizationDryRun.ts`;
 * the actual future write (a separate, later-authorized pass) is not
 * implemented anywhere in this module.
 *
 * Field-presence based throughout — never `!run.projectId`, which would
 * incorrectly treat an empty string or `0`-like falsy malformed value the
 * same as a genuinely absent field. "Absent" and "null" are two
 * structurally different states here even though both mean "Unfiled" at
 * the API layer later (see `projectDto.ts` design notes in Phase 6C).
 */

export type ProjectIdFieldState = "absent" | "null" | "assigned" | "malformed";

export interface ProjectIdFieldInput {
  hasProjectIdField: boolean;
  projectIdValue: unknown;
}

/** Classifies the raw `projectId` field state on a run document — presence first, then type/value. */
export function classifyProjectIdFieldState(input: ProjectIdFieldInput): ProjectIdFieldState {
  if (!input.hasProjectIdField) return "absent";
  if (input.projectIdValue === null) return "null";
  if (typeof input.projectIdValue === "string" && input.projectIdValue.length > 0) return "assigned";
  return "malformed";
}

export type RunNormalizationClassification =
  | "legacy"
  | "bound_invalid"
  | "would_normalize"
  | "already_null"
  | "already_assigned"
  | "malformed_blocker";

export interface RunNormalizationClassificationInput {
  /** `workspaceId` field presence on the run — absent/null means legacy. */
  hasWorkspaceIdField: boolean;
  workspaceIdValue: unknown;
  /**
   * Whether the run's `workspaceId` independently validates as this run's
   * owner's real, well-formed, personally-owned Workspace — only
   * meaningful when `hasWorkspaceIdField` is true. Computed by the caller
   * (real Firestore read in the dry-run orchestrator; a fake in tests) —
   * this module never reads Firestore itself, so a workspace-validation
   * failure always fails closed to `bound_invalid` regardless of what the
   * caller passes for the project-id fields.
   */
  workspaceValid: boolean;
  projectIdField: ProjectIdFieldInput;
}

/**
 * The single source of truth for "what would 6D.3 normalization do with
 * this run?" Only `would_normalize` runs are eligible for the future
 * `projectId: null` write — every other classification is either
 * out-of-scope (legacy, bound_invalid) or already-settled
 * (already_null, already_assigned) or a blocker requiring manual review
 * (malformed_blocker). A Workspace-validation failure always wins over
 * the project-id field state — an unverified Workspace association must
 * never be normalized no matter how clean its projectId field looks.
 */
export function classifyRunForNormalization(input: RunNormalizationClassificationInput): RunNormalizationClassification {
  if (!input.hasWorkspaceIdField || input.workspaceIdValue === null || input.workspaceIdValue === undefined) {
    return "legacy";
  }
  if (!input.workspaceValid) {
    return "bound_invalid";
  }
  const fieldState = classifyProjectIdFieldState(input.projectIdField);
  switch (fieldState) {
    case "absent":
      return "would_normalize";
    case "null":
      return "already_null";
    case "assigned":
      return "already_assigned";
    case "malformed":
      return "malformed_blocker";
  }
}
