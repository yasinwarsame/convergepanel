/**
 * Approval Workflow, Phase 9B.4 — the read-only query/revalidation engine
 * for `GET /api/workspaces/{workspaceId}/review-queue`. Five views over
 * Workspace-bound adaptive Deep Research runs; no write of any kind.
 *
 * CANONICAL AUTHORITY: `runs/{runId}.governanceRecord.humanReview.status`
 * is the sole authority for review state. `humanReviewAssignment/current`'s
 * `workspaceId`/`projectId`/`dueAt` are discovery projections only (Phase
 * 9B.2) — every row this module returns is revalidated against the
 * canonical run via `resolveWorkspaceReviewTarget()` (Phase 9B.1) before
 * being included, exactly like `resubmitWorkspaceReview()` (Phase 9B.3)
 * already does. Deliberately NO `humanReviewStatus` mirror was added to
 * assignment documents to serve this phase (a live architecture decision,
 * not an oversight) — status-driven views (`needs_review`,
 * `changes_requested`, `recently_approved`) query `runs` directly;
 * assignment-driven views (`assigned_to_me`, `overdue`) query the
 * assignment projection for candidate discovery only, then revalidate.
 *
 * BOUNDED CANDIDATE SCAN: every view uses the same round-based scan
 * discipline (`MAX_SCAN_ROUNDS` rounds of up to `limit + 1` candidates
 * each) — a candidate that fails revalidation (stale, malformed, foreign)
 * is dropped and scanning continues within the SAME request, never an
 * unbounded loop. The cursor always resumes from the last RAW candidate
 * examined (not the last valid row emitted), so no valid row is ever
 * skipped across a page boundary, and `hasMore` never conflates "ran out
 * of rounds" with "genuinely exhausted the collection."
 */

