/**
 * Project/Research Assignment (D8) — READ-ONLY, Project-Assignment-owned
 * presentation helper that reports which uids are currently reviewers of a
 * run, so the run-assignee picker can show a NON-BLOCKING warning when the
 * chosen assignee is also a reviewer.
 *
 * Frozen constraints:
 *   - Independent of Approval Workflow admission (`APPROVAL_WORKFLOW_ENABLED`
 *     gates the review routes; assignment has its own rollout axis). This
 *     helper is reached through the assignment read route only.
 *   - Inspects `runs/{runId}/humanReviewAssignment/current` and
 *     `runs/{runId}/humanReviewPanel/current` structurally, never through
 *     the review parsers, never mutating them, never changing eligibility
 *     semantics or the review state machine. The review documents are
 *     treated as opaque presentation input.
 *   - Never throws; any read failure or malformed document yields `[]`
 *     (no warning), never an error surfaced to the caller.
 *   - Reports uids only; the route resolves names through the
 *     membership-evidenced resolver like every other surface.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";

export async function readRunReviewerUidsForAssignmentWarning(runId: string): Promise<string[]> {
  if (!adminDb) return [];
  try {
    const runRef = adminDb.collection("runs").doc(runId);
    const [assignmentSnap, panelSnap] = await adminDb.getAll(runRef.collection("humanReviewAssignment").doc("current"), runRef.collection("humanReviewPanel").doc("current"));
    const uids = new Set<string>();

    const assignment = assignmentSnap.exists ? (assignmentSnap.data() as Record<string, unknown> | undefined) : undefined;
    const assigned = assignment?.assignedReviewerUserId;
    if (typeof assigned === "string" && assigned.length > 0) uids.add(assigned);

    const panel = panelSnap.exists ? (panelSnap.data() as Record<string, unknown> | undefined) : undefined;
    if (panel?.status === "open" && Array.isArray(panel.reviewerUserIds)) {
      for (const entry of panel.reviewerUserIds) {
        if (typeof entry === "string" && entry.length > 0) uids.add(entry);
      }
    }
    return Array.from(uids).sort();
  } catch {
    return [];
  }
}
