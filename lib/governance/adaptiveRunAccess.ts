/**
 * Personal Reviewer Inbox + Action Flow — central, pure authorization
 * resolver for the two OWNER-only surfaces (GET /api/user/runs/[runId]
 * and its .../governance sibling) plus the new personal review/history/
 * decision surfaces this feature adds.
 *
 * Deliberately narrow in scope: this resolver knows about exactly two
 * roles that can reach these specific routes — the run OWNER, and a
 * PERSONAL (teamId: null) assigned reviewer. It has no concept of team
 * membership or team review roles at all — every team route
 * (app/api/teams/adaptive-runs/[runId]/*) keeps its own, separate,
 * already-established authorization (loadUserAndTeam + isTeamAdmin +
 * assignment match) entirely untouched. Merging the two authorization
 * models into one resolver would be exactly the mistake this feature's
 * own spec warns against ("do not merge team and personal authorization
 * accidentally") — so this module is intentionally blind to teams.
 *
 * Pure: takes already-fetched data (the caller does its own Firestore
 * reads), consistent with this codebase's established pattern
 * (buildReviewGovernanceViewModel, teamReviewQueueEnrichment.ts) of
 * keeping I/O at the route/caller layer and interpretation logic
 * independently testable without mocking Firestore.
 */

import { isHumanReviewStatusReviewable, HumanReviewStatus } from "../adaptiveSchema/governanceRecordParser";
import type { AdaptiveHumanReviewAssignmentV1 } from "./adaptiveHumanReviewAssignment";

export type AdaptiveRunAccessRole = "owner" | "personal_reviewer" | "unauthorized";

export interface AdaptiveRunAccessCapabilities {
  /** Read the full report (results, sources, evidence). */
  canViewReport: boolean;
  /** Read Review & Governance detail (assignment/status/decision). */
  canViewGovernance: boolean;
  /** Submit an approve/changes-requested/reject/approve-with-conditions decision right now. */
  canSubmitReview: boolean;
  /** Export the report (PDF/DOCX/JSON). Reviewers do not get this in v1 — least privilege, nothing in this feature's scope asks for it. */
  canExport: boolean;
  /** Delete/edit/rerun the run, change reviewer configuration, billing, ownership. Owner only, always false for a reviewer. */
  canMutateRun: boolean;
}

export type AdaptiveRunAccessResult =
  | { role: "owner"; capabilities: AdaptiveRunAccessCapabilities }
  | {
      role: "personal_reviewer";
      capabilities: AdaptiveRunAccessCapabilities;
      /** The canonical assignment that granted access — callers needing the reviewer's own uid/assignedAt can read it from here rather than re-deriving it. */
      assignment: AdaptiveHumanReviewAssignmentV1;
    }
  | { role: "unauthorized"; capabilities: AdaptiveRunAccessCapabilities };

const NO_ACCESS: AdaptiveRunAccessCapabilities = {
  canViewReport: false,
  canViewGovernance: false,
  canSubmitReview: false,
  canExport: false,
  canMutateRun: false,
};

/**
 * The ONLY thing that grants personal-reviewer access is the per-run
 * canonical assignment — never `users/{ownerUid}.governanceReviewerUid`
 * directly. This is deliberate (Part 4): the assignment is a frozen,
 * point-in-time record; the owner's *default* reviewer configuration can
 * change later without silently changing who has access to (or authored)
 * an already-existing review. See resolveAdaptiveRunAccess's own tests
 * for the "reviewer changed, old assignment stable" regression this
 * guarantees.
 */
export function resolveAdaptiveRunAccess(args: {
  uid: string;
  runOwnerUid: string;
  /** Already-fetched from runs/{runId}/humanReviewAssignment/current — null when no document exists. */
  assignment: AdaptiveHumanReviewAssignmentV1 | null;
  /** Already-parsed governanceRecord.humanReview.status — null when no governance record exists yet. */
  humanReviewStatus: HumanReviewStatus | null;
}): AdaptiveRunAccessResult {
  if (args.uid === args.runOwnerUid) {
    return {
      role: "owner",
      capabilities: {
        canViewReport: true,
        canViewGovernance: true,
        // Owners do not review their own reports — no self-review concept
        // exists anywhere in this codebase's governance model.
        canSubmitReview: false,
        canExport: true,
        canMutateRun: true,
      },
    };
  }

  const assignment = args.assignment;
  const isCurrentPersonalAssignee =
    assignment !== null &&
    assignment.teamId === null &&
    assignment.assignedReviewerUserId !== null &&
    assignment.assignedReviewerUserId === args.uid;

  if (!isCurrentPersonalAssignee) {
    return { role: "unauthorized", capabilities: NO_ACCESS };
  }

  const canSubmitReview = args.humanReviewStatus !== null && isHumanReviewStatusReviewable(args.humanReviewStatus);

  return {
    role: "personal_reviewer",
    assignment: assignment!,
    capabilities: {
      canViewReport: true,
      canViewGovernance: true,
      canSubmitReview,
      canExport: false,
      canMutateRun: false,
    },
  };
}
