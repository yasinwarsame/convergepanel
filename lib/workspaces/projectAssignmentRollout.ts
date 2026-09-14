/**
 * Project/Research Assignment (D10) — dedicated backend rollout resolver for
 * the Team Project assignee and Team run assignee mutations.
 *
 * Structural mirror of `lib/workspaces/approvalWorkflowRollout.ts` (itself a
 * mirror of `teamWorkspacesRollout.ts`) — same exact-uid-only matching,
 * same trim/dedupe/max-10 rules, same global-wins-over-malformed-canary
 * precedence. This codebase's established convention for a new canary use
 * case is a new, structurally-identical module, not a shared generic
 * parser.
 *
 * This is a SEPARATE rollout axis from Team Workspaces: both
 * `resolveTeamWorkspaceTargetAdmission()` and this resolver must admit a
 * caller before either assignment primitive touches Firestore, and neither
 * substitutes for the other. It answers admission only — never
 * authorization, which comes from Workspace membership/role — and it gates
 * only the two assignment MUTATIONS (and the offering of their UI
 * controls). Assignee READ fields are data and are emitted regardless.
 */

import "server-only";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

/** Narrow backend-capability canary, not an authorization/write mechanism on its own. */
export const MAX_PROJECT_ASSIGNMENT_CANARY_UIDS = 10;

export type ProjectAssignmentCanaryParseResult = { ok: true; uids: ReadonlySet<string> } | { ok: false; reason: "malformed_entry" | "too_many_entries" };

/**
 * Absent, empty, or whitespace-only input parses to an empty (valid, not
 * malformed) allowlist. A non-empty but invalid input (any entry failing
 * uid-shape validation, or more than `MAX_PROJECT_ASSIGNMENT_CANARY_UIDS`
 * distinct entries) fails the WHOLE list, never partially.
 */
export function parseProjectAssignmentCanaryUids(raw: string | undefined): ProjectAssignmentCanaryParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: true, uids: new Set() };
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const uids = new Set(entries); // exact-string dedupe

  if (uids.size > MAX_PROJECT_ASSIGNMENT_CANARY_UIDS) {
    return { ok: false, reason: "too_many_entries" };
  }
  const anyInvalid = [...uids].some((uid) => !getPersonalWorkspaceId(uid).ok);
  if (anyInvalid) {
    return { ok: false, reason: "malformed_entry" };
  }
  return { ok: true, uids };
}

export type ProjectAssignmentModeSource = "off" | "canary" | "global";

export interface ProjectAssignmentMode {
  admitted: boolean;
  source: ProjectAssignmentModeSource;
  /** True whenever the canary env was non-empty but failed to parse, regardless of `source` — never carries the configured UID values themselves. */
  canaryConfigInvalid: boolean;
}

/**
 * The single decision point for Project Assignment admission — never
 * re-derived inline at any call site. Precedence, exactly mirroring
 * `resolveApprovalWorkflowAdmission()`:
 *
 *   globalEnabled=true          -> source: "global", always wins
 *   uid in a VALID canary list  -> source: "canary"
 *   otherwise                   -> source: "off"
 *
 * `source` is diagnostic only: no caller may branch on it to grant a
 * different capability set.
 */
export function resolveProjectAssignmentAdmission(args: { uid: string; globalEnabled: boolean; canaryUidsRaw: string | undefined }): ProjectAssignmentMode {
  const parsed = parseProjectAssignmentCanaryUids(args.canaryUidsRaw);
  const canaryConfigInvalid = !parsed.ok;

  if (args.globalEnabled) {
    return { admitted: true, source: "global", canaryConfigInvalid };
  }
  if (parsed.ok && parsed.uids.has(args.uid)) {
    return { admitted: true, source: "canary", canaryConfigInvalid };
  }
  return { admitted: false, source: "off", canaryConfigInvalid };
}
