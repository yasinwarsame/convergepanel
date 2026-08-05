/**
 * Adaptive Synthesis Report, Phase 1 (docs/adaptive-synthesis-report-design.md
 * §4.1, docs/adaptive-research-export-design.md §4.1) — the report-status
 * model both documents specified, implemented once here and consumed by
 * both the top summary bar (this phase) and, later, export (deferred per
 * the export design's own §8 sequencing).
 *
 * Client-safe (no "server-only") — this is pure derivation over already-
 * fetched data, computed identically whether the caller is a live
 * /api/run-panel response or a GET /api/user/runs/[runId] reload.
 *
 * Deliberately does NOT include "superseded" — that status only applies to
 * a frozen export artifact compared against a live record (Export design
 * §4.1's "Superseded" row), never to this live, always-current view.
 */

import type { GovernanceRecordV1 } from "./governanceRecord";

export type ReportStatusKind =
  | "unreviewed_in_queue"
  | "not_reviewed_no_review_configured"
  | "approved"
  | "approved_with_conditions"
  | "changes_requested"
  | "rejected"
  | "incomplete";

export interface ReportStatus {
  kind: ReportStatusKind;
  /** True when `decidedVia === "multi_reviewer_owner_override"` — combined with `kind` for display (e.g. "Owner override — Approved"), never a separate kind of its own (an override still has a real, meaningful underlying status). */
  isOwnerOverride: boolean;
  /** Populated only when `kind === "approved_with_conditions"` — shown verbatim, per Constraint #2's "must be unmistakable", never summarized or omitted. */
  conditions?: string[];
}

/** Display labels — the ONLY place these strings are written, so the top summary bar, export, and any future consumer never drift. */
export const REPORT_STATUS_LABELS: Record<ReportStatusKind, string> = {
  unreviewed_in_queue: "Unreviewed — in queue",
  not_reviewed_no_review_configured: "Not reviewed — no review configured",
  approved: "Reviewed and approved",
  approved_with_conditions: "Reviewed with conditions",
  changes_requested: "Changes requested",
  rejected: "Rejected",
  incomplete: "Incomplete",
};

export interface ReportStatusInput {
  /** Compact human-review state, exactly as returned by /api/run-panel or /api/user/runs/[runId] (see each route's own doc comment). Absent/null when no GovernanceRecordV1 exists for this run yet. */
  humanReview?: {
    status: GovernanceRecordV1["humanReview"]["status"];
    conditions?: string[];
    decidedVia?: GovernanceRecordV1["humanReview"]["decidedVia"];
  } | null;
  /** "in_queue"/"not_configured" only meaningful when humanReview.status is "unreviewed" — ignored otherwise. "unknown" (e.g. on history reload, which never re-derives routing) degrades to a plain "Unreviewed" label with no queue/configuration claim. */
  reviewRouting?: "in_queue" | "not_configured" | "unknown";
  /** Whether the adaptiveOutput envelope itself was durably saved — "Incomplete" independent of humanReview, since governance is never initialized when this isn't "saved". */
  persistenceStatus?: "saved" | "failed" | "omitted_size_limit" | "not_applicable";
}

/**
 * Never throws, never returns undefined — every input combination maps to
 * a real status, including the "nothing computed yet" case (treated as
 * Incomplete, not a crash or a silent omission).
 */
export function deriveReportStatus(input: ReportStatusInput): ReportStatus {
  if (input.persistenceStatus === "failed" || input.persistenceStatus === "omitted_size_limit") {
    return { kind: "incomplete", isOwnerOverride: false };
  }

  const hr = input.humanReview;
  if (!hr) {
    return { kind: "incomplete", isOwnerOverride: false };
  }

  const isOwnerOverride = hr.decidedVia === "multi_reviewer_owner_override";

  switch (hr.status) {
    case "approved":
      return { kind: "approved", isOwnerOverride };
    case "approved_with_conditions":
      return { kind: "approved_with_conditions", isOwnerOverride, conditions: hr.conditions ?? [] };
    case "changes_requested":
      return { kind: "changes_requested", isOwnerOverride };
    case "rejected":
      return { kind: "rejected", isOwnerOverride };
    case "unreviewed":
    case "pending":
      // "pending" is defined in GovernanceRecordV1 but, confirmed by code
      // search, never actually set by any write site today — treated
      // identically to "unreviewed" so this function stays correct if that
      // ever changes, without silently mis-labeling it as Incomplete.
      //
      // reviewRouting is a real, resolved lookup in both callers (live run:
      // derived from the projection-creation attempt; reload: a fresh
      // getAdaptiveTeamRunProjection() check) — "unknown" only occurs on a
      // genuine lookup failure, not as a routine placeholder. Fails toward
      // "in_queue" in that rare case (fail closed toward "needs attention"
      // — a real pending review must never silently read as fully settled).
      return input.reviewRouting === "not_configured"
        ? { kind: "not_reviewed_no_review_configured", isOwnerOverride }
        : { kind: "unreviewed_in_queue", isOwnerOverride };
    default:
      return { kind: "incomplete", isOwnerOverride: false };
  }
}
