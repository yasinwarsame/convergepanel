import "server-only";
import type { WorkspaceCapability } from "./capabilities";
import type { GetAdaptiveHumanReviewAssignmentResult } from "@/lib/firestore/runs";
import { parseGovernanceRecord, isHumanReviewStatusReviewable } from "@/lib/adaptiveSchema/governanceRecordParser";

/**
 * Team Research Parity, Phase R1 — the Team viewer-role derivation extracted
 * verbatim from `GET /api/user/runs/[runId]` (Phase 8C-B3.1) so both Team
 * research reads agree on it.
 *
 * THIS IS NOT AUTHORIZATION. The caller must already hold a granted Team
 * Workspace access result whose capabilities include `research.read`; this
 * function only refines an already-authorized reader into `team_member` or
 * `team_reviewer`. It never grants access: assignment alone, the run
 * creator's identity, and a membership role literally named "reviewer" all
 * yield nothing here.
 *
 * `team_reviewer` ONLY when ALL of the following hold, mirroring (never
 * modifying) `resolveAdaptiveRunAccess()`'s own reviewable-state predicate:
 *   - the Workspace `reviews.submit` capability;
 *   - a canonical per-run assignment naming this uid;
 *   - a currently-reviewable human-review status on the run's governance record.
 * Any one condition missing yields `team_member`, never a partial role.
 */
export type TeamRunViewerRole = "team_member" | "team_reviewer";

export function deriveTeamRunViewerRole(args: {
  uid: string;
  capabilities: readonly WorkspaceCapability[];
  assignmentResult: GetAdaptiveHumanReviewAssignmentResult;
  governanceRecord: unknown;
}): TeamRunViewerRole {
  const isAssignedReviewer = args.assignmentResult.status === "found" && args.assignmentResult.assignment.assignedReviewerUserId === args.uid;
  const hasReviewsSubmit = args.capabilities.includes("reviews.submit");
  const parsed = parseGovernanceRecord(args.governanceRecord);
  const humanReviewStatus = parsed.ok ? parsed.record.humanReview.status : null;
  const isReviewableState = humanReviewStatus !== null && isHumanReviewStatusReviewable(humanReviewStatus);
  return isAssignedReviewer && hasReviewsSubmit && isReviewableState ? "team_reviewer" : "team_member";
}
