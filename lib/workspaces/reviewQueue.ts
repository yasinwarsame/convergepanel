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
import { REPORT_REVIEW_ENABLED } from "./reportReviewRollout";
import { parseReportReviewRecord } from "@/lib/governance/reportReview";

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
  /** Order B, Stage B2 — present ONLY on report-review rows (governed rows are byte-identical to before). */
  recordKind?: "report_review";
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
  /** Order B, Stage B2 — set only for a report-review run; its submitter can never be an actionable reviewer. */
  reportReview?: { submitterUid: string; cycle: number };
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
  if (!parsed.ok) {
    // Order B, Stage B2 — only while Report Review is enabled: a run without a governance record may be a
    // report-review run. When disabled, this branch is never reached and behaviour is unchanged.
    if (!REPORT_REVIEW_ENABLED) return null;
    if (runData.governanceRecord !== undefined && runData.governanceRecord !== null) return null; // malformed governed record: unchanged (excluded)
    const rr = parseReportReviewRecord(runData.reportReview);
    if (!rr.ok) return null;
    return {
      runId,
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      creatorUid: target.creatorUid,
      humanReview: rr.record.humanReview as GovernanceRecordV1["humanReview"],
      createdAt: createdAtToIso(runData.createdAt),
      runLabel: truncateRunLabel(typeof runData.question === "string" ? runData.question : ""),
      reportReview: { submitterUid: rr.record.submittedByUserId, cycle: rr.record.cycle },
    };
  }
  // A run carrying BOTH records violates the B1 invariant: fail closed (never listed) while Report Review is enabled.
  if (REPORT_REVIEW_ENABLED && runData.reportReview !== undefined && runData.reportReview !== null) return null;

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

