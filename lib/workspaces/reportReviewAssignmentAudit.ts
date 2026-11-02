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
 *   - an unreadable report-review record fails the assignment closed (no change without its audit).
 */
import { parseReportReviewRecord } from "@/lib/governance/reportReview";
import { REPORT_REVIEW_EVENTS_COLLECTION } from "./reportReviewCollections";

export type ReportReviewAssignmentContext = { kind: "not_report_review" } | { kind: "report_review"; cycle: number; submitterUid: string } | { kind: "malformed" };

export function reportReviewAssignmentContext(runData: Record<string, unknown>): ReportReviewAssignmentContext {
  if (runData.reportReview === undefined || runData.reportReview === null) return { kind: "not_report_review" };
  const parsed = parseReportReviewRecord(runData.reportReview);
  if (!parsed.ok) return { kind: "malformed" };
  return { kind: "report_review", cycle: parsed.record.cycle, submitterUid: parsed.record.submittedByUserId };
}

export function writeReportReviewAssignmentEvent(
  tx: FirebaseFirestore.Transaction,
  runRef: FirebaseFirestore.DocumentReference,
  args: { runId: string; workspaceId: string; projectId: string | null; actorUid: string; cycle: number; previousReviewerUserId: string | null; newReviewerUserId: string | null; revision: number; at: string }
): void {
  tx.create(runRef.collection(REPORT_REVIEW_EVENTS_COLLECTION).doc(), { version: 1, type: "report_review_assignment_changed", ...args });
}
