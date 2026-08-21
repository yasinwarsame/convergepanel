/**
 * Personal Run/Project Invariant Health Check, Phase 8C-B1.3B — pure,
 * I/O-free classification logic for the read-only operational verifier
 * (`scripts/projects/check-project-run-invariant.ts`). No Firestore
 * access here; the script wires in real reads, tests wire in fixtures.
 *
 * Reuses the existing canonical helpers rather than defining competing
 * ones: `getPersonalWorkspaceId()` (the single source of truth for a
 * uid's Personal Workspace id) and `classifyProjectIdFieldState()` (the
 * single source of truth for absent/null/assigned/malformed). This
 * module only combines their outputs into the health-check-specific
 * verdict.
 */

import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";
import { classifyProjectIdFieldState, type ProjectIdFieldState } from "./runProjectNormalizationEligibility";

export type RunInvariantVerdict =
  /** No `workspaceId` field (or null/undefined) — pre-Workspace legacy data, outside this invariant's scope entirely. */
  | "legacy_no_workspace"
  /** `workspaceId` present but does not match this run's own owner's deterministic Personal Workspace id — Team-bound or otherwise foreign-shaped; Personal semantics never apply. */
  | "non_personal_workspace"
  /** Personal Workspace-bound, `projectId` explicitly null — canonical Unfiled. */
  | "personal_unfiled"
  /** Personal Workspace-bound, `projectId` a valid (non-empty string) Project id — filed. Structural validity only; does not resolve whether the referenced Project document exists. */
  | "personal_filed"
  /** Personal Workspace-bound, `projectId` field entirely absent — the invariant this phase's writer hardening exists to prevent. */
  | "personal_violation_absent"
  /** Personal Workspace-bound, `projectId` present but neither null nor a valid non-empty string — integrity violation. */
  | "personal_violation_malformed";

export interface RunInvariantCheckInput {
  userId: unknown;
  hasWorkspaceIdField: boolean;
  workspaceIdValue: unknown;
  hasProjectIdField: boolean;
  projectIdValue: unknown;
}

const VIOLATION_VERDICTS: ReadonlySet<RunInvariantVerdict> = new Set(["personal_violation_absent", "personal_violation_malformed"]);

export function isRunInvariantViolation(verdict: RunInvariantVerdict): boolean {
  return VIOLATION_VERDICTS.has(verdict);
}

/** Never reads Firestore, never mutates anything — a pure function of one run's already-fetched field values. */
export function classifyRunForInvariantCheck(input: RunInvariantCheckInput): RunInvariantVerdict {
  if (!input.hasWorkspaceIdField || input.workspaceIdValue === null || input.workspaceIdValue === undefined) {
    return "legacy_no_workspace";
  }
  if (typeof input.workspaceIdValue !== "string" || input.workspaceIdValue.length === 0) {
    // A structurally malformed workspaceId (wrong type, empty) can never
    // equal a well-formed Personal Workspace id string — never Personal.
    return "non_personal_workspace";
  }

  const expectedPersonal = getPersonalWorkspaceId(input.userId);
  const isPersonalBound = expectedPersonal.ok && input.workspaceIdValue === expectedPersonal.workspaceId;
  if (!isPersonalBound) {
    return "non_personal_workspace";
  }

  const fieldState: ProjectIdFieldState = classifyProjectIdFieldState({
    hasProjectIdField: input.hasProjectIdField,
    projectIdValue: input.projectIdValue,
  });
  switch (fieldState) {
    case "null":
      return "personal_unfiled";
    case "assigned":
      return "personal_filed";
    case "absent":
      return "personal_violation_absent";
    case "malformed":
      return "personal_violation_malformed";
  }
}
