/**
 * Team Workspace Core Foundation, Phase 8B.2 — dark backend rollout
 * resolver for Team Workspace capability (creation, ownership transfer,
 * membership-based Team access resolution).
 *
 * Structural mirror of `lib/projects/projectsRollout.ts` (Phase 6B) —
 * same exact-uid-only matching, same trim/dedupe/max-10 rules, same
 * global-wins-over-malformed-canary precedence. This codebase's
 * established convention for a new canary use case is a new,
 * structurally-identical module, not a shared generic parser — followed
 * here rather than introducing a new abstraction.
 *
 * Uid format validation reuses `getPersonalWorkspaceId()`'s existing
 * validator (rejects non-string, empty/whitespace-only, `/`-containing,
 * `.`/`..`, and over-length values) purely as a "is this a plausible
 * Firebase uid" shape check — never to derive a Personal Workspace id.
 * Team Workspaces have no id-scheme relationship to Personal Workspaces;
 * this is the same uid-shape validator `projectsRollout.ts` already
 * reuses for the identical reason.
 */

import "server-only";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

/** Narrow backend-capability canary, not an authorization/write mechanism on its own. */
export const MAX_TEAM_WORKSPACES_CANARY_UIDS = 10;

export type TeamWorkspacesCanaryParseResult = { ok: true; uids: ReadonlySet<string> } | { ok: false; reason: "malformed_entry" | "too_many_entries" };

/**
 * Absent, empty, or whitespace-only input parses to an empty (valid, not
 * malformed) allowlist. A non-empty but invalid input (any entry failing
 * uid-shape validation, or more than `MAX_TEAM_WORKSPACES_CANARY_UIDS`
 * distinct entries) fails the WHOLE list, never partially — see
 * `resolveTeamWorkspacesMode()` for what a `false` result here actually
 * does to eligibility.
 */
export function parseTeamWorkspacesCanaryUids(raw: string | undefined): TeamWorkspacesCanaryParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: true, uids: new Set() };
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const uids = new Set(entries); // exact-string dedupe

  if (uids.size > MAX_TEAM_WORKSPACES_CANARY_UIDS) {
    return { ok: false, reason: "too_many_entries" };
  }
  const anyInvalid = [...uids].some((uid) => !getPersonalWorkspaceId(uid).ok);
  if (anyInvalid) {
    return { ok: false, reason: "malformed_entry" };
  }
  return { ok: true, uids };
}

export type TeamWorkspacesModeSource = "off" | "canary" | "global";

export interface TeamWorkspacesMode {
  enabled: boolean;
  source: TeamWorkspacesModeSource;
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
 * The single backend-capability decision point for Team Workspaces —
 * never re-derived inline at any future call site. Precedence, exactly
 * mirroring `resolveProjectsMode()`:
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
export function resolveTeamWorkspacesMode(args: { uid: string; globalEnabled: boolean; canaryUidsRaw: string | undefined }): TeamWorkspacesMode {
  const parsed = parseTeamWorkspacesCanaryUids(args.canaryUidsRaw);
  const canaryConfigInvalid = !parsed.ok;

  if (args.globalEnabled) {
    return { enabled: true, source: "global", canaryConfigInvalid };
  }
  if (parsed.ok && parsed.uids.has(args.uid)) {
    return { enabled: true, source: "canary", canaryConfigInvalid };
  }
  return { enabled: false, source: "off", canaryConfigInvalid };
}
