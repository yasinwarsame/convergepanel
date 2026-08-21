/**
 * Team Run Lists, Phase 8C-B2 — pure, zero-I/O structural classification
 * of a run document's `workspaceId` field shape. Mirrors the FIRST
 * structural check of `validateRunWorkspaceBinding()`
 * (`lib/projects/validateRunWorkspaceBinding.ts` — `getPersonalWorkspaceId(userId)`
 * compared against the stored `workspaceId`) without its I/O
 * continuation (`getWorkspace()`), and WITHOUT modifying that file or any
 * of its existing callers — this is a deliberate, frozen duplication
 * (Phase 8C-B.0/8C-B.0.1 architecture review), not an extraction.
 *
 * This classifier is NOT authorization. It never touches Firestore, never
 * proves a Team Workspace exists, and never proves the caller may access
 * anything. It answers exactly one structural question: "given a run's
 * own `userId`/`workspaceId` field values, what shape is its Workspace
 * binding?" — nothing more. `non_personal_bound` in particular means
 * ONLY "this run is explicitly bound somewhere other than its owner's
 * deterministic Personal Workspace" — it is not evidence of Team
 * membership, and callers must never treat it as one.
 */

import { getPersonalWorkspaceId } from "./personalWorkspaceId";

export type ClassifyRunWorkspaceBindingShapeResult =
  | { kind: "personal"; workspaceId: string }
  | { kind: "non_personal_bound"; workspaceId: string }
  | { kind: "legacy" }
  | {
      kind: "invalid";
      reason: "malformed_workspace_id" | "run_owner_invalid";
    };

export interface ClassifyRunWorkspaceBindingShapeInput {
  hasWorkspaceIdField: boolean;
  workspaceIdValue: unknown;
  userId: unknown;
}

export function classifyRunWorkspaceBindingShape(input: ClassifyRunWorkspaceBindingShapeInput): ClassifyRunWorkspaceBindingShapeResult {
  // A. workspaceId key absent entirely — legacy, never a Workspace claim.
  if (!input.hasWorkspaceIdField) {
    return { kind: "legacy" };
  }

  // B/C/D. Present but not a well-formed string (undefined, non-string,
  // or empty) — malformed, never guessed at or coerced.
  if (typeof input.workspaceIdValue !== "string" || input.workspaceIdValue.length === 0) {
    return { kind: "invalid", reason: "malformed_workspace_id" };
  }
  const workspaceId = input.workspaceIdValue;

  // E. The run's own userId cannot even produce a deterministic Personal
  // Workspace id — an invalid ownership field is a blocker distinct from
  // an ordinary Personal/non-Personal classification, checked BEFORE the
  // comparison below so it is never silently absorbed into
  // "non_personal_bound".
  const expectedPersonal = getPersonalWorkspaceId(input.userId);
  if (!expectedPersonal.ok) {
    return { kind: "invalid", reason: "run_owner_invalid" };
  }

  // F. Matches this run's own owner's deterministic Personal Workspace id.
  if (workspaceId === expectedPersonal.workspaceId) {
    return { kind: "personal", workspaceId };
  }

  // G. A well-formed, non-empty string that is not this run's own
  // owner's Personal Workspace id — bound somewhere else. NOT Team by
  // implication; callers must independently authorize/classify further.
  return { kind: "non_personal_bound", workspaceId };
}
