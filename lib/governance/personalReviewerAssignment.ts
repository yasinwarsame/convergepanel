/**
 * Reviewer Assignment Propagation — the ONLY trigger that automatically
 * creates a Milestone-2 `humanReviewAssignment/current` for a run whose
 * owner has NO team.
 *
 * Milestone-2's existing single-reviewer assignment is structurally
 * team-only: the sole mutation route
 * (app/api/teams/adaptive-runs/[runId]/assignment/route.ts) requires team
 * membership and a `teamRuns` projection to exist first. A personal
 * (non-team) account has no equivalent path — regardless of any reviewer
 * configuration, `humanReviewAssignment/current` could never be created
 * for their runs before this module existed.
 *
 * Separately, personal accounts have their OWN, pre-existing, unrelated
 * reviewer-configuration concept ("System C" — a self-service peer-to-peer
 * relationship on `users/{uid}`: `governanceReviewerUid`/
 * `governanceReviewerEmail`/`governanceReviewerEnabled`, written by
 * app/api/governance/reviewer/route.ts). That relationship was built for,
 * and only ever consumed by, the LEGACY governance queue
 * (app/api/governance/queue/route.ts), which filters on the legacy
 * `governanceStatus` field — a field Milestone-2 adaptive runs never set.
 * So a personal account's adaptive-schema runs were invisible to BOTH
 * systems at once: not team-scoped (Milestone-2 unreachable) and not
 * legacy-flagged (System C's queue never matches).
 *
 * This module is the bridge: it reads the ALREADY-CONFIGURED System C
 * relationship and feeds it into Milestone-2's EXISTING, already-tested
 * assignment primitive (`submitAdaptiveHumanReviewAssignment`) — reusing
 * that transaction verbatim (same optimistic-concurrency check, same
 * `isHumanReviewStatusReviewable` terminal-state guard, same audit/history
 * writes) rather than reimplementing any of it. Never touches team runs —
 * the caller only reaches this module when `loadUserAndTeam(uid).team` is
 * absent.
 */

import { logger } from "@/lib/logger";
import { adminDb } from "@/lib/firebase/admin";
import {
  submitAdaptiveHumanReviewAssignment,
  createAdaptiveHumanReviewAssignmentHistory,
} from "@/lib/firestore/runs";
import { buildAdaptiveHumanReviewAssignmentHistoryEntry } from "@/lib/governance/adaptiveHumanReviewAssignment";
import { writeAdaptiveAssignmentAdminAuditEvent } from "@/lib/governance/auditLog";

/**
 * Pure. "Reviewer configured" means the OWNER's own doc names a reviewer —
 * never merely that some other account has `governanceReviewerEnabled`
 * (reviewer-capable). A reviewer-capable member must never, by itself,
 * cause an assignment; only a real, existing assigner→reviewer
 * relationship does. Mirrors app/api/governance/reviewer/route.ts GET's
 * own `hasAssigned` check exactly, so the two never drift.
 */
export function ownerConfiguredReviewerUid(ownerProfile: Record<string, unknown> | undefined | null): string | null {
  const uid = ownerProfile?.governanceReviewerUid;
  const email = ownerProfile?.governanceReviewerEmail;
  if (typeof uid === "string" && uid.trim().length > 0 && typeof email === "string" && email.trim().length > 0) {
    return uid.trim();
  }
  return null;
}

/**
 * Pure. Re-validates the CONFIGURED reviewer's own availability flag at
 * the moment of automatic assignment — the same flag
 * app/api/governance/reviewer/route.ts's `assign_reviewer` action required
 * to be true when the relationship was first created. A reviewer who has
 * since turned availability off must not receive further automatic
 * assignments, even though the assigner's own configuration still names
 * them (removing the relationship entirely is a separate, explicit
 * assigner action via `remove_reviewer` — this only guards the reviewer's
 * own opt-out of NEW automatic work).
 */
export function reviewerStillAvailable(reviewerProfile: Record<string, unknown> | undefined | null): boolean {
  return reviewerProfile?.governanceReviewerEnabled === true;
}

export type PropagatePersonalReviewerAssignmentResult =
  | { status: "assigned"; reviewerUserId: string }
  | { status: "not_configured" }
  | { status: "reviewer_unavailable" }
  | { status: "already_assigned" }
  | { status: "not_pending" }
  | { status: "failed" };

/**
 * Defense-in-depth: app/api/governance/reviewer/route.ts's own
 * `assign_reviewer` action already refuses to let a user configure
 * themselves as their own reviewer, so `ownerUserId === reviewerUserId`
 * should be structurally impossible in a real, API-written config. This
 * check exists anyway — cheap, and it means a data anomaly (a stale/
 * tampered doc, a future config-writing bug) can never silently produce a
 * "reviewed by yourself" assignment, rather than trusting that upstream
 * validation forever holds.
 */
