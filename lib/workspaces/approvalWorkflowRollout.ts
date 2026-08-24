/**
 * Approval Workflow, Phase 9B.4 — dark backend rollout resolver for the
 * first public Phase 9 route (`GET /api/workspaces/{workspaceId}/review-queue`).
 *
 * Structural mirror of `lib/workspaces/teamWorkspacesRollout.ts` (Phase
 * 8B.2) — same exact-uid-only matching, same trim/dedupe/max-10 rules,
 * same global-wins-over-malformed-canary precedence. This codebase's
 * established convention for a new canary use case is a new,
 * structurally-identical module, not a shared generic parser.
 *
 * This is a SEPARATE rollout axis from Team Workspaces — see
 * `resolveApprovalWorkflowAdmission()` below for how the two compose (both
 * required, neither substitutes for the other).
 */

import "server-only";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

/** Narrow backend-capability canary, not an authorization/write mechanism on its own. */
export const MAX_APPROVAL_WORKFLOW_CANARY_UIDS = 10;

export type ApprovalWorkflowCanaryParseResult = { ok: true; uids: ReadonlySet<string> } | { ok: false; reason: "malformed_entry" | "too_many_entries" };

/**
 * Absent, empty, or whitespace-only input parses to an empty (valid, not
 * malformed) allowlist. A non-empty but invalid input (any entry failing
 * uid-shape validation, or more than `MAX_APPROVAL_WORKFLOW_CANARY_UIDS`
 * distinct entries) fails the WHOLE list, never partially.
 */
export function parseApprovalWorkflowCanaryUids(raw: string | undefined): ApprovalWorkflowCanaryParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: true, uids: new Set() };
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const uids = new Set(entries); // exact-string dedupe

  if (uids.size > MAX_APPROVAL_WORKFLOW_CANARY_UIDS) {
    return { ok: false, reason: "too_many_entries" };
  }
  const anyInvalid = [...uids].some((uid) => !getPersonalWorkspaceId(uid).ok);
  if (anyInvalid) {
    return { ok: false, reason: "malformed_entry" };
  }
  return { ok: true, uids };
}

export type ApprovalWorkflowModeSource = "off" | "canary" | "global";

export interface ApprovalWorkflowMode {
  admitted: boolean;
  source: ApprovalWorkflowModeSource;
  /** True whenever the canary env was non-empty but failed to parse, regardless of `source` — never carries the configured UID values themselves. */
  canaryConfigInvalid: boolean;
}

/**
 * The single backend-capability decision point for Approval Workflow
 * admission — never re-derived inline at any future call site. Precedence,
 * exactly mirroring `resolveTeamWorkspacesMode()`:
 *
 *   globalEnabled=true          -> source: "global", always wins
 *   uid in a VALID canary list  -> source: "canary"
 *   otherwise                   -> source: "off"
 *
 * This function answers ONLY "is the Approval Workflow surface itself
 * admitted for this uid" — it is one of TWO independent, both-required
 * gates for the review-queue route. It never grants, widens, or
 * substitutes for Team Workspace access; the caller must separately check
 * `resolveTeamWorkspacesMode()`/`resolveTeamRunWorkspaceAccess()` and deny
 * if EITHER gate fails.
 */
export function resolveApprovalWorkflowAdmission(args: { uid: string; globalEnabled: boolean; canaryUidsRaw: string | undefined }): ApprovalWorkflowMode {
  const parsed = parseApprovalWorkflowCanaryUids(args.canaryUidsRaw);
  const canaryConfigInvalid = !parsed.ok;

  if (args.globalEnabled) {
    return { admitted: true, source: "global", canaryConfigInvalid };
  }
  if (parsed.ok && parsed.uids.has(args.uid)) {
    return { admitted: true, source: "canary", canaryConfigInvalid };
  }
  return { admitted: false, source: "off", canaryConfigInvalid };
}
