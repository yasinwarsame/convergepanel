/**
 * Part E3 — Single-Reviewer Assignment for Adaptive Human Review. Pure
 * model, eligibility, and identity helpers. No I/O.
 *
 * STORAGE MODEL (chosen after auditing the repository, documented in full
 * in docs/governance-decision-receipts-design.md §28): a SEPARATE document
 * at `runs/{runId}/humanReviewAssignment/current` — a fixed, single
 * document ID, never nested inside `governanceRecord` and never a second
 * field on `humanReview`. `governanceRecord.humanReview` remains the only
 * canonical review-DECISION state; this document is a genuinely separate
 * concern (who is assigned to decide, not what was decided). A missing
 * document means unassigned — no migration is required, and every
 * existing run without this document behaves exactly as it did before
 * this step.
 */

/** `owner`|`admin` — the ONLY two roles that can currently pass `isTeamAdmin()` and therefore submit a decision at all (Part D). An eligible reviewer MUST be drawn from this set: assigning a plain "member" would create an assignment that could never actually be fulfilled, since `isTeamAdmin()` would still reject them at submission time (assignment never grants permission — §E3 objective). */
export type EligibleReviewerTeamRole = "owner" | "admin";

export const ELIGIBLE_REVIEWER_ROLES: ReadonlySet<string> = new Set<EligibleReviewerTeamRole>(["owner", "admin"]);

/**
 * The administrative OVERRIDE permission for submitting a decision on a run
 * assigned to someone else (§E3 objective 6) — chosen as team **owner**
 * specifically, not the broader `isTeamAdmin()` (owner|admin) tier already
 * used for assignment mutation and baseline submission. Reusing the
 * broader tier here would make assignment meaningless on any team with
 * more than one admin (any admin could always bypass by submitting
 * directly) — `owner` is the one already-existing, already-more-privileged
 * role this codebase distinguishes elsewhere (e.g. "owner cannot be
 * removed" in `app/api/teams/members/route.ts`), so this reuses an
 * existing distinction rather than inventing a new permission concept.
 */
export function hasAdaptiveReviewSubmissionOverride(role: string | null): boolean {
  return role === "owner";
}

// ============================================
// Canonical assignment document
// ============================================

export type AdaptiveHumanReviewAssignmentV1 = {
  schemaVersion: 1;
  /** `null` for a personal (non-team) run's assignment — see personalReviewerAssignment.ts. Never used for authorization anywhere (that's always the separate teamRuns projection's own teamId) — purely descriptive/audit metadata. */
  teamId: string | null;
  runId: string;

  assignedReviewerUserId: string | null;

  assignedAt: string | null;
  assignedByUserId: string | null;

  updatedAt: string;
  updatedByUserId: string;

  revision: number;
};

/** The event that actually occurred, derived from the before/after assignee — never trusted from the client. */
export type AdaptiveHumanReviewAssignmentEventType = "assigned" | "reassigned" | "unassigned";

export function classifyAssignmentEventType(
  previousReviewerUserId: string | null,
  newReviewerUserId: string | null
): AdaptiveHumanReviewAssignmentEventType {
  if (newReviewerUserId === null) return "unassigned";
  if (previousReviewerUserId === null) return "assigned";
  return "reassigned";
}

/**
 * Builds the next canonical assignment document. Pure — the caller
 * (the route, inside a transaction) is responsible for having already
 * validated eligibility, revision, and pending-review state.
 */
export function buildNextAdaptiveHumanReviewAssignment(args: {
  teamId: string | null;
  runId: string;
  newReviewerUserId: string | null;
  actorUserId: string;
  now: string;
  currentRevision: number;
  /** Preserved from the current document unless this mutation itself sets a new assignee. */
  currentAssignedAt: string | null;
  currentAssignedByUserId: string | null;
}): AdaptiveHumanReviewAssignmentV1 {
  const isAssigning = args.newReviewerUserId !== null;
  return {
    schemaVersion: 1,
    teamId: args.teamId,
    runId: args.runId,
    assignedReviewerUserId: args.newReviewerUserId,
    assignedAt: isAssigning ? args.now : null,
    assignedByUserId: isAssigning ? args.actorUserId : null,
    updatedAt: args.now,
    updatedByUserId: args.actorUserId,
    revision: args.currentRevision + 1,
  };
}

// ============================================
// Immutable assignment-history record
// ============================================

/**
 * Metadata only — never a reviewer name, email, comment, prompt, evidence,
 * model output, or decision content. `eventId` is always `String(assignmentRevision)`
 * — deterministic (the new document's own `revision` is a strictly
 * incrementing integer per run, guaranteed unique per mutation by the
 * optimistic-concurrency check that produced it), needing no hash.
 */
export type AdaptiveHumanReviewAssignmentHistoryV1 = {
  schemaVersion: 1;
  eventId: string;
  teamId: string | null;
  runId: string;
  eventType: AdaptiveHumanReviewAssignmentEventType;
  previousReviewerUserId: string | null;
  newReviewerUserId: string | null;
  assignmentRevision: number;
  changedAt: string;
  changedByUserId: string;
};

export function buildAdaptiveHumanReviewAssignmentHistoryEntry(args: {
  teamId: string | null;
  runId: string;
  previousReviewerUserId: string | null;
  newReviewerUserId: string | null;
  assignmentRevision: number;
  changedAt: string;
  changedByUserId: string;
}): AdaptiveHumanReviewAssignmentHistoryV1 {
  return {
    schemaVersion: 1,
    eventId: String(args.assignmentRevision),
    teamId: args.teamId,
    runId: args.runId,
    eventType: classifyAssignmentEventType(args.previousReviewerUserId, args.newReviewerUserId),
    previousReviewerUserId: args.previousReviewerUserId,
    newReviewerUserId: args.newReviewerUserId,
    assignmentRevision: args.assignmentRevision,
    changedAt: args.changedAt,
    changedByUserId: args.changedByUserId,
  };
}
