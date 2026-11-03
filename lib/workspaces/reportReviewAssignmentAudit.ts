/**
 * Order B, Stage B2 — durable audit for reviewer-assignment changes on REPORT-REVIEW runs, and the submitter guard.
 *
 * Called from inside the existing assignment transactions (putWorkspaceReviewAssignment / deleteWorkspaceReviewAssignment)
 * only. For a run WITHOUT `reportReview` (every governed run) it returns `{ kind: "not_report_review" }` and the caller
 * writes nothing new — governed assignment behaviour is unchanged.
 *
 * For a report-review run:
 *   - the submitter can never be assigned as its reviewer (they could never decide; owner B2 requirement);
 *   - each change writes one write-once event (`report_review_assignment_changed`) in the SAME transaction, so the
 *     audit evidence is as durable as the assignment itself;
 *   - B3: the same change also writes one Workspace Audit Log row (`workspace_report_review_reviewer_changed`) in the
 *     SAME transaction, so assignment, removal and reassignment are visible to Workspace auditors;
 *   - an unreadable report-review record fails the assignment closed (no change without its audit).
 */
import { parseReportReviewRecord } from "@/lib/governance/reportReview";
import { REPORT_REVIEW_EVENTS_COLLECTION } from "./reportReviewCollections";
import { isReportReviewEnabledForWorkspace } from "./reportReviewActivation";
import { runQuestionSnapshot, writeReportReviewWorkspaceAuditEvent } from "./reportReviewWorkspaceAudit";

export type ReportReviewAssignmentContext = { kind: "not_report_review" } | { kind: "report_review"; cycle: number; submitterUid: string; runQuestion: string | null } | { kind: "malformed" };

export function reportReviewAssignmentContext(runData: Record<string, unknown>): ReportReviewAssignmentContext {
  // Dormant unless Report Review is active for THIS run's own Workspace (Order B allow-list): elsewhere assignment
  // behaviour is exactly as before B2, whatever the run carries. Callers have already verified the run's Workspace.
  if (!isReportReviewEnabledForWorkspace(runData.workspaceId)) return { kind: "not_report_review" };
  if (runData.reportReview === undefined || runData.reportReview === null) return { kind: "not_report_review" };
  // S1: a report-review run being deleted accepts no assignment change (fails closed like an unreadable record).
  if (runData.deletion !== undefined && runData.deletion !== null) return { kind: "malformed" };
  // A run carrying BOTH records violates the B1 invariant: fail closed, as the decision path and the queue do.
  if (runData.governanceRecord !== undefined && runData.governanceRecord !== null) return { kind: "malformed" };
  const parsed = parseReportReviewRecord(runData.reportReview);
  if (!parsed.ok) return { kind: "malformed" };
  return { kind: "report_review", cycle: parsed.record.cycle, submitterUid: parsed.record.submittedByUserId, runQuestion: runQuestionSnapshot(runData) };
}

export function writeReportReviewAssignmentEvent(
  tx: FirebaseFirestore.Transaction,
  runRef: FirebaseFirestore.DocumentReference,
  args: { runId: string; workspaceId: string; projectId: string | null; actorUid: string; cycle: number; previousReviewerUserId: string | null; newReviewerUserId: string | null; revision: number; at: string },
  runQuestion: string | null
): void {
  tx.create(runRef.collection(REPORT_REVIEW_EVENTS_COLLECTION).doc(), { version: 1, type: "report_review_assignment_changed", ...args });
  writeReportReviewWorkspaceAuditEvent(
    tx,
    {
      eventType: "workspace_report_review_reviewer_changed",
      actorUid: args.actorUid,
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      runId: args.runId,
      runQuestion,
      cycle: args.cycle,
      previousReviewerUid: args.previousReviewerUserId,
      reviewerUid: args.newReviewerUserId,
      revision: args.revision,
    },
    args.at
  );
}
