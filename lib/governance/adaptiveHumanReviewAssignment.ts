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

/**
 * Phase 9B.2 — Workspace/Project DISCOVERY metadata for a Workspace-bound
 * Team run's assignment, and the reviewer's due date. `workspaceId`/
 * `projectId` are NEVER authority — the caller (inside the same
 * transaction) must always freshly re-derive them from the canonical
 * `runs/{runId}.workspaceId`/`runs/{runId}.projectId` before constructing
 * this bundle; this module never infers, guesses, or preserves them on its
 * own. `dueAt` is bundled together with them (rather than accepted as an
 * independent optional field) specifically so a reassignment can never
 * omit a due-date decision by accident — every call site that supplies
 * `workspaceMetadata` is forced by the type system to explicitly choose
 * `dueAt: null` (clear) or a value, never silently inherit whatever the
 * previous reviewer's deadline happened to be.
 */
export interface AdaptiveHumanReviewAssignmentWorkspaceMetadata {
  workspaceId: string;
  /** `null` = canonical Unfiled, mirroring `runs/{runId}.projectId`'s own convention. */
  projectId: string | null;
  /** `null` = no deadline set/cleared. Manager-controlled only — no reviewer self-extension exists at this layer or above it. */
  dueAt: string | null;
}

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

  /**
   * Phase 9B.2 — present if and only if this assignment belongs to a
   * WORKSPACE_BOUND_TEAM run (see `lib/workspaces/resolveWorkspaceReviewTarget.ts`).
   * Absent entirely for every legacy Team assignment and every Personal
   * assignment — no backfill, no migration; an existing Production
   * document with none of these three fields remains fully valid forever.
   * Discovery/projection only, never ownership authority — see this
   * module's own header comment and `AdaptiveHumanReviewAssignmentWorkspaceMetadata`'s
   * doc comment above.
   */
  workspaceId?: string;
  projectId?: string | null;
  dueAt?: string | null;
};

