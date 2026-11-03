/**
 * Order B, Stage B2 (owner-authorized 2026-11-03): the ONE decision contract for Report Review, shared by the server
 * decision transaction (lib/workspaces/reportReviewDecisionMutation.ts) and the read context the UI renders from
 * (GET …/report-review). The server is authoritative; the UI only displays what this function returns.
 *
 * A decision requires ALL of:
 *   - the caller is an active member of THIS Workspace with the ordinary review capabilities
 *     (`isOrdinaryReviewerAuthorized`: research.read + reviews.submit, same Workspace, not the run creator);
 *   - the caller holds the CURRENT canonical assignment for the CURRENT cycle;
 *   - the caller is NOT the report-review submitter (owner B2 requirement; closes the B1 carry-over gap);
 *   - the cycle is open (unreviewed | pending).
 * Pure: no I/O.
 */

import { isOrdinaryReviewerAuthorized, type WorkspaceReviewCandidate } from "@/lib/workspaces/workspaceReviewEligibility";
import type { ReportReviewRecordV1, ReportReviewStatus } from "./reportReview";

export const REPORT_REVIEW_DECISION_STATUSES = Object.freeze(["approved", "approved_with_conditions", "changes_requested", "rejected"] as const);
export type ReportReviewDecisionStatus = (typeof REPORT_REVIEW_DECISION_STATUSES)[number];

export const MAX_DECISION_COMMENT_CHARS = 2000;
export const MAX_DECISION_CONDITIONS = 10;
export const MAX_DECISION_CONDITION_CHARS = 500;

export type DecisionUpdate = { status: ReportReviewDecisionStatus; comment: string | null; conditions: string[] | null };
export type DecisionUpdateValidation = { ok: true; update: DecisionUpdate } | { ok: false; reason: "invalid_decision" | "conditions_required" };

/** Exactly `{ status, comment?, conditions? }`. Conditions are required for, and only kept with, approved_with_conditions. */
export function validateDecisionUpdate(raw: unknown): DecisionUpdateValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "invalid_decision" };
  const r = raw as Record<string, unknown>;
  if (!Object.keys(r).every((k) => k === "status" || k === "comment" || k === "conditions")) return { ok: false, reason: "invalid_decision" };
  if (typeof r.status !== "string" || !(REPORT_REVIEW_DECISION_STATUSES as readonly string[]).includes(r.status)) return { ok: false, reason: "invalid_decision" };
  const status = r.status as ReportReviewDecisionStatus;
  let comment: string | null = null;
  if (r.comment !== undefined && r.comment !== null) {
    if (typeof r.comment !== "string") return { ok: false, reason: "invalid_decision" };
    const t = r.comment.trim();
    if (Array.from(t).length > MAX_DECISION_COMMENT_CHARS) return { ok: false, reason: "invalid_decision" };
    comment = t.length > 0 ? t : null;
  }
  let conditions: string[] | null = null;
  if (r.conditions !== undefined && r.conditions !== null) {
    if (!Array.isArray(r.conditions) || r.conditions.length > MAX_DECISION_CONDITIONS) return { ok: false, reason: "invalid_decision" };
    const cleaned: string[] = [];
    for (const c of r.conditions) {
      if (typeof c !== "string") return { ok: false, reason: "invalid_decision" };
      const t = c.trim();
      if (t.length === 0 || Array.from(t).length > MAX_DECISION_CONDITION_CHARS) return { ok: false, reason: "invalid_decision" };
      cleaned.push(t);
    }
    conditions = cleaned;
  }
  if (status === "approved_with_conditions") {
    if (!conditions || conditions.length === 0) return { ok: false, reason: "conditions_required" };
  } else {
    conditions = null; // never kept on any other status
  }
  return { ok: true, update: { status, comment, conditions } };
}

export type ReportReviewDecisionDenial =
  | "not_open" // the cycle is already decided
  | "not_assigned" // the caller does not hold the current canonical assignment
  | "stale_assignment" // the assignment belongs to an earlier cycle
  | "submitter" // the caller submitted this report review
  | "self_review" // the caller created the run
  | "removed"
  | "cross_workspace"
  | "not_found"
  | "insufficient_capability";

export type ReportReviewDecisionAuthority = { authorized: true } | { authorized: false; reason: ReportReviewDecisionDenial };

const OPEN: ReadonlySet<ReportReviewStatus> = new Set<ReportReviewStatus>(["unreviewed", "pending"]);

export function evaluateReportReviewDecisionAuthority(args: {
  reviewer: WorkspaceReviewCandidate | null;
  workspaceId: string;
  creatorUid: string;
  record: ReportReviewRecordV1;
  /** humanReviewAssignment/current as read, or null. */
  assignment: { assignedReviewerUserId?: unknown; cycle?: unknown } | null;
}): ReportReviewDecisionAuthority {
  if (!OPEN.has(args.record.humanReview.status)) return { authorized: false, reason: "not_open" };
  const uid = args.reviewer?.uid ?? null;
  const assigned = uid !== null && args.assignment?.assignedReviewerUserId === uid;
  // An assignment tagged for another cycle is not current. (Untagged = written by an ordinary assignment mutation, which
  // can only happen after the latest cycle reset, so it is current.)
  if (assigned && args.assignment?.cycle !== undefined && args.assignment.cycle !== args.record.cycle) return { authorized: false, reason: "stale_assignment" };
  const base = isOrdinaryReviewerAuthorized({ reviewer: args.reviewer, runWorkspaceId: args.workspaceId, creatorUid: args.creatorUid, hasCanonicalAssignment: assigned });
  if (!base.authorized) return { authorized: false, reason: base.reason as ReportReviewDecisionDenial };
  if (uid === args.record.submittedByUserId) return { authorized: false, reason: "submitter" };
  return { authorized: true };
}
