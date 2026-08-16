/**
 * Projects Foundation, Phase 6B — narrow syntax validation for a
 * caller-supplied Project id, applied before any `projects/{projectId}`
 * lookup. This is defense-in-depth, not authorization: a syntactically
 * valid id can still fail to resolve, belong to another Workspace, or not
 * exist at all — those are `resolveProjectForOwner()`'s concern.
 *
 * Deliberately does NOT construct or derive an id the way
 * `getPersonalWorkspaceId()` does for Personal Workspaces — Project ids
 * are opaque, random Firestore auto-ids (`db.collection("projects").doc()`,
 * Phase 6C), never deterministic, so there is nothing to build here, only
 * something to sanity-check before it's used as a Firestore document path
 * segment.
 */

import "server-only";

export type ValidateProjectIdResult = { ok: true; projectId: string } | { ok: false; reason: "invalid_project_id" };

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

const MAX_PROJECT_ID_BYTES = 1500; // Firestore's own document-id byte limit

export function validateProjectIdSyntax(projectId: unknown): ValidateProjectIdResult {
  if (typeof projectId !== "string") return { ok: false, reason: "invalid_project_id" };
  if (projectId.length === 0) return { ok: false, reason: "invalid_project_id" };
  if (projectId.trim() !== projectId) return { ok: false, reason: "invalid_project_id" }; // no incidental whitespace
  if (CONTROL_CHAR_PATTERN.test(projectId)) return { ok: false, reason: "invalid_project_id" };
  if (projectId.includes("/")) return { ok: false, reason: "invalid_project_id" };
  if (projectId === "." || projectId === "..") return { ok: false, reason: "invalid_project_id" };
  if (Buffer.byteLength(projectId, "utf8") > MAX_PROJECT_ID_BYTES) return { ok: false, reason: "invalid_project_id" };

  return { ok: true, projectId };
}
