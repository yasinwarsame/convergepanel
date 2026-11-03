/**
 * Order B, Stage B3 — the ONLY writer of Report Review rows in the Workspace Audit Log (`workspaceMembershipEvents`).
 *
 * Durability: called only from inside the report-review mutation transactions (submit, resubmit, decide, and the
 * reviewer-assignment put/delete branch for report-review runs). It uses `tx.create()` on a fresh document, so the row
 * commits atomically with the mutation or not at all: no successful mutation without its audit row, and no audit row for
 * a mutation that did not commit. Idempotent retries write nothing because the mutations themselves write nothing on a
 * replay (submit `created: false`, decision `replayed: true`, resubmit `cycle_conflict`, assignment OCC `stale_revision`).
 *
 * Immutability: no code path updates or deletes these rows (pinned by reportReviewArchiveImmutability.spec.ts), and
 * firestore.rules denies every client read and write (catch-all `match /{document=**}`).
 *
 * Timestamps: `at` is the SAME instant as the mutation's own `now` (the record's `updatedAt` / `submittedAt` /
 * `reviewedAt`), never a second clock read. Workspace binding: `workspaceId` is the transaction-validated binding of the
 * run (`resolveWorkspaceReviewTarget`), never a request value.
 */
import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { buildWorkspaceMembershipEventDocData, type ReportReviewWorkspaceAuditArgs } from "./workspaceMembershipEvents";

export const WORKSPACE_AUDIT_COLLECTION = "workspaceMembershipEvents";

/** The run's question as stored, for the audit row's human-legible identity. Null when absent or blank (never invented). */
export function runQuestionSnapshot(run: Record<string, unknown>): string | null {
  const q = run.question;
  return typeof q === "string" && q.trim().length > 0 ? q : null;
}

export function writeReportReviewWorkspaceAuditEvent(tx: FirebaseFirestore.Transaction, event: ReportReviewWorkspaceAuditArgs, nowIso: string): void {
  const at = Timestamp.fromDate(new Date(nowIso));
  tx.create(adminDb!.collection(WORKSPACE_AUDIT_COLLECTION).doc(), buildWorkspaceMembershipEventDocData({ ...event, at }));
}
