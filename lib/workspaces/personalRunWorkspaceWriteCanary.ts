/**
 * Account-Scoped Workspace Write Canary, Phase 3A.
 *
 * The ONLY thing this module changes is which authenticated uids get
 * `writesEnabled: true` fed into the already-built, already-reviewed
 * Phase 3 write path (`resolvePersonalRunWorkspaceBinding()`,
 * `lib/workspaces/personalRunWorkspaceBinding.ts`). It contains no
 * Workspace resolution, no validation, no persistence, no
 * failure-before-spend logic of its own — those all stay exactly as
 * Phase 3 built and hardened them, reused verbatim by whichever uid this
 * module selects. This module is a selector, not a reimplementation.
 *
 * Canary matching is uid-only, exact-equality-only: never email, never
 * display name, never anything derived from the request body (the caller
 * always supplies the already-authenticated `resolveRequestIdentity()`
 * uid — see app/api/run-panel/route.ts). No wildcard, no prefix, no
 * substring matching exists anywhere in this module.
 */

import "server-only";
import { getPersonalWorkspaceId } from "./personalWorkspaceId";

/** Narrow canary mechanism, not the global rollout mechanism — global rollout uses PERSONAL_RUN_WORKSPACE_WRITES_ENABLED=true instead of an ever-growing allowlist. */
export const MAX_PERSONAL_RUN_WORKSPACE_CANARY_UIDS = 10;

export type CanaryAllowlistParseResult =
  | { ok: true; uids: ReadonlySet<string> }
  | { ok: false; reason: "malformed_entry" | "too_many_entries" };

/**
 * Absent, empty, or whitespace-only input parses to an empty (valid, not
 * malformed) allowlist — canary mode simply has nothing to match, same as
 * not configuring it at all. A NON-EMPTY but invalid input (any entry
 * that fails `getPersonalWorkspaceId()`'s validation, or more than
 * `MAX_PERSONAL_RUN_WORKSPACE_CANARY_UIDS` distinct entries) fails the
 * WHOLE list, never partially — silently accepting the valid entries
 * while dropping the invalid ones would let an operator's typo activate
 * (or fail to activate) canary access for the wrong set of accounts with
 * no clear signal either way. A caller-visible `false` here is the
 * signal; `resolvePersonalRunWorkspaceWriteMode()` below is the one place
 * that decides what a `false` result actually does to eligibility (see
 * its own doc comment — never a silent broadening).
 */
export function parseCanaryUidAllowlist(raw: string | undefined): CanaryAllowlistParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: true, uids: new Set() };
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const uids = new Set(entries); // exact-string dedupe

  if (uids.size > MAX_PERSONAL_RUN_WORKSPACE_CANARY_UIDS) {
    return { ok: false, reason: "too_many_entries" };
  }
  const anyInvalid = [...uids].some((uid) => !getPersonalWorkspaceId(uid).ok);
  if (anyInvalid) {
    return { ok: false, reason: "malformed_entry" };
  }
  return { ok: true, uids };
}

export type PersonalRunWorkspaceWriteModeSource = "off" | "canary" | "global";

export interface PersonalRunWorkspaceWriteMode {
  enabled: boolean;
  source: PersonalRunWorkspaceWriteModeSource;
  /**
   * True whenever the canary env was non-empty but failed to parse,
   * REGARDLESS of `source` — surfaced separately so the caller can log a
   * configuration diagnostic even on a request where `source: "global"`
   * already made the canary list irrelevant to the eligibility decision
   * itself (see the precedence rule below).
   */
  canaryConfigInvalid: boolean;
}

/**
 * The single write-mode decision point — never re-derived inline at any
 * call site. Precedence, exactly as specified:
 *
 *   globalWritesEnabled=true  -> source: "global", always wins, regardless
 *                                 of whether the canary list is even valid
 *                                 (a deliberately-enabled global rollout
 *                                 must never be silently disabled by an
 *                                 unrelated allowlist typo — this is why
 *                                 `canaryConfigInvalid` is a separate,
 *                                 always-computed field: an operator can
 *                                 still SEE the misconfiguration in logs
 *                                 even though it had zero effect here)
 *   uid in a VALID canary list -> source: "canary"
 *   otherwise                  -> source: "off"
 *
 * An INVALID (malformed/too-large) canary list, when global is off, NEVER
 * activates any uid — fails closed to "off" for every request, never
 * "everyone" and never "guess which entries were probably valid."
 */
export function resolvePersonalRunWorkspaceWriteMode(args: {
  uid: string;
  globalWritesEnabled: boolean;
  canaryUidsRaw: string | undefined;
}): PersonalRunWorkspaceWriteMode {
  const parsed = parseCanaryUidAllowlist(args.canaryUidsRaw);
  const canaryConfigInvalid = !parsed.ok;

  if (args.globalWritesEnabled) {
    return { enabled: true, source: "global", canaryConfigInvalid };
  }
  if (parsed.ok && parsed.uids.has(args.uid)) {
    return { enabled: true, source: "canary", canaryConfigInvalid };
  }
  return { enabled: false, source: "off", canaryConfigInvalid };
}
