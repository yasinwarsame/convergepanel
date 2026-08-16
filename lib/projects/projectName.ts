/**
 * Projects Foundation, Phase 6B — Project display-name validation.
 * Reusable by the future Phase 6C create/rename APIs.
 *
 * Unlike `WorkspaceV1.name` (a fixed, non-user-supplied default —
 * "Personal Workspace" — never real user input, so `isWellFormedWorkspaceV1`
 * deliberately validates it for type only), a Project name is genuine user
 * input from the moment it's created. This validator exists specifically
 * because Workspace never needed one.
 *
 * Deliberately does NOT lowercase, slugify, or otherwise transform the
 * name into an identity-bearing value — Project identity is always the
 * opaque Firestore document id (see `projectId.ts`), never derived from
 * name. Duplicate display names across Projects in the same Workspace are
 * allowed by design (Phase 6A decision) — this validator has no
 * uniqueness/deduplication concept at all.
 */

import "server-only";

export type ValidateProjectNameResult = { ok: true; name: string } | { ok: false; reason: "invalid_project_name" };

const MIN_PROJECT_NAME_LENGTH = 1;
const MAX_PROJECT_NAME_LENGTH = 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/** Returns the normalized (trimmed) name on success — never the raw, untrimmed input. */
export function validateProjectName(rawName: unknown): ValidateProjectNameResult {
  if (typeof rawName !== "string") return { ok: false, reason: "invalid_project_name" };

  const trimmed = rawName.trim();
  if (trimmed.length < MIN_PROJECT_NAME_LENGTH) return { ok: false, reason: "invalid_project_name" };
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) return { ok: false, reason: "invalid_project_name" };
  if (CONTROL_CHAR_PATTERN.test(trimmed)) return { ok: false, reason: "invalid_project_name" };

  return { ok: true, name: trimmed };
}