/** The event that actually occurred, derived from the before/after assignee — never trusted from the client. */
export type AdaptiveHumanReviewAssignmentEventType = "assigned" | "reassigned" | "unassigned" | "metadata_updated";

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
  /**
   * Phase 9B.2 — supplied only for a Workspace-bound assignment mutation
   * (create/reassign/unassign). Omit entirely for every legacy Team call
   * site — the resulting document then carries none of the three fields,
   * identical to today's behavior. When supplied, `dueAt` is ALWAYS the
   * caller's fresh, explicit decision for the new assignee — reassignment
   * never inherits the previous reviewer's deadline, because there is no
   * code path here that reads a "current dueAt" at all.
   */
  workspaceMetadata?: AdaptiveHumanReviewAssignmentWorkspaceMetadata;
}): AdaptiveHumanReviewAssignmentV1 {
  const isAssigning = args.newReviewerUserId !== null;
  const base: AdaptiveHumanReviewAssignmentV1 = {
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
  if (!args.workspaceMetadata) return base;
  return {
    ...base,
    workspaceId: args.workspaceMetadata.workspaceId,
    projectId: args.workspaceMetadata.projectId,
    dueAt: args.workspaceMetadata.dueAt,
  };
}

/**
 * Phase 9B.2 — pure builder for a SAME-REVIEWER assignment metadata/due-date
 * mutation: change or clear `dueAt`, or resync `workspaceId`/`projectId`,
 * WITHOUT touching who is assigned. Preserves `assignedReviewerUserId` /
 * `assignedAt` / `assignedByUserId` from the current document EXACTLY — a
 * due-date change is never an assignment event, and must never overwrite
 * the record of when this person was actually assigned. Only `updatedAt` /
 * `updatedByUserId` / `revision` advance, alongside the freshly supplied
 * metadata itself (`updatedAt` already exists precisely to distinguish
 * "record last touched" from "reviewer assigned" — this function is the
 * first caller to actually need that distinction).
 *
 * Requires an EXISTING assignment with a non-null `assignedReviewerUserId`
 * — there is no reviewer identity to preserve otherwise. Callers must use
 * `buildNextAdaptiveHumanReviewAssignment` for create/reassign/unassign.
 */
export function buildAdaptiveHumanReviewAssignmentMetadataUpdate(args: {
  current: AdaptiveHumanReviewAssignmentV1 & { assignedReviewerUserId: string };
  actorUserId: string;
  now: string;
  workspaceMetadata: AdaptiveHumanReviewAssignmentWorkspaceMetadata;
}): AdaptiveHumanReviewAssignmentV1 {
  return {
    ...args.current,
    updatedAt: args.now,
    updatedByUserId: args.actorUserId,
    revision: args.current.revision + 1,
    workspaceId: args.workspaceMetadata.workspaceId,
    projectId: args.workspaceMetadata.projectId,
    dueAt: args.workspaceMetadata.dueAt,
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

  /**
   * Phase 9B.2 — historical Workspace/Project discovery-metadata AND due-date
   * snapshot AT THE TIME of this mutation. Immutable once written — never
   * rewritten if the run later moves Projects (see
   * `associateTeamRunWithProject.ts`'s own projection-sync, which updates
   * ONLY the live `humanReviewAssignment/current` mirror, never this
   * history). Present only for Workspace-bound assignment mutations; absent
   * for legacy Team mutations, exactly like the assignment document itself.
   */
  workspaceId?: string;
  projectId?: string | null;
  dueAt?: string | null;
};

export function buildAdaptiveHumanReviewAssignmentHistoryEntry(args: {
  teamId: string | null;
  runId: string;
  previousReviewerUserId: string | null;
  newReviewerUserId: string | null;
  assignmentRevision: number;
  changedAt: string;
  changedByUserId: string;
  /** Phase 9B.2 — supplied only for a Workspace-bound assignment mutation, mirroring `buildNextAdaptiveHumanReviewAssignment`'s own optional parameter exactly. */
  workspaceMetadata?: AdaptiveHumanReviewAssignmentWorkspaceMetadata;
}): AdaptiveHumanReviewAssignmentHistoryV1 {
  const base: AdaptiveHumanReviewAssignmentHistoryV1 = {
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
  if (!args.workspaceMetadata) return base;
  return {
    ...base,
    workspaceId: args.workspaceMetadata.workspaceId,
    projectId: args.workspaceMetadata.projectId,
    dueAt: args.workspaceMetadata.dueAt,
  };
}

/**
 * Phase 9B.2 — the append-only history counterpart to
 * `buildAdaptiveHumanReviewAssignmentMetadataUpdate()`. `eventType` is
 * always `"metadata_updated"`, never derived via `classifyAssignmentEventType()`
 * (which would incorrectly read a same-reviewer metadata change as
 * `"reassigned"`, since it only compares before/after reviewer identity —
 * this is a genuinely distinct event class, checked/constructed
 * independently). `previousReviewerUserId`/`newReviewerUserId` are both set
 * to the unchanged `reviewerUserId`, honestly reflecting that no reviewer
 * transition occurred.
 */
export function buildAdaptiveHumanReviewAssignmentMetadataHistoryEntry(args: {
  teamId: string | null;
  runId: string;
  reviewerUserId: string;
  assignmentRevision: number;
  changedAt: string;
  changedByUserId: string;
  workspaceMetadata: AdaptiveHumanReviewAssignmentWorkspaceMetadata;
}): AdaptiveHumanReviewAssignmentHistoryV1 {
  return {
    schemaVersion: 1,
    eventId: String(args.assignmentRevision),
    teamId: args.teamId,
    runId: args.runId,
    eventType: "metadata_updated",
    previousReviewerUserId: args.reviewerUserId,
    newReviewerUserId: args.reviewerUserId,
    assignmentRevision: args.assignmentRevision,
    changedAt: args.changedAt,
    changedByUserId: args.changedByUserId,
    workspaceId: args.workspaceMetadata.workspaceId,
    projectId: args.workspaceMetadata.projectId,
    dueAt: args.workspaceMetadata.dueAt,
  };
}