/** Order B, Stage B2 — the report-review submitter is never an actionable reviewer of that report. */
function isReportReviewSubmitter(revalidated: RunRevalidation, uid: string | null | undefined): boolean {
  return revalidated.reportReview !== undefined && typeof uid === "string" && uid === revalidated.reportReview.submitterUid;
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
  /** Order B, Stage B2 — the report-review submitter, if this is a report-review run. */
  submitterUid?: string | null;
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
    state: eligibility.eligible && !(input.submitterUid && input.assignment.assignedReviewerUserId === input.submitterUid) ? "actionable" : "stale",
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
          const assignmentSummary = deriveAssignmentSummary({ runId: doc.id, workspaceId: args.workspaceId, creatorUid: revalidated.creatorUid, assignment, assigneeCandidate, submitterUid: revalidated.reportReview?.submitterUid ?? null });
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
              ...(revalidated.reportReview ? { recordKind: "report_review" as const } : {}),
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
        if (isReportReviewSubmitter(revalidated, args.uid)) continue; // Order B, Stage B2 — submitter never reviews

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
            ...(revalidated.reportReview ? { recordKind: "report_review" as const } : {}),
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
        if (isReportReviewSubmitter(revalidated, assignment.assignedReviewerUserId)) continue; // Order B, Stage B2

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
            ...(revalidated.reportReview ? { recordKind: "report_review" as const } : {}),
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

function encodeCursorFor(workspaceId: string, view: ReviewQueueView, projectFilter: string | null | undefined, sort: ReviewQueueCursor["sort"], docPath: string, merged = false): string {
  return encodeReviewQueueCursor({ workspaceId, view, projectFilter, sort, docPath, ...(merged ? { merged: true } : {}) });
}

// ============================================
// Order B, Stage B2 — MERGED status views (governed + report-review streams)
//
// Two queries over the same `runs` collection with mutually exclusive predicates (a run never holds both records —
// the B1 invariant; a run that somehow does is dropped by revalidateRun) and ONE total order: the view's sort value
// (createdAt, or the stream's own humanReview.reviewedAt ISO string) descending, then document id descending.
//
// Frontier rule (design rev 5 §5, verified): a buffered row may be CONSUMED only if every stream that is not exhausted
// has already fetched at or past it in queue order. The cursor is the last CONSUMED position (never "last emitted"),
// so rows dropped by revalidation still advance it. A stream is refetched only when its buffer is empty, from the
// cursor. Hence: no row is skipped, none is emitted twice, and the pager always advances.
// ============================================

type MergedSort = { kind: "timestamp"; seconds: number; nanoseconds: number } | { kind: "iso"; value: string };
interface MergedPos {
  sort: MergedSort;
  docId: string;
}
interface StreamState {
  name: "governance" | "report_review";
  statusField: string;
  orderField: string;
  buffer: { doc: FirebaseFirestore.QueryDocumentSnapshot; pos: MergedPos }[];
  lastFetched: MergedPos | null;
  exhausted: boolean;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Negative when `a` comes BEFORE `b` in queue order (sort value desc, then document id desc). */
export function compareMergedQueueOrder(a: MergedPos, b: MergedPos): number {
  let c = 0;
  if (a.sort.kind === "timestamp" && b.sort.kind === "timestamp") c = a.sort.seconds - b.sort.seconds || a.sort.nanoseconds - b.sort.nanoseconds;
  else if (a.sort.kind === "iso" && b.sort.kind === "iso") c = byteCompare(a.sort.value, b.sort.value);
  if (c !== 0) return -c; // descending
  return -byteCompare(a.docId, b.docId);
}

/**
 * The row's sort value. Firestore orders mixed value TYPES by type, which this comparator does not model, so a sort
 * value of an unexpected type fails the page explicitly (500) instead of being mis-ordered. Production writes
 * createdAt as a Timestamp and reviewedAt as an ISO string.
 */
function mergedSortOf(kind: "timestamp" | "iso", data: Record<string, unknown>, orderField: string): MergedSort {
  if (kind === "timestamp") {
    const v = data.createdAt;
    if (!(v instanceof Timestamp)) throw new Error("merged queue: non-Timestamp createdAt");
    return { kind: "timestamp", seconds: v.seconds, nanoseconds: v.nanoseconds };
  }
  const [root] = orderField.split(".");
  const hr = (data[root] as Record<string, unknown> | undefined)?.humanReview as Record<string, unknown> | undefined;
  if (typeof hr?.reviewedAt !== "string") throw new Error("merged queue: non-string reviewedAt");
  return { kind: "iso", value: hr.reviewedAt };
}

const MERGED_ORDER_FIELDS: Record<"needs_review" | "changes_requested" | "recently_approved", { governance: string; report_review: string }> = {
  needs_review: { governance: "createdAt", report_review: "createdAt" },
  changes_requested: { governance: "governanceRecord.humanReview.reviewedAt", report_review: "reportReview.humanReview.reviewedAt" },
  recently_approved: { governance: "governanceRecord.humanReview.reviewedAt", report_review: "reportReview.humanReview.reviewedAt" },
};


async function scanStatusViewMerged(args: {
  view: "needs_review" | "changes_requested" | "recently_approved";
  workspaceId: string;
  uid: string;
  projectFilter: string | null | undefined;
  limit: number;
  cursor: ReviewQueueCursor | null;
}): Promise<ReviewQueueResult> {
  if (!adminDb) return { status: "query_failed" };
  const spec = STATUS_VIEW_SPECS[args.view];
  const fields = MERGED_ORDER_FIELDS[args.view];
  const streams: StreamState[] = [
    { name: "governance", statusField: "governanceRecord.humanReview.status", orderField: fields.governance, buffer: [], lastFetched: null, exhausted: false },
    { name: "report_review", statusField: "reportReview.humanReview.status", orderField: fields.report_review, buffer: [], lastFetched: null, exhausted: false },
  ];
  let pos: MergedPos | null = args.cursor ? { sort: args.cursor.sort, docId: args.cursor.docPath } : null;
  const batchSize = args.limit + 1;
  const validRows: ReviewQueueRow[] = [];
  const assignmentsByRunId = new Map<string, AdaptiveHumanReviewAssignmentV1 | undefined>();
  const membershipByUid = new Map<string, WorkspaceReviewCandidate>();

  async function fetchStream(st: StreamState): Promise<void> {
    let query: FirebaseFirestore.Query = adminDb!.collection("runs").where("workspaceId", "==", args.workspaceId);
    query = spec.statuses.length === 1 ? query.where(st.statusField, "==", spec.statuses[0]) : query.where(st.statusField, "in", spec.statuses);
    if (args.projectFilter !== undefined) query = query.where("projectId", "==", args.projectFilter);
    query = query.orderBy(st.orderField, "desc").orderBy(FieldPath.documentId(), "desc");
    if (pos) query = query.startAfter(pos.sort.kind === "timestamp" ? new Timestamp(pos.sort.seconds, pos.sort.nanoseconds) : pos.sort.value, pos.docId);
    const snap = await query.limit(batchSize).get();
    if (snap.docs.length < batchSize) st.exhausted = true;
    for (const d of snap.docs) st.buffer.push({ doc: d, pos: { sort: mergedSortOf(spec.sortKind, d.data(), st.orderField), docId: d.id } });
    if (snap.docs.length > 0) st.lastFetched = st.buffer[st.buffer.length - 1].pos;
    // Batched lookups for this fetch (one getAll each), as in the single-stream scan.
    const ids = snap.docs.map((d) => d.id).filter((id) => !assignmentsByRunId.has(id));
    const loaded = await batchLoadAssignments(ids);
    for (const id of ids) assignmentsByRunId.set(id, loaded.get(id));
    const uids = ids.map((id) => assignmentsByRunId.get(id)?.assignedReviewerUserId).filter((u): u is string => typeof u === "string" && u.length > 0 && !membershipByUid.has(u));
    const members = await batchLoadMembershipCandidates(args.workspaceId, uids);
    for (const [u, m] of members) membershipByUid.set(u, m);
  }

  try {
    const MAX_FETCHES = MAX_SCAN_ROUNDS * 2;
    let fetches = 0;
    for (;;) {
      if (validRows.length >= args.limit) break;
      // Refill: only a stream whose buffer is empty, and not exhausted, is fetched (from the consumed position).
      const needing = streams.filter((st) => st.buffer.length === 0 && !st.exhausted);
      if (needing.length > 0) {
        if (fetches + needing.length > MAX_FETCHES) break;
        for (const st of needing) await fetchStream(st);
        fetches += needing.length;
      }
      // Frontier: the earliest (in queue order) last-fetched position among non-exhausted streams.
      const open = streams.filter((st) => !st.exhausted);
      const frontier = open.length === 0 ? null : open.map((st) => st.lastFetched).reduce<MergedPos | null>((m, p) => (p === null ? m : m === null || compareMergedQueueOrder(p, m) < 0 ? p : m), null);
      // Next candidate in merged order.
      const heads = streams.filter((st) => st.buffer.length > 0);
      if (heads.length === 0) {
        if (streams.every((st) => st.exhausted)) break;
        continue; // a non-exhausted stream with an empty buffer is refilled at the top of the loop
      }
      const head = heads.reduce((a, b) => (compareMergedQueueOrder(a.buffer[0].pos, b.buffer[0].pos) <= 0 ? a : b));
      const next = head.buffer[0];
      // Defensive (mutation-tested as equivalent): every non-exhausted stream was refilled above, so its buffer is
      // non-empty and `next` (the minimum head) is never past the frontier. Kept so a future loop change fails safe.
      if (frontier !== null && compareMergedQueueOrder(next.pos, frontier) > 0) {
        // Cannot consume past a stream that has not fetched this far: refill that stream (its buffer must be empty).
        if (streams.some((st) => !st.exhausted && st.buffer.length === 0)) continue;
        break; // defensive: unreachable by construction
      }
      head.buffer.shift();
      pos = next.pos; // consumed
      const data = next.doc.data();
      const revalidated = revalidateRun(next.doc.id, args.workspaceId, data);
      // Defensive (mutation-tested as equivalent): revalidateRun already drops any run whose records disagree with the
      // stream that fetched it (both records, or a malformed governed record beside a report review).
      const kindMatches = revalidated && ((head.name === "report_review") === (revalidated.reportReview !== undefined));
      if (revalidated && kindMatches && spec.statuses.includes(revalidated.humanReview.status)) {
        const rawAssignment = assignmentsByRunId.get(next.doc.id);
        const assignment =
          rawAssignment && typeof rawAssignment.assignedReviewerUserId === "string" && rawAssignment.assignedReviewerUserId.length > 0
            ? (rawAssignment as AdaptiveHumanReviewAssignmentV1 & { assignedReviewerUserId: string })
            : null;
        const assigneeCandidate = assignment ? (membershipByUid.get(assignment.assignedReviewerUserId) ?? null) : null;
        const summary = deriveAssignmentSummary({ runId: next.doc.id, workspaceId: args.workspaceId, creatorUid: revalidated.creatorUid, assignment, assigneeCandidate, submitterUid: revalidated.reportReview?.submitterUid ?? null });
        const isOverdue = summary.state === "actionable" && summary.dueAt !== null && Date.parse(summary.dueAt) < Date.now();
        validRows.push({
          runId: revalidated.runId,
          workspaceId: revalidated.workspaceId,
          projectId: revalidated.projectId,
          runLabel: revalidated.runLabel,
          reviewStatus: revalidated.humanReview.status,
          createdAt: revalidated.createdAt,
          reviewedAt: revalidated.humanReview.reviewedAt ?? null,
          assignment: { ...summary, assignedReviewerDisplayName: null },
          isAssignedToMe: summary.assignedReviewerUserId === args.uid && summary.state === "actionable",
          isOverdue,
          ...(revalidated.reportReview ? { recordKind: "report_review" as const } : {}),
        });
      }
    }

    const hasMore = streams.some((st) => !st.exhausted || st.buffer.length > 0);
    const nextCursor = hasMore && pos ? encodeCursorFor(args.workspaceId, args.view, args.projectFilter, pos.sort, pos.docId, true) : undefined;
    if (hasMore && !nextCursor) return { status: "query_failed" }; // explicit error, never a silently truncated page
    return { status: "ok", items: validRows, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  } catch (err) {
    logger.warn("[workspaces/reviewQueue] merged status-view query failed", { view: args.view, workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "query_failed" };
  }
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
      result = REPORT_REVIEW_ENABLED
        ? await scanStatusViewMerged({ view: args.view, workspaceId: args.workspaceId, uid: args.uid, projectFilter: args.projectFilter, limit: args.limit, cursor: args.cursor })
        : await scanStatusView({ view: args.view, workspaceId: args.workspaceId, uid: args.uid, projectFilter: args.projectFilter, limit: args.limit, cursor: args.cursor });
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
