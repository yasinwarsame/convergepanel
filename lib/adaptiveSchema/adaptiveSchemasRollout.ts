/**
 * Adaptive Result Schema System, Phase 9D.0-A — UID-scoped canary
 * admission for `ADAPTIVE_SCHEMAS_ENABLED`.
 *
 * Structural mirror of `lib/workspaces/teamWorkspacesRollout.ts` (Phase
 * 8B.2) and `lib/workspaces/approvalWorkflowRollout.ts` (Phase 9B.4) —
 * same exact-uid-only matching, same trim/dedupe/max-10 rules, same
 * global-wins-over-malformed-canary precedence. This codebase's
 * established convention for a new canary use case is a new,
 * structurally-identical module, not a shared generic parser — followed
 * here rather than introducing a new abstraction or reusing an unrelated
 * one.
 *
 * Uid format validation reuses `getPersonalWorkspaceId()`'s existing
 * validator (rejects non-string, empty/whitespace-only, `/`-containing,
 * `.`/`..`, and over-length values) purely as a "is this a plausible
 * Firebase uid" shape check — never to derive a Personal Workspace id.
 *
 * This module is entirely independent of Team Workspace admission and
 * Approval Workflow admission — it decides only whether the caller's
 * request may enter `planAdaptiveRun()`. It never grants, widens, or
 * substitutes for either of those other two gates, and neither of them
 * substitutes for this one. A route invoking the adaptive planner must
 * still separately enforce whatever authorization it already required
 * before this flag existed (Team Workspace access, `research.create`,
 * usage, rate limiting, etc.).
 */

import "server-only";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

/** Narrow backend-capability canary, not an authorization/write mechanism on its own. */
export const MAX_ADAPTIVE_SCHEMAS_CANARY_UIDS = 10;

export type AdaptiveSchemasCanaryParseResult = { ok: true; uids: ReadonlySet<string> } | { ok: false; reason: "malformed_entry" | "too_many_entries" };

/**
 * Absent, empty, or whitespace-only input parses to an empty (valid, not
 * malformed) allowlist. A non-empty but invalid input (any entry failing
 * uid-shape validation, or more than `MAX_ADAPTIVE_SCHEMAS_CANARY_UIDS`
 * distinct entries) fails the WHOLE list, never partially — see
 * `resolveAdaptiveSchemasAdmission()` for what a `false` result here
 * actually does to eligibility.
 */
export function parseAdaptiveSchemasCanaryUids(raw: string | undefined): AdaptiveSchemasCanaryParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: true, uids: new Set() };
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const uids = new Set(entries); // exact-string dedupe

  if (uids.size > MAX_ADAPTIVE_SCHEMAS_CANARY_UIDS) {
    return { ok: false, reason: "too_many_entries" };
  }
  const anyInvalid = [...uids].some((uid) => !getPersonalWorkspaceId(uid).ok);
  if (anyInvalid) {
    return { ok: false, reason: "malformed_entry" };
  }
  return { ok: true, uids };
}

export type AdaptiveSchemasModeSource = "off" | "canary" | "global";

export interface AdaptiveSchemasMode {
  admitted: boolean;
  source: AdaptiveSchemasModeSource;
  /** True whenever the canary env was non-empty but failed to parse, REGARDLESS of `source` — surfaced separately so a caller can log a configuration diagnostic even on a request where `source: "global"` already made the canary list irrelevant to the eligibility decision. Never carries the configured UID values themselves. */
  canaryConfigInvalid: boolean;
}

/**
 * The single backend-capability decision point for "may this authenticated
 * request enter the adaptive planner" — never re-derived inline at any
 * future call site. Precedence, exactly mirroring
 * `resolveTeamWorkspacesMode()`/`resolveApprovalWorkflowAdmission()`:
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
 *
 * `uid` must be the server-resolved authenticated identity — never a
 * client-supplied value (request body/query param/header). Callers must
 * resolve identity via their existing hardened resolver BEFORE calling
 * this function, exactly as every other canary check in this codebase
 * already does.
 */
export function resolveAdaptiveSchemasAdmission(args: { uid: string; globalEnabled: boolean; canaryUidsRaw: string | undefined }): AdaptiveSchemasMode {
  const parsed = parseAdaptiveSchemasCanaryUids(args.canaryUidsRaw);
  const canaryConfigInvalid = !parsed.ok;

  if (args.globalEnabled) {
    return { admitted: true, source: "global", canaryConfigInvalid };
  }
  if (parsed.ok && parsed.uids.has(args.uid)) {
    return { admitted: true, source: "canary", canaryConfigInvalid };
  }
  return { admitted: false, source: "off", canaryConfigInvalid };
}
