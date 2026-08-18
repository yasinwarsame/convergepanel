/**
 * Phase 7B — dark UI rollout for the Projects shell.
 *
 * Structural mirror of `lib/workspaces/workspaceUiRollout.ts` (Phase 5C's
 * Workspace UI canary) and `lib/projects/projectsRollout.ts` (Phase 6B's
 * Projects backend canary) — same exact-uid-only matching, same
 * trim/dedupe/max-10 rules, same `getPersonalWorkspaceId().ok` reuse for
 * uid validity, same global-wins-over-malformed-canary precedence. This
 * module decides UI PRESENTATION only — it has no dependency on, and no
 * effect on, `PROJECTS_ENABLED`/`PROJECTS_CANARY_UIDS` (backend Project
 * capability). Phase 6C/7A's Project APIs never call this module and
 * remain reachable to any backend-eligible authenticated user regardless
 * of what this resolver decides.
 *
 * This resolver alone does NOT decide whether a user can see the Projects
 * UI — see `lib/projects/projectsUiEligibility.ts` for the combined
 * (UI AND backend) decision the route/nav actually use.
 */

import "server-only";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

/** Narrow UI-presentation canary, not an authorization/write mechanism. */
export const MAX_PROJECTS_UI_CANARY_UIDS = 10;

export type ProjectsUiCanaryParseResult =
  | { ok: true; uids: ReadonlySet<string> }
  | { ok: false; reason: "malformed_entry" | "too_many_entries" };

/**
 * Absent, empty, or whitespace-only input parses to an empty (valid, not
 * malformed) allowlist. A non-empty but invalid input (any entry failing
 * `getPersonalWorkspaceId()`'s validation, or more than
 * `MAX_PROJECTS_UI_CANARY_UIDS` distinct entries) fails the WHOLE list,
 * never partially — see `resolveProjectsUiMode()` for what a `false`
 * result here actually does to eligibility.
 */
export function parseProjectsUiCanaryUids(raw: string | undefined): ProjectsUiCanaryParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: true, uids: new Set() };
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const uids = new Set(entries); // exact-string dedupe

  if (uids.size > MAX_PROJECTS_UI_CANARY_UIDS) {
    return { ok: false, reason: "too_many_entries" };
  }
  const anyInvalid = [...uids].some((uid) => !getPersonalWorkspaceId(uid).ok);
  if (anyInvalid) {
    return { ok: false, reason: "malformed_entry" };
  }
  return { ok: true, uids };
}

export type ProjectsUiModeSource = "off" | "canary" | "global";

export interface ProjectsUiMode {
  enabled: boolean;
  source: ProjectsUiModeSource;
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
 * The single UI-rollout decision point — never re-derived inline at any
 * call site. Precedence, exactly as specified:
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
export function resolveProjectsUiMode(args: { uid: string; globalEnabled: boolean; canaryUidsRaw: string | undefined }): ProjectsUiMode {
  const parsed = parseProjectsUiCanaryUids(args.canaryUidsRaw);
  const canaryConfigInvalid = !parsed.ok;

  if (args.globalEnabled) {
    return { enabled: true, source: "global", canaryConfigInvalid };
  }
  if (parsed.ok && parsed.uids.has(args.uid)) {
    return { enabled: true, source: "canary", canaryConfigInvalid };
  }
  return { enabled: false, source: "off", canaryConfigInvalid };
}
