/**
 * Going-Forward Run/Project Association Write Canary, Phase 6D.2.
 *
 * Structural mirror of `lib/workspaces/personalRunWorkspaceWriteCanary.ts`
 * (Phase 3A) — same parsing rules, same exact-uid matching, same
 * precedence, same terminology. Deliberately NOT a second interpretation
 * of "master + canary": the canary here is an independent activation
 * path, exactly like the proven Workspace write canary, not a value that
 * only narrows an already-enabled global flag. This module contains no
 * Workspace resolution, no run creation, no persistence — it only decides
 * which uid gets `enabled: true` fed into the caller's own already-built
 * write path (`app/api/run-panel/route.ts`).
 *
 * Canary matching is uid-only, exact-equality-only — never email, never
 * display name, never anything derived from the request body.
 */

import "server-only";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

/** Mirrors MAX_PERSONAL_RUN_WORKSPACE_CANARY_UIDS — same cohort size, same rationale (narrow canary mechanism, not the global rollout mechanism). */
export const MAX_PROJECT_RUN_ASSOCIATION_CANARY_UIDS = 10;

export type ProjectRunAssociationCanaryAllowlistParseResult =
  | { ok: true; uids: ReadonlySet<string> }
  | { ok: false; reason: "malformed_entry" | "too_many_entries" };

/**
 * Absent, empty, or whitespace-only input parses to an empty (valid, not
 * malformed) allowlist. A NON-EMPTY but invalid input (any entry that
 * fails `getPersonalWorkspaceId()`'s validation, or more than
 * `MAX_PROJECT_RUN_ASSOCIATION_CANARY_UIDS` distinct entries) fails the
 * WHOLE list, never partially — mirrors
 * `parseCanaryUidAllowlist()` (Phase 3A) exactly.
 */
export function parseProjectRunAssociationCanaryUidAllowlist(raw: string | undefined): ProjectRunAssociationCanaryAllowlistParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: true, uids: new Set() };
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const uids = new Set(entries);

  if (uids.size > MAX_PROJECT_RUN_ASSOCIATION_CANARY_UIDS) {
    return { ok: false, reason: "too_many_entries" };
  }
  const anyInvalid = [...uids].some((uid) => !getPersonalWorkspaceId(uid).ok);
  if (anyInvalid) {
    return { ok: false, reason: "malformed_entry" };
  }
  return { ok: true, uids };
}

export type ProjectRunAssociationWriteModeSource = "off" | "canary" | "global";

export interface ProjectRunAssociationWriteMode {
  enabled: boolean;
  source: ProjectRunAssociationWriteModeSource;
  /** True whenever the canary env was non-empty but failed to parse, REGARDLESS of `source` — mirrors `canaryConfigInvalid` (Phase 3A) exactly. */
  canaryConfigInvalid: boolean;
}

/**
 * The single write-mode decision point for the going-forward
 * `projectId: null` writer. Precedence, exactly mirroring
 * `resolvePersonalRunWorkspaceWriteMode()` (Phase 3A):
 *
 *   globalWritesEnabled=true  -> source: "global", always wins, regardless
 *                                 of whether the canary list is even valid
 *   uid in a VALID canary list -> source: "canary" (independent of global)
 *   otherwise                  -> source: "off"
 *
 * An INVALID (malformed/too-large) canary list, when global is off, NEVER
 * activates any uid — fails closed to "off," never "everyone."
 */
export function resolveProjectRunAssociationWriteMode(args: {
  uid: string;
  globalWritesEnabled: boolean;
  canaryUidsRaw: string | undefined;
}): ProjectRunAssociationWriteMode {
  const parsed = parseProjectRunAssociationCanaryUidAllowlist(args.canaryUidsRaw);
  const canaryConfigInvalid = !parsed.ok;

  if (args.globalWritesEnabled) {
    return { enabled: true, source: "global", canaryConfigInvalid };
  }
  if (parsed.ok && parsed.uids.has(args.uid)) {
    return { enabled: true, source: "canary", canaryConfigInvalid };
  }
  return { enabled: false, source: "off", canaryConfigInvalid };
}