function isSelfAssignment(ownerUserId: string, reviewerUserId: string): boolean {
  return ownerUserId === reviewerUserId;
}

/**
 * Never throws. Called at most once per run, only immediately after a
 * FRESH governance-record creation (the caller gates on
 * `initResult.status === "created"`) — never on "already_exists" or a
 * terminal state, so this can never reinitialize or reassign a decided
 * review. Idempotent even if triggered twice anyway:
 * `submitAdaptiveHumanReviewAssignment`'s own transaction re-reads the
 * assignment document fresh and uses `expectedRevision: 0`, so a second
 * concurrent/duplicate call safely no-ops with `stale_revision` (surfaced
 * here as "already_assigned") rather than creating a duplicate or
 * overwriting a real assignment — the exact same guarantee a manual team
 * assignment gets, not a bespoke one.
 */
export async function propagatePersonalReviewerAssignment(args: {
  runId: string;
  ownerUserId: string;
}): Promise<PropagatePersonalReviewerAssignmentResult> {
  if (!adminDb) return { status: "failed" };

  try {
    const ownerSnap = await adminDb.collection("users").doc(args.ownerUserId).get();
    const reviewerUserId = ownerConfiguredReviewerUid(ownerSnap.data());
    if (!reviewerUserId) {
      return { status: "not_configured" };
    }
    if (isSelfAssignment(args.ownerUserId, reviewerUserId)) {
      logger.warn("[personalReviewerAssignment] Refusing a self-assignment data anomaly (should be unreachable via the normal config route)", {
        runId: args.runId,
      });
      return { status: "not_configured" };
    }

    const reviewerSnap = await adminDb.collection("users").doc(reviewerUserId).get();
    if (!reviewerStillAvailable(reviewerSnap.data())) {
      return { status: "reviewer_unavailable" };
    }

    const now = new Date().toISOString();
    const submitResult = await submitAdaptiveHumanReviewAssignment({
      runId: args.runId,
      teamId: null,
      newReviewerUserId: reviewerUserId,
      // Attributed to the run owner, not a fabricated "system" identity —
      // the owner is the one who configured this relationship in the
      // first place (via the self-service assign_reviewer action); this
      // per-run propagation is a direct, traceable consequence of their
      // own standing configuration.
      actorUserId: args.ownerUserId,
      expectedRevision: 0,
      now,
    });

    if (!submitResult.ok) {
      if (submitResult.reason === "stale_revision") {
        return { status: "already_assigned" };
      }
      if (submitResult.reason === "not_pending") {
        return { status: "not_pending" };
      }
      logger.warn("[personalReviewerAssignment] Automatic assignment submit failed", {
        runId: args.runId,
        reason: submitResult.reason,
      });
      return { status: "failed" };
    }

    const { assignment, previousReviewerUserId } = submitResult;

    try {
      const historyEntry = buildAdaptiveHumanReviewAssignmentHistoryEntry({
        teamId: null,
        runId: args.runId,
        previousReviewerUserId,
        newReviewerUserId: assignment.assignedReviewerUserId,
        assignmentRevision: assignment.revision,
        changedAt: assignment.updatedAt,
        changedByUserId: args.ownerUserId,
      });
      const historyResult = await createAdaptiveHumanReviewAssignmentHistory(args.runId, historyEntry);
      if (historyResult.status === "failed") {
        logger.warn("[personalReviewerAssignment] Assignment-history write did not save after a successful canonical assignment", {
          runId: args.runId,
        });
      }
    } catch {
      logger.warn("[personalReviewerAssignment] Assignment-history write threw after a successful canonical assignment", {
        runId: args.runId,
      });
    }

    try {
      const auditResult = await writeAdaptiveAssignmentAdminAuditEvent({
        action: "adaptive_human_review_reviewer_assigned",
        actorUid: args.ownerUserId,
        teamId: null,
        runId: args.runId,
        previousReviewerUserId,
        newReviewerUserId: assignment.assignedReviewerUserId,
        assignmentRevision: assignment.revision,
        at: assignment.updatedAt,
      });
      if (auditResult.status === "failed") {
        logger.warn("[personalReviewerAssignment] Admin audit write did not save after a successful canonical assignment", {
          runId: args.runId,
        });
      }
    } catch {
      logger.warn("[personalReviewerAssignment] Admin audit write threw after a successful canonical assignment", {
        runId: args.runId,
      });
    }

    return { status: "assigned", reviewerUserId };
  } catch {
    logger.warn("[personalReviewerAssignment] Unexpected error during automatic propagation", { runId: args.runId });
    return { status: "failed" };
  }
}