import "server-only";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { resolveWorkspaceReviewTarget } from "./resolveWorkspaceReviewTarget";
import { isValidAssignmentTarget, type WorkspaceReviewCandidate } from "./workspaceReviewEligibility";
import { computeMembershipId } from "./membershipId";
import { validateMembershipBinding } from "./membershipBinding";
import { isHumanReviewStatusReviewable, parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { isCanonicalDueAt, type AdaptiveHumanReviewAssignmentV1 } from "@/lib/governance/adaptiveHumanReviewAssignment";
import { resolveWorkspaceReviewerDisplayNames, REVIEWER_UNAVAILABLE_LABEL } from "./workspaceReviewerIdentity";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import { encodeReviewQueueCursor, type ReviewQueueView, type ReviewQueueCursor } from "./reviewQueueCursor";

const MAX_SCAN_ROUNDS = 3;

/** Phase 9B.6 — mirrors `personalReviewInbox.ts`'s own established `question` → safe-preview truncation exactly (same 200-char bound), reused here rather than a new convention. Never the full research prompt. */
const MAX_RUN_LABEL_LENGTH = 200;

function truncateRunLabel(s: string): string {
  const t = s.trim();
  return t.length <= MAX_RUN_LABEL_LENGTH ? t : `${t.slice(0, MAX_RUN_LABEL_LENGTH)}…`;
}

export type ReviewQueueAssignmentState = "unassigned" | "actionable" | "stale";

export interface ReviewQueueRow {
  runId: string;
  workspaceId: string;
  projectId: string | null;
  /** Phase 9B.6 — a safe, truncated preview of the run's own `question`, never the full research prompt/context. */
  runLabel: string;
  reviewStatus: GovernanceRecordV1["humanReview"]["status"];
  createdAt: string;
  reviewedAt: string | null;
  assignment: {
    assignedReviewerUserId: string | null;
    /** Phase 9B.6 — server-resolved, safe display label (never a raw UID). `null` only when `assignedReviewerUserId` is `null`. */
    assignedReviewerDisplayName: string | null;
    dueAt: string | null;
    state: ReviewQueueAssignmentState;
  };
  isAssignedToMe: boolean;
  isOverdue: boolean;
}

export type ReviewQueueResult =
  | { status: "ok"; items: ReviewQueueRow[]; hasMore: boolean; nextCursor?: string }
  | { status: "query_failed" };

interface RunRevalidation {
  runId: string;
  workspaceId: string;
  projectId: string | null;
  creatorUid: string;
  humanReview: GovernanceRecordV1["humanReview"];
  createdAt: string;
  runLabel: string;
}

// ============================================
// Shared: canonical run revalidation
// ============================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function createdAtToIso(value: unknown): string {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

/** Re-derives canonical status from a freshly-read `runs/{runId}` doc. `null` = not a valid, adaptive, Workspace-bound review target — the caller must drop the candidate, never fabricate a row. */
function revalidateRun(runId: string, workspaceId: string, runData: Record<string, unknown> | undefined): RunRevalidation | null {
  if (!runData) return null;

  const target = resolveWorkspaceReviewTarget({
    requestedWorkspaceId: workspaceId,
    hasWorkspaceIdField: "workspaceId" in runData,
    workspaceIdValue: runData.workspaceId,
    userId: runData.userId,
    hasProjectIdField: "projectId" in runData,
    projectIdValue: runData.projectId,
  });
  if (target.kind !== "valid_workspace_review_target") return null;

  const parsed = parseGovernanceRecord(runData.governanceRecord);
  if (!parsed.ok) return null;

  return {
    runId,
    workspaceId: target.workspaceId,
    projectId: target.projectId,
    creatorUid: target.creatorUid,
    humanReview: parsed.record.humanReview,
    createdAt: createdAtToIso(runData.createdAt),
    runLabel: truncateRunLabel(typeof runData.question === "string" ? runData.question : ""),
  };
}

// ============================================
// Shared: assignment actionability derivation
// ============================================

interface AssignmentSummaryInput {
  runId: string;
  workspaceId: string;
  creatorUid: string;
  assignment: (AdaptiveHumanReviewAssignmentV1 & { assignedReviewerUserId: string }) | null;
  /** Already-resolved CURRENT membership of the assignee, or `null` if none/removed/malformed. Callers batch this — this function never reads Firestore itself. */
  assigneeCandidate: WorkspaceReviewCandidate | null;
}

function deriveAssignmentSummary(input: AssignmentSummaryInput): { assignedReviewerUserId: string | null; dueAt: string | null; state: ReviewQueueAssignmentState } {
  if (!input.assignment) {
    return { assignedReviewerUserId: null, dueAt: null, state: "unassigned" };
  }
  const dueAt = typeof input.assignment.dueAt === "string" && isCanonicalDueAt(input.assignment.dueAt) ? input.assignment.dueAt : null;
  const eligibility = isValidAssignmentTarget({ candidate: input.assigneeCandidate, runWorkspaceId: input.workspaceId, creatorUid: input.creatorUid });
  return {
    assignedReviewerUserId: input.assignment.assignedReviewerUserId,
    dueAt,
    state: eligibility.eligible ? "actionable" : "stale",
  };
}

// ============================================
// Batched membership lookup — one adminDb.getAll() per page, deduplicated
// by uid, never one read per row (Phase 9B.4 spec §35/§36).
// ============================================

async function batchLoadMembershipCandidates(workspaceId: string, uids: readonly string[]): Promise<Map<string, WorkspaceReviewCandidate>> {
  const result = new Map<string, WorkspaceReviewCandidate>();
  const uniqueUids = Array.from(new Set(uids));
  if (!adminDb || uniqueUids.length === 0) return result;
  const refs = uniqueUids.map((uid) => adminDb!.collection("workspaceMemberships").doc(computeMembershipId(workspaceId, uid)));
  const snaps = await adminDb.getAll(...refs);
  for (let i = 0; i < uniqueUids.length; i++) {
    const uid = uniqueUids[i];
    const snap = snaps[i];
    if (!snap.exists) continue;
    const membership = validateMembershipBinding(snap.data(), { workspaceId, uid });
    if (membership) {
      result.set(uid, { uid: membership.uid, workspaceId: membership.workspaceId, role: membership.role, status: membership.status });
    }
  }
  return result;
}

async function batchLoadAssignments(runIds: readonly string[]): Promise<Map<string, AdaptiveHumanReviewAssignmentV1 | undefined>> {
  const result = new Map<string, AdaptiveHumanReviewAssignmentV1 | undefined>();
  if (!adminDb || runIds.length === 0) return result;
  const refs = runIds.map((id) => adminDb!.collection("runs").doc(id).collection("humanReviewAssignment").doc("current"));
  const snaps = await adminDb.getAll(...refs);
  for (let i = 0; i < runIds.length; i++) {
    const snap = snaps[i];
    if (snap.exists) {
      result.set(runIds[i], snap.data() as AdaptiveHumanReviewAssignmentV1);
    }
  }
  return result;
}

// ============================================
// View: needs_review / changes_requested / recently_approved
// (runs collection, status-driven)
// ============================================

const REVIEWABLE_STATUSES: readonly string[] = ["unreviewed", "pending"];
const TERMINAL_APPROVED_STATUSES: readonly string[] = ["approved", "approved_with_conditions"];

interface StatusViewSpec {
  statuses: readonly string[];
  orderField: "createdAt" | "governanceRecord.humanReview.reviewedAt";
  sortKind: "timestamp" | "iso";
}

const STATUS_VIEW_SPECS: Record<"needs_review" | "changes_requested" | "recently_approved", StatusViewSpec> = {
  needs_review: { statuses: REVIEWABLE_STATUSES, orderField: "createdAt", sortKind: "timestamp" },
  changes_requested: { statuses: ["changes_requested"], orderField: "governanceRecord.humanReview.reviewedAt", sortKind: "iso" },
  recently_approved: { statuses: TERMINAL_APPROVED_STATUSES, orderField: "governanceRecord.humanReview.reviewedAt", sortKind: "iso" },
};

async function scanStatusView(args: {
  view: "needs_review" | "changes_requested" | "recently_approved";
  workspaceId: string;
  uid: string;
  projectFilter: string | null | undefined;
  limit: number;
  cursor: ReviewQueueCursor | null;
}): Promise<ReviewQueueResult> {
  if (!adminDb) return { status: "query_failed" };
  const spec = STATUS_VIEW_SPECS[args.view];

  const validRows: ReviewQueueRow[] = [];
  let lastScanned: { sort: ReviewQueueCursor["sort"]; docPath: string } | null = args.cursor
    ? { sort: args.cursor.sort, docPath: args.cursor.docPath }
    : null;
  let exhausted = false;
  const batchSize = args.limit + 1;

  try {
    for (let round = 0; round < MAX_SCAN_ROUNDS && validRows.length < args.limit && !exhausted; round++) {
      let query: FirebaseFirestore.Query = adminDb.collection("runs").where("workspaceId", "==", args.workspaceId);
      if (spec.statuses.length === 1) {
        query = query.where("governanceRecord.humanReview.status", "==", spec.statuses[0]);
      } else {
        query = query.where("governanceRecord.humanReview.status", "in", spec.statuses);
      }
      if (args.projectFilter !== undefined) {
        query = query.where("projectId", "==", args.projectFilter);
      }
      query = query.orderBy(spec.orderField, "desc").orderBy(FieldPath.documentId(), "desc");
      if (lastScanned) {
        const startAfterValue = spec.sortKind === "timestamp" && lastScanned.sort.kind === "timestamp" ? new Timestamp(lastScanned.sort.seconds, lastScanned.sort.nanoseconds) : (lastScanned.sort as { kind: "iso"; value: string }).value;
        query = query.startAfter(startAfterValue, lastScanned.docPath);
      }

      const snap = await query.limit(batchSize).get();
      if (snap.docs.length === 0) {
        exhausted = true;
        break;
      }
      if (snap.docs.length < batchSize) exhausted = true;

      const runIds = snap.docs.map((d) => d.id);
      const assignmentsByRunId = await batchLoadAssignments(runIds);
      const reviewerUids = Array.from(
        new Set(
          runIds
            .map((id) => assignmentsByRunId.get(id)?.assignedReviewerUserId)
            .filter((uid): uid is string => typeof uid === "string" && uid.length > 0)
        )
      );
      const membershipByUid = await batchLoadMembershipCandidates(args.workspaceId, reviewerUids);

      for (const doc of snap.docs) {
        const revalidated = revalidateRun(doc.id, args.workspaceId, doc.data());
        lastScanned = { sort: buildSortValue(spec.sortKind, doc.data(), spec.orderField), docPath: doc.id };

        if (revalidated && spec.statuses.includes(revalidated.humanReview.status)) {
          const rawAssignment = assignmentsByRunId.get(doc.id);
          const assignment =
            rawAssignment && typeof rawAssignment.assignedReviewerUserId === "string" && rawAssignment.assignedReviewerUserId.length > 0
              ? (rawAssignment as AdaptiveHumanReviewAssignmentV1 & { assignedReviewerUserId: string })
              : null;
          const assigneeCandidate = assignment ? (membershipByUid.get(assignment.assignedReviewerUserId) ?? null) : null;
          const assignmentSummary = deriveAssignmentSummary({ runId: doc.id, workspaceId: args.workspaceId, creatorUid: revalidated.creatorUid, assignment, assigneeCandidate });
          // Reflects real overdue state on EVERY view's row (a single
          // stable DTO shape, §31) — not only the dedicated `overdue`
          // view, which additionally uses this as its own inclusion
          // filter (scanOverdue never emits a row unless this would be
          // true).
          const isOverdue = assignmentSummary.state === "actionable" && assignmentSummary.dueAt !== null && Date.parse(assignmentSummary.dueAt) < Date.now();

          if (validRows.length < args.limit) {
            validRows.push({
              runId: revalidated.runId,
              workspaceId: revalidated.workspaceId,
              projectId: revalidated.projectId,
              runLabel: revalidated.runLabel,
              reviewStatus: revalidated.humanReview.status,
              createdAt: revalidated.createdAt,
              reviewedAt: revalidated.humanReview.reviewedAt ?? null,
              assignment: { ...assignmentSummary, assignedReviewerDisplayName: null },
              isAssignedToMe: assignmentSummary.assignedReviewerUserId === args.uid && assignmentSummary.state === "actionable",
              isOverdue,
            });
          }
        }
        if (validRows.length >= args.limit) break;
      }
    }

    const hasMore = !exhausted && lastScanned !== null;
    const nextCursor = hasMore && lastScanned ? encodeCursorFor(args.workspaceId, args.view, args.projectFilter, lastScanned.sort, lastScanned.docPath) : undefined;
    return { status: "ok", items: validRows, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  } catch (err) {
    logger.warn("[workspaces/reviewQueue] status-view query failed", { view: args.view, workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "query_failed" };
  }
}

function buildSortValue(kind: "timestamp" | "iso", data: Record<string, unknown>, field: string): ReviewQueueCursor["sort"] {
  if (kind === "timestamp") {
    const value = data.createdAt;
    if (value instanceof Timestamp) return { kind: "timestamp", seconds: value.seconds, nanoseconds: value.nanoseconds };
    return { kind: "timestamp", seconds: 0, nanoseconds: 0 };
  }
  const gr = data.governanceRecord as Record<string, unknown> | undefined;
  const hr = gr?.humanReview as Record<string, unknown> | undefined;
  const value = hr?.reviewedAt;
  return { kind: "iso", value: typeof value === "string" ? value : new Date(0).toISOString() };
}

// ============================================
// View: assigned_to_me / overdue (humanReviewAssignment collectionGroup,
// assignment-driven)
// ============================================

async function scanAssignedToMe(args: {
  workspaceId: string;
  uid: string;
  callerCandidate: WorkspaceReviewCandidate;
  projectFilter: string | null | undefined;
  limit: number;
  cursor: ReviewQueueCursor | null;
}): Promise<ReviewQueueResult> {
  if (!adminDb) return { status: "query_failed" };

  const validRows: ReviewQueueRow[] = [];
  let lastScanned: { value: string; docPath: string } | null = args.cursor ? { value: cursorIso(args.cursor.sort), docPath: args.cursor.docPath } : null;
  let exhausted = false;
  const batchSize = args.limit + 1;

  try {
    for (let round = 0; round < MAX_SCAN_ROUNDS && validRows.length < args.limit && !exhausted; round++) {
      let query = adminDb
        .collectionGroup("humanReviewAssignment")
        .where("workspaceId", "==", args.workspaceId)
        .where("assignedReviewerUserId", "==", args.uid);
      if (args.projectFilter !== undefined) query = query.where("projectId", "==", args.projectFilter);
      query = query.orderBy("assignedAt", "desc").orderBy(FieldPath.documentId(), "desc");
      if (lastScanned) query = query.startAfter(lastScanned.value, lastScanned.docPath);

      const snap = await query.limit(batchSize).get();
      if (snap.docs.length === 0) {
        exhausted = true;
        break;
      }
      if (snap.docs.length < batchSize) exhausted = true;

      const runRefs = snap.docs.map((d) => d.ref.parent.parent).filter((r): r is FirebaseFirestore.DocumentReference => r !== null);
      const runSnaps = runRefs.length > 0 ? await adminDb.getAll(...runRefs) : [];
      const runDataById = new Map<string, Record<string, unknown>>();
      for (const s of runSnaps) if (s.exists) runDataById.set(s.id, s.data() as Record<string, unknown>);

      for (const doc of snap.docs) {
        const runRef = doc.ref.parent.parent;
        lastScanned = { value: typeof doc.data().assignedAt === "string" ? doc.data().assignedAt : new Date(0).toISOString(), docPath: doc.ref.path };
        if (!runRef) continue;
        const revalidated = revalidateRun(runRef.id, args.workspaceId, runDataById.get(runRef.id));
        if (!revalidated) continue;
        if (!isHumanReviewStatusReviewable(revalidated.humanReview.status)) continue;

        const assignment = doc.data() as AdaptiveHumanReviewAssignmentV1;
        if (typeof assignment.assignedReviewerUserId !== "string" || assignment.assignedReviewerUserId !== args.uid) continue;

        const eligibility = isValidAssignmentTarget({ candidate: args.callerCandidate, runWorkspaceId: args.workspaceId, creatorUid: revalidated.creatorUid });
        if (!eligibility.eligible) continue; // stale/self-review — never shown as actionable "assigned to me"

        const dueAt = typeof assignment.dueAt === "string" && isCanonicalDueAt(assignment.dueAt) ? assignment.dueAt : null;
        if (validRows.length < args.limit) {
          validRows.push({
            runId: revalidated.runId,
            workspaceId: revalidated.workspaceId,
            projectId: revalidated.projectId,
            runLabel: revalidated.runLabel,
            reviewStatus: revalidated.humanReview.status,
            createdAt: revalidated.createdAt,
            reviewedAt: revalidated.humanReview.reviewedAt ?? null,
            assignment: { assignedReviewerUserId: args.uid, assignedReviewerDisplayName: null, dueAt, state: "actionable" },
            isAssignedToMe: true,
            isOverdue: dueAt !== null && Date.parse(dueAt) < Date.now(),
          });
        }
        if (validRows.length >= args.limit) break;
      }
    }

    const hasMore = !exhausted && lastScanned !== null;
    const nextCursor = hasMore && lastScanned ? encodeCursorFor(args.workspaceId, "assigned_to_me", args.projectFilter, { kind: "iso", value: lastScanned.value }, lastScanned.docPath) : undefined;
    return { status: "ok", items: validRows, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  } catch (err) {
    logger.warn("[workspaces/reviewQueue] assigned_to_me query failed", { workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "query_failed" };
  }
}

async function scanOverdue(args: {
  workspaceId: string;
  uid: string;
  projectFilter: string | null | undefined;
  limit: number;
  cursor: ReviewQueueCursor | null;
}): Promise<ReviewQueueResult> {
  if (!adminDb) return { status: "query_failed" };

  const nowIso = new Date().toISOString();
  const validRows: ReviewQueueRow[] = [];
  let lastScanned: { value: string; docPath: string } | null = args.cursor ? { value: cursorIso(args.cursor.sort), docPath: args.cursor.docPath } : null;
  let exhausted = false;
  const batchSize = args.limit + 1;

  try {
    for (let round = 0; round < MAX_SCAN_ROUNDS && validRows.length < args.limit && !exhausted; round++) {
      let query = adminDb
        .collectionGroup("humanReviewAssignment")
        .where("workspaceId", "==", args.workspaceId)
        .where("dueAt", "<", nowIso);
      if (args.projectFilter !== undefined) query = query.where("projectId", "==", args.projectFilter);
      query = query.orderBy("dueAt", "asc").orderBy(FieldPath.documentId(), "asc");
      if (lastScanned) query = query.startAfter(lastScanned.value, lastScanned.docPath);

      const snap = await query.limit(batchSize).get();
      if (snap.docs.length === 0) {
        exhausted = true;
        break;
      }
      if (snap.docs.length < batchSize) exhausted = true;

      const runRefs = snap.docs.map((d) => d.ref.parent.parent).filter((r): r is FirebaseFirestore.DocumentReference => r !== null);
      const runSnaps = runRefs.length > 0 ? await adminDb.getAll(...runRefs) : [];
      const runDataById = new Map<string, Record<string, unknown>>();
      for (const s of runSnaps) if (s.exists) runDataById.set(s.id, s.data() as Record<string, unknown>);

      const reviewerUids = Array.from(
        new Set(
          snap.docs
            .map((d) => (d.data() as AdaptiveHumanReviewAssignmentV1).assignedReviewerUserId)
            .filter((uid): uid is string => typeof uid === "string" && uid.length > 0)
        )
      );
      const membershipByUid = await batchLoadMembershipCandidates(args.workspaceId, reviewerUids);

      for (const doc of snap.docs) {
        const runRef = doc.ref.parent.parent;
        lastScanned = { value: typeof doc.data().dueAt === "string" ? doc.data().dueAt : new Date(0).toISOString(), docPath: doc.ref.path };
        if (!runRef) continue;
        const revalidated = revalidateRun(runRef.id, args.workspaceId, runDataById.get(runRef.id));
        if (!revalidated) continue;
        if (!isHumanReviewStatusReviewable(revalidated.humanReview.status)) continue;

        const assignment = doc.data() as AdaptiveHumanReviewAssignmentV1;
        if (typeof assignment.assignedReviewerUserId !== "string") continue;
        if (typeof assignment.dueAt !== "string" || !isCanonicalDueAt(assignment.dueAt)) continue; // malformed dueAt — never overdue
        if (!(Date.parse(assignment.dueAt) < Date.now())) continue; // defense in depth beyond the query filter

        const candidate = membershipByUid.get(assignment.assignedReviewerUserId) ?? null;
        const eligibility = isValidAssignmentTarget({ candidate, runWorkspaceId: args.workspaceId, creatorUid: revalidated.creatorUid });
        if (!eligibility.eligible) continue;

        if (validRows.length < args.limit) {
          validRows.push({
            runId: revalidated.runId,
            workspaceId: revalidated.workspaceId,
            projectId: revalidated.projectId,
            runLabel: revalidated.runLabel,
            reviewStatus: revalidated.humanReview.status,
            createdAt: revalidated.createdAt,
            reviewedAt: revalidated.humanReview.reviewedAt ?? null,
            assignment: { assignedReviewerUserId: assignment.assignedReviewerUserId, assignedReviewerDisplayName: null, dueAt: assignment.dueAt, state: "actionable" },
            isAssignedToMe: assignment.assignedReviewerUserId === args.uid,
            isOverdue: true,
          });
        }
        if (validRows.length >= args.limit) break;
      }
    }

    const hasMore = !exhausted && lastScanned !== null;
    const nextCursor = hasMore && lastScanned ? encodeCursorFor(args.workspaceId, "overdue", args.projectFilter, { kind: "iso", value: lastScanned.value }, lastScanned.docPath) : undefined;
    return { status: "ok", items: validRows, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  } catch (err) {
    logger.warn("[workspaces/reviewQueue] overdue query failed", { workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "query_failed" };
  }
}

function cursorIso(sort: ReviewQueueCursor["sort"]): string {
  return sort.kind === "iso" ? sort.value : new Date(0).toISOString();
}

function encodeCursorFor(workspaceId: string, view: ReviewQueueView, projectFilter: string | null | undefined, sort: ReviewQueueCursor["sort"], docPath: string): string {
  return encodeReviewQueueCursor({ workspaceId, view, projectFilter, sort, docPath });
}

// ============================================
// Public entry point
// ============================================

/**
 * Phase 9B.6, membership-gated per Phase 9B.6-R1C — one additional
 * batched identity-resolution pass over the PAGE's already-returned rows
 * (never per-row, never a new query) so the UI never has to render a raw
 * UID for an assignee. Uses `resolveWorkspaceReviewerDisplayNames()`
 * (`workspaceReviewerIdentity.ts`), NOT the raw global
 * `resolveReviewerDisplayNames()` directly — an `assignedReviewerUserId`
 * is governance metadata, not proof of Workspace membership, and this
 * gate is what prevents a corrupted/foreign UID from becoming a
 * cross-user identity oracle (see that module's own doc comment for the
 * full rationale). A resolution failure/gap/non-membership NEVER changes
 * `assignment.state` — a stale assignment naming a removed-but-evidenced
 * reviewer still safely enriches to a real name; a non-member or foreign
 * UID enriches to `REVIEWER_UNAVAILABLE_LABEL`, never a fabricated name,
 * and never becomes actionable merely because identity resolution
 * succeeded or failed.
 */
async function enrichWithReviewerDisplayNames(result: ReviewQueueResult, workspaceId: string): Promise<ReviewQueueResult> {
  if (result.status !== "ok" || result.items.length === 0) return result;
  const uids = result.items.map((row) => row.assignment.assignedReviewerUserId).filter((uid): uid is string => typeof uid === "string" && uid.length > 0);
  if (uids.length === 0) return result;
  const nameByUid = await resolveWorkspaceReviewerDisplayNames(workspaceId, uids);
  return {
    ...result,
    items: result.items.map((row) =>
      row.assignment.assignedReviewerUserId
        ? { ...row, assignment: { ...row.assignment, assignedReviewerDisplayName: nameByUid.get(row.assignment.assignedReviewerUserId) ?? REVIEWER_UNAVAILABLE_LABEL } }
        : row
    ),
  };
}

export async function getReviewQueue(args: {
  view: ReviewQueueView;
  workspaceId: string;
  uid: string;
  callerCandidate: WorkspaceReviewCandidate;
  projectFilter: string | null | undefined;
  limit: number;
  cursor: ReviewQueueCursor | null;
}): Promise<ReviewQueueResult> {
  let result: ReviewQueueResult;
  switch (args.view) {
    case "needs_review":
    case "changes_requested":
    case "recently_approved":
      result = await scanStatusView({ view: args.view, workspaceId: args.workspaceId, uid: args.uid, projectFilter: args.projectFilter, limit: args.limit, cursor: args.cursor });
      break;
    case "assigned_to_me":
      result = await scanAssignedToMe({ workspaceId: args.workspaceId, uid: args.uid, callerCandidate: args.callerCandidate, projectFilter: args.projectFilter, limit: args.limit, cursor: args.cursor });
      break;
    case "overdue":
      result = await scanOverdue({ workspaceId: args.workspaceId, uid: args.uid, projectFilter: args.projectFilter, limit: args.limit, cursor: args.cursor });
      break;
  }
  return enrichWithReviewerDisplayNames(result, args.workspaceId);
}
