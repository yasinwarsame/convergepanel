/**
 * Part E3 — internal, idempotent repair service for the secondary
 * artifacts of the CURRENT adaptive human-review assignment
 * (docs/governance-decision-receipts-design.md §28.12). Not exposed via
 * any route or UI button in this step. Never modifies the current
 * assignment, never changes review status, never reopens a review, never
 * changes a decision, and never generates a duplicate artifact (both
 * underlying writers are already create-only/idempotent).
 *
 * HONEST, DOCUMENTED LIMITATION: the current assignment document
 * (`runs/{runId}/humanReviewAssignment/current`) stores only the CURRENT
 * `assignedReviewerUserId` — it does not retain the reviewer that was
 * assigned immediately before the current one. For `revision === 1`, the
 * prior state is PROVABLE (a run can only ever reach revision 1 by going
 * from unassigned, so `previousReviewerUserId` is definitely `null`). For
 * `revision > 1`, the true previous reviewer is genuinely NOT
 * reconstructible from the current document alone — this function refuses
 * to guess it, and reports `"cannot_reconstruct"` rather than fabricating
 * a historical event, per instruction.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { getAdaptiveHumanReviewAssignment, createAdaptiveHumanReviewAssignmentHistory } from "@/lib/firestore/runs";
import { writeAdaptiveAssignmentAdminAuditEvent, AdaptiveAssignmentAdminAuditAction } from "@/lib/governance/auditLog";
import { buildAdaptiveHumanReviewAssignmentHistoryEntry, classifyAssignmentEventType } from "@/lib/governance/adaptiveHumanReviewAssignment";

const EVENT_TYPE_TO_ADMIN_AUDIT_ACTION: Record<string, AdaptiveAssignmentAdminAuditAction> = {
  assigned: "adaptive_human_review_reviewer_assigned",
  reassigned: "adaptive_human_review_reviewer_reassigned",
  unassigned: "adaptive_human_review_reviewer_unassigned",
};

export type RepairAdaptiveHumanReviewAssignmentArtifactsResult =
  | { status: "no_assignment" }
  | { status: "cannot_reconstruct"; reason: "previous_reviewer_unknown_for_revision_greater_than_one"; revision: number }
  | { status: "repaired" | "already_complete"; historyStatus: "recorded" | "already_exists" | "failed"; auditStatus: "recorded" | "already_exists" | "failed" }
  | { status: "firestore_unavailable" };

export async function repairAdaptiveHumanReviewAssignmentArtifacts(runId: string): Promise<RepairAdaptiveHumanReviewAssignmentArtifactsResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  const assignmentResult = await getAdaptiveHumanReviewAssignment(runId);
  if (assignmentResult.status === "firestore_unavailable" || assignmentResult.status === "read_failed") {
    return { status: "firestore_unavailable" };
  }
  if (assignmentResult.status === "unassigned") {
    return { status: "no_assignment" };
  }

  const assignment = assignmentResult.assignment;

  let previousReviewerUserId: string | null;
  if (assignment.revision === 1) {
    previousReviewerUserId = null; // provable — see module doc.
  } else {
    logger.warn("[adaptiveHumanReviewAssignmentRepair] Cannot reconstruct previousReviewerUserId for a revision > 1", { runId, revision: assignment.revision });
    return { status: "cannot_reconstruct", reason: "previous_reviewer_unknown_for_revision_greater_than_one", revision: assignment.revision };
  }

  const eventType = classifyAssignmentEventType(previousReviewerUserId, assignment.assignedReviewerUserId);

  const historyEntry = buildAdaptiveHumanReviewAssignmentHistoryEntry({
    teamId: assignment.teamId,
    runId: assignment.runId,
    previousReviewerUserId,
    newReviewerUserId: assignment.assignedReviewerUserId,
    assignmentRevision: assignment.revision,
    changedAt: assignment.updatedAt,
    changedByUserId: assignment.updatedByUserId,
  });
  const historyResult = await createAdaptiveHumanReviewAssignmentHistory(runId, historyEntry);

  const auditResult = await writeAdaptiveAssignmentAdminAuditEvent({
    action: EVENT_TYPE_TO_ADMIN_AUDIT_ACTION[eventType],
    actorUid: assignment.updatedByUserId,
    teamId: assignment.teamId,
    runId: assignment.runId,
    previousReviewerUserId,
    newReviewerUserId: assignment.assignedReviewerUserId,
    assignmentRevision: assignment.revision,
    at: assignment.updatedAt,
  });

  const bothAlreadyComplete = historyResult.status === "already_exists" && auditResult.status === "already_exists";

  return {
    status: bothAlreadyComplete ? "already_complete" : "repaired",
    historyStatus: historyResult.status,
    auditStatus: auditResult.status,
  };
}
