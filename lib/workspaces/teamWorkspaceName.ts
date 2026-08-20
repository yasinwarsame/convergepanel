/**
 * Team Workspace Core Foundation, Phase 8B — Team Workspace display-name
 * validation. Structural mirror of `lib/projects/projectName.ts`: unlike
 * a Personal Workspace's fixed, non-user-supplied `name` ("Personal
 * Workspace" — never real input), a Team Workspace name is genuine user
 * input from the moment of creation, so it needs the same validation a
 * Project name already gets.
 *
 * Deliberately not a shared/generalized function with `validateProjectName()`
 * — same rules today, but Workspace naming and Project naming are
 * independent product surfaces that may diverge later; a premature shared
 * abstraction would couple them for no current benefit.
 */

import "server-only";

export type ValidateTeamWorkspaceNameResult = { ok: true; name: string } | { ok: false; reason: "invalid_team_workspace_name" };

const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/** Returns the normalized (trimmed) name on success — never the raw, untrimmed input. */
export function validateTeamWorkspaceName(rawName: unknown): ValidateTeamWorkspaceNameResult {
  if (typeof rawName !== "string") return { ok: false, reason: "invalid_team_workspace_name" };

  const trimmed = rawName.trim();
  if (trimmed.length < MIN_NAME_LENGTH) return { ok: false, reason: "invalid_team_workspace_name" };
  if (trimmed.length > MAX_NAME_LENGTH) return { ok: false, reason: "invalid_team_workspace_name" };
  if (CONTROL_CHAR_PATTERN.test(trimmed)) return { ok: false, reason: "invalid_team_workspace_name" };

  return { ok: true, name: trimmed };
}
