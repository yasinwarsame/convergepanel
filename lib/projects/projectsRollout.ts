/**
 * Projects Foundation, Phase 6B — dark backend rollout resolver for
 * Project capability (CRUD + `projectId` authorization).
 *
 * Structural mirror of `lib/workspaces/workspaceUiRollout.ts` (Phase 5C's
 * UI canary) and `lib/workspaces/personalRunWorkspaceWriteCanary.ts`
 * (Phase 3A's write canary) — same exact-uid-only matching, same
 * trim/dedupe/max-10 rules, same global-wins-over-malformed-canary
 * precedence. This codebase's established convention for a new canary use
 * case is a new, structurally-identical module, not a shared generic
 * parser — followed here rather than introducing a new abstraction.
 *
 * This module decides backend Project capability only — it has no effect
 * on `WORKSPACES_ENABLED`/`PERSONAL_WORKSPACE_PROVISIONING_ENABLED`/
 * `PERSONAL_RUN_WORKSPACE_WRITES_ENABLED` or their canaries, and no route
 * calls it yet (Phase 6C).
 *
 * Deliberately excludes `PROJECTS_UI_ENABLED`/`PROJECTS_UI_CANARY_UIDS`
 * (Phase 7's own, separate resolver — Phase 6A.1's frozen decision to keep
 * backend and UI canary cohorts genuinely independent) and
 * `PROJECT_RUN_ASSOCIATION_WRITES_ENABLED` (Phase 6D's own flag, gating a
 * capability that doesn't exist yet) — neither belongs in Phase 6B.
 */

import "server-only";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

/** Narrow backend-capability canary, not an authorization/write mechanism on its own. */
export const MAX_PROJECTS_CANARY_UIDS = 10;

export type ProjectsCanaryParseResult =
  | { ok: true; uids: ReadonlySet<string> }
  | { ok: false; reason: "malformed_entry" | "too_many_entries" };

/**
 * Absent, empty, or whitespace-only input parses to an empty (valid, not
 * malformed) allowlist. A non-empty but invalid input (any entry failing
 * `getPersonalWorkspaceId()`'s validation, or more than
 * `MAX_PROJECTS_CANARY_UIDS` distinct entries) fails the WHOLE list, never
 * partially — see `resolveProjectsMode()` for what a `false` result here
 * actually does to eligibility.
 */
export function parseProjectsCanaryUids(raw: string | undefined): ProjectsCanaryParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: true, uids: new Set() };
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const uids = new Set(entries); // exact-string dedupe

  if (uids.size > MAX_PROJECTS_CANARY_UIDS) {
    return { ok: false, reason: "too_many_entries" };
  }
  const anyInvalid = [...uids].some((uid) => !getPersonalWorkspaceId(uid).ok);
  if (anyInvalid) {
    return { ok: false, reason: "malformed_entry" };
  }
  return { ok: true, uids };
}

export type ProjectsModeSource = "off" | "canary" | "global";

export interface ProjectsMode {
  enabled: boolean;
  source: ProjectsModeSource;
  /**
   * True whenever the canary env was non-empty but failed to parse,
   * REGARDLESS of `source` — surfaced separately so a caller can log a
   * configuration diagnostic even on a request where `source: "global"`
   * already made the canary list irrelevant to the eligibility decision.
   * Never carries the configured UID values themselves.
   */
  canaryConfigInvalid: boolean;
}

/**
 * The single backend-capability decision point for Projects — never
 * re-derived inline at any future call site. Precedence, exactly mirroring
 * the proven Workspace UI/write-canary shape:
 *
 *   globalEnabled=true          -> source: "global", always wins,
 *                                   regardless of whether the canary list
 *                                   is even valid (a deliberately-enabled
 *                                   global rollout must never be silently
 *                                   disabled by an unrelated allowlist typo)
 *   uid in a VALID canary list  -> source: "canary"
 *   otherwise                   -> source: "off"
 *
 * An INVALID (malformed/too-large) canary list, when global is not true,
 * NEVER activates any uid — fails closed to "off" for every request,
 * never "everyone" and never "guess which entries were probably valid."
 */
export function resolveProjectsMode(args: { uid: string; globalEnabled: boolean; canaryUidsRaw: string | undefined }): ProjectsMode {
  const parsed = parseProjectsCanaryUids(args.canaryUidsRaw);
  const canaryConfigInvalid = !parsed.ok;

  if (args.globalEnabled) {
    return { enabled: true, source: "global", canaryConfigInvalid };
  }
  if (parsed.ok && parsed.uids.has(args.uid)) {
    return { enabled: true, source: "canary", canaryConfigInvalid };
  }
  return { enabled: false, source: "off", canaryConfigInvalid };
}
