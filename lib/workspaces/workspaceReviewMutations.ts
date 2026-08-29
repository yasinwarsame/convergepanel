/**
 * Approval Workflow, Phase 9B.5.1 — the shared Workspace-qualified
 * single-review mutation service: assignment read/create/reassign/
 * dueAt-update/remove, and the ordinary (non-panel) review decision.
 * Resubmission is NOT here — `resubmitWorkspaceReview()` (Phase 9B.3) is
 * reused as-is, unmodified, by its own thin route.
 *
 * Deliberately a NEW, self-contained set of transactional functions —
 * mirroring `resubmitWorkspaceReview.ts`'s own precedent — rather than
 * calling the legacy `submitAdaptiveHumanReviewAssignment()`/
 * `submitAdaptiveHumanReview()` (`lib/firestore/runs.ts`). Those functions
 * open their OWN transactions with no Workspace authorization, no
 * canonical-run/Workspace binding check, and no active-panel gate; wrapping
 * them would require a SEPARATE transaction from the one that authorizes
 * the caller, violating the "no second independent authorization window"
 * requirement (Phase 9B.2's read-after-write lesson generalizes to
 * authorization races too — a revocation landing between two transactions
 * is exactly as unsafe as one landing between a read and a write). Instead
 * this module reuses the mature, already-tested PURE builders directly
 * (`buildNextAdaptiveHumanReviewAssignment`,
 * `buildAdaptiveHumanReviewAssignmentMetadataUpdate`,
 * `buildAdaptiveHumanReviewAssignmentHistoryEntry`,
 * `buildAdaptiveHumanReviewAssignmentMetadataHistoryEntry`,
 * `applyHumanReviewUpdate`) inside its own Workspace-native transactions,
 * and reuses the existing Firestore I/O writers that are already
 * Workspace-agnostic (`createAdaptiveHumanReviewAssignmentHistory`,
 * `createAdaptiveHumanReviewHistory`, `writeAdaptiveHumanReviewEvent`,
 * `writeAdaptiveAdminAuditEvent` — every one already accepts `teamId:
 * string | null`) exactly where the legacy route already composes them,
 * as best-effort, post-commit writes. Legacy Team routes/behavior are
 * completely untouched by this module.
 *
 * ACTIVE PANEL MUTUAL EXCLUSION (new Workspace-only invariant, §25/§28/§29
 * of the Phase 9B.5.1 spec): an OPEN `humanReviewPanel/current` blocks
 * every assignment mutation and the ordinary decision route — read fresh,
 * fail-closed on malformed/unsupported-version panel data (mirroring
 * `evaluateAdaptiveReviewPanelGate()`'s own established fail-closed
 * asymmetry from assignment lookups in the legacy decision route), inside
 * the SAME transaction as the write it would otherwise block. A finalized
 * or cancelled panel — or no panel at all — never blocks anything; this is
 * what keeps the Phase 9B.3 single-reviewer re-entry path open after a
 * panel-driven `changes_requested` resubmission.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "./teamWorkspaceTargetAdmission";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "./authorizeTeamWorkspaceMutationInTransaction";
import { roleHasCapability } from "./capabilities";
import { resolveWorkspaceReviewTarget } from "./resolveWorkspaceReviewTarget";
import { isValidAssignmentTarget, isOrdinaryReviewerAuthorized, type WorkspaceReviewCandidate, type AssignmentTargetIneligibilityReason, type OrdinaryReviewerAuthorizationDenialReason } from "./workspaceReviewEligibility";
import { computeMembershipId } from "./membershipId";
import { validateMembershipBinding } from "./membershipBinding";
import { parseAdaptiveHumanReviewPanel } from "@/lib/governance/adaptiveHumanReviewPanel";
import { parseGovernanceRecord, applyHumanReviewUpdate, isHumanReviewStatusReviewable } from "@/lib/adaptiveSchema/governanceRecordParser";
import { isSubstantiveDecisionReceiptConclusion } from "@/lib/adaptiveSchema/decisionReceiptUsability";
import {
  isCanonicalDueAt,
  buildNextAdaptiveHumanReviewAssignment,
  buildAdaptiveHumanReviewAssignmentMetadataUpdate,
  buildAdaptiveHumanReviewAssignmentHistoryEntry,
  buildAdaptiveHumanReviewAssignmentMetadataHistoryEntry,
  type AdaptiveHumanReviewAssignmentV1,
  type AdaptiveHumanReviewAssignmentHistoryV1,
} from "@/lib/governance/adaptiveHumanReviewAssignment";
import { createAdaptiveHumanReviewAssignmentHistory, createAdaptiveHumanReviewHistory, writeAdaptiveHumanReviewEvent } from "@/lib/firestore/runs";
import { buildAdaptiveHumanReviewHistoryEntry, buildWorkspaceReviewDecisionId, isAdaptiveReviewTerminalStatus, isAdaptiveReviewNonTerminalStatus } from "@/lib/governance/adaptiveHumanReviewHistory";
import { writeAdaptiveAdminAuditEvent } from "@/lib/governance/auditLog";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import type { PersistedAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";
import type { AdaptiveReviewDecisionStatus } from "@/lib/governance/adaptiveHumanReviewRequest";

// ============================================
// Shared
// ============================================

/** `"open"` blocks; `"invalid"` (malformed/unsupported-version) fails closed identically to `"open"`, mirroring the legacy decision route's own asymmetry from assignment-lookup fail-open behavior; everything else (`absent`/`cancelled`/`finalized`) never blocks. */
type PanelGate = "clear" | "open" | "invalid";

async function readPanelGate(tx: FirebaseFirestore.Transaction, runRef: FirebaseFirestore.DocumentReference, runId: string): Promise<PanelGate> {
  const panelSnap = await tx.get(runRef.collection("humanReviewPanel").doc("current"));
  const parsed = parseAdaptiveHumanReviewPanel(panelSnap.exists ? panelSnap.data() : undefined, { expectedRunId: runId });
  if (parsed.status === "absent") return "clear";
  if (parsed.status === "malformed" || parsed.status === "unsupported_version") return "invalid";
  // status === "valid"
  return parsed.panel.status === "open" ? "open" : "clear"; // cancelled/finalized never block
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ============================================
// Assignment DTO (safe, minimal — §12 of the spec)
// ============================================

export interface WorkspaceReviewAssignmentDto {
  assignedReviewerUserId: string;
  revision: number;
  assignedAt: string | null;
  assignedByUserId: string | null;
  updatedAt: string;
  dueAt: string | null;
}

function toDto(assignment: AdaptiveHumanReviewAssignmentV1): WorkspaceReviewAssignmentDto | null {
  if (!assignment.assignedReviewerUserId) return null;
  return {
    assignedReviewerUserId: assignment.assignedReviewerUserId,
    revision: assignment.revision,
    assignedAt: assignment.assignedAt,
    assignedByUserId: assignment.assignedByUserId,
    updatedAt: assignment.updatedAt,
    dueAt: typeof assignment.dueAt === "string" || assignment.dueAt === null ? (assignment.dueAt ?? null) : null,
  };
}

// ============================================
// GET
// ============================================

export type GetWorkspaceReviewAssignmentResult =
  | { status: "ok"; assignment: WorkspaceReviewAssignmentDto | null; assignmentRevision: number }
  | { status: "run_not_found" }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

/**
 * Plain, non-transactional read — no write follows, so no OCC/transaction is needed. Workspace/capability authorization is the CALLER's (route's) responsibility, exactly like the Phase 9B.4 queue route's own division of labor.
 *
 * Phase 9B.7 — `assignmentRevision` is the persisted assignment resource's
 * OCC version, independent of `assignment` itself: clearing an assignment
 * preserves the document (writes a new revision with
 * `assignedReviewerUserId: null`) rather than deleting it, so `assignment`
 * can be `null` while `assignmentRevision` is still nonzero. This is the
 * exact value `putWorkspaceReviewAssignment`/`deleteWorkspaceReviewAssignment`
 * check against `expectedRevision` — see `reviewContext.ts`'s identical
 * field for the full rationale. `0` means no assignment document has ever
 * been written.
 */
export async function getWorkspaceReviewAssignment(args: { workspaceId: string; runId: string }): Promise<GetWorkspaceReviewAssignmentResult> {
  if (!adminDb) return { status: "firestore_unavailable" };
  try {
    const runSnap = await adminDb.collection("runs").doc(args.runId).get();
    if (!runSnap.exists) return { status: "run_not_found" };
    const runData = runSnap.data() as Record<string, unknown>;
    const target = resolveWorkspaceReviewTarget({
      requestedWorkspaceId: args.workspaceId,
      hasWorkspaceIdField: "workspaceId" in runData,
      workspaceIdValue: runData.workspaceId,
      userId: runData.userId,
      hasProjectIdField: "projectId" in runData,
      projectIdValue: runData.projectId,
    });
    if (target.kind !== "valid_workspace_review_target") return { status: "run_not_found" };

    const assignmentSnap = await adminDb.collection("runs").doc(args.runId).collection("humanReviewAssignment").doc("current").get();
    if (!assignmentSnap.exists) return { status: "ok", assignment: null, assignmentRevision: 0 };
    const rawAssignment = assignmentSnap.data() as AdaptiveHumanReviewAssignmentV1;
    if (typeof rawAssignment.revision !== "number" || !Number.isInteger(rawAssignment.revision) || rawAssignment.revision < 0) return { status: "read_failed" };
    return { status: "ok", assignment: toDto(rawAssignment), assignmentRevision: rawAssignment.revision };
  } catch (err) {
    logger.warn("[workspaces/workspaceReviewMutations] getWorkspaceReviewAssignment failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { status: "read_failed" };
  }
}

// ============================================
// PUT (create / reassign / same-reviewer dueAt update)
// ============================================

export type PutWorkspaceReviewAssignmentFailureReason =
  | "team_workspaces_disabled"
  | "firestore_unavailable"
  | TeamMutationAuthorizationDenialReason
  | "run_not_found"
  | "active_panel"
  | "panel_unreadable"
  | { kind: "target_not_eligible"; reason: AssignmentTargetIneligibilityReason }
  | "invalid_due_at"
  | "due_at_required_on_reassignment"
  | "stale_revision"
  | "write_failed";

export type PutWorkspaceReviewAssignmentResult =
  | { ok: true; assignment: WorkspaceReviewAssignmentDto }
  | { ok: false; reason: PutWorkspaceReviewAssignmentFailureReason };

export async function putWorkspaceReviewAssignment(args: {
  uid: string;
  workspaceId: string;
  runId: string;
  assignedReviewerUserId: string;
  expectedRevision: number;
  /** `undefined` = omitted from the request body (semantics depend on whether this is a first assignment, same-reviewer update, or reassignment — see module doc). */
  dueAt: string | null | undefined;
  now?: string;
}): Promise<PutWorkspaceReviewAssignmentResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) return { ok: false, reason: "team_workspaces_disabled" };
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };

  const now = args.now ?? new Date().toISOString();

  let transactionResult: (PutWorkspaceReviewAssignmentResult & { ok: true; historyEntry: AdaptiveHumanReviewAssignmentHistoryV1 }) | (PutWorkspaceReviewAssignmentResult & { ok: false });
  try {
    transactionResult = await adminDb.runTransaction(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "reviews.manage" });
      if (!auth.ok) return { ok: false, reason: auth.reason };
      // Assignment management explicitly requires BOTH `reviews.manage` (checked above) AND
      // `research.read` (checked here) — never inferred from `reviews.manage` alone, even
      // though every role holding `reviews.manage` today (owner/admin) also holds
      // `research.read`. Evaluated against the SAME `auth.membership` snapshot the capability
      // check above already used — no second membership lookup, no new authorization window.
      if (!roleHasCapability(auth.membership.role, "research.read")) return { ok: false, reason: "insufficient_capability" as const };

      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) return { ok: false, reason: "run_not_found" as const };
      const runData = runSnap.data() as Record<string, unknown>;
      const target = resolveWorkspaceReviewTarget({
        requestedWorkspaceId: args.workspaceId,
        hasWorkspaceIdField: "workspaceId" in runData,
        workspaceIdValue: runData.workspaceId,
        userId: runData.userId,
        hasProjectIdField: "projectId" in runData,
        projectIdValue: runData.projectId,
      });
      if (target.kind !== "valid_workspace_review_target") return { ok: false, reason: "run_not_found" as const };

      const panelGate = await readPanelGate(tx, runRef, args.runId);
      if (panelGate === "open") return { ok: false, reason: "active_panel" as const };
      if (panelGate === "invalid") return { ok: false, reason: "panel_unreadable" as const };

      const assignmentRef = runRef.collection("humanReviewAssignment").doc("current");
      const assignmentSnap = await tx.get(assignmentRef);
      const current = assignmentSnap.exists ? (assignmentSnap.data() as AdaptiveHumanReviewAssignmentV1) : null;
      const currentRevision = current?.revision ?? 0;
      const isSameReviewer = current?.assignedReviewerUserId === args.assignedReviewerUserId;

      let assigneeCandidate: WorkspaceReviewCandidate | null = null;
      if (!isSameReviewer) {
        const membershipId = computeMembershipId(args.workspaceId, args.assignedReviewerUserId);
        const membershipSnap = await tx.get(adminDb!.collection("workspaceMemberships").doc(membershipId));
        const membership = membershipSnap.exists ? validateMembershipBinding(membershipSnap.data(), { workspaceId: args.workspaceId, uid: args.assignedReviewerUserId }) : null;
        assigneeCandidate = membership ? { uid: membership.uid, workspaceId: membership.workspaceId, role: membership.role, status: membership.status } : null;
        const eligibility = isValidAssignmentTarget({ candidate: assigneeCandidate, runWorkspaceId: args.workspaceId, creatorUid: target.creatorUid });
        if (!eligibility.eligible) return { ok: false, reason: { kind: "target_not_eligible" as const, reason: eligibility.reason } };
      }

      // ---- dueAt resolution (§18-21) — reads only, no write yet. ----
      let resolvedDueAt: string | null;
      if (current === null) {
        // first-ever assignment: omitted -> null, never a default SLA.
        if (args.dueAt === undefined) resolvedDueAt = null;
        else {
          if (args.dueAt !== null && !isCanonicalDueAt(args.dueAt)) return { ok: false, reason: "invalid_due_at" as const };
          resolvedDueAt = args.dueAt;
        }
      } else if (isSameReviewer) {
        if (args.dueAt === undefined) resolvedDueAt = current.dueAt ?? null; // preserve
        else {
          if (args.dueAt !== null && !isCanonicalDueAt(args.dueAt)) return { ok: false, reason: "invalid_due_at" as const };
          resolvedDueAt = args.dueAt;
        }
      } else {
        // reassignment — the old deadline must never silently carry over.
        if (args.dueAt === undefined) return { ok: false, reason: "due_at_required_on_reassignment" as const };
        if (args.dueAt !== null && !isCanonicalDueAt(args.dueAt)) return { ok: false, reason: "invalid_due_at" as const };
        resolvedDueAt = args.dueAt;
      }

      // ---- OCC ----
      if (currentRevision !== args.expectedRevision) return { ok: false, reason: "stale_revision" as const };

      // ---- Writes — every read above has completed. ----
      const workspaceMetadata = { workspaceId: target.workspaceId, projectId: target.projectId, dueAt: resolvedDueAt };
      let nextAssignment: AdaptiveHumanReviewAssignmentV1;
      let historyEntry: AdaptiveHumanReviewAssignmentHistoryV1;

      if (isSameReviewer && current) {
        nextAssignment = buildAdaptiveHumanReviewAssignmentMetadataUpdate({
          current: current as AdaptiveHumanReviewAssignmentV1 & { assignedReviewerUserId: string },
          actorUserId: args.uid,
          now,
          workspaceMetadata,
        });
        historyEntry = buildAdaptiveHumanReviewAssignmentMetadataHistoryEntry({
          teamId: null,
          runId: args.runId,
          reviewerUserId: args.assignedReviewerUserId,
          assignmentRevision: nextAssignment.revision,
          changedAt: now,
          changedByUserId: args.uid,
          workspaceMetadata,
        });
      } else {
        nextAssignment = buildNextAdaptiveHumanReviewAssignment({
          teamId: null,
          runId: args.runId,
          newReviewerUserId: args.assignedReviewerUserId,
          actorUserId: args.uid,
          now,
          currentRevision,
          currentAssignedAt: current?.assignedAt ?? null,
          currentAssignedByUserId: current?.assignedByUserId ?? null,
          workspaceMetadata,
        });
        historyEntry = buildAdaptiveHumanReviewAssignmentHistoryEntry({
          teamId: null,
          runId: args.runId,
          previousReviewerUserId: current?.assignedReviewerUserId ?? null,
          newReviewerUserId: args.assignedReviewerUserId,
          assignmentRevision: nextAssignment.revision,
          changedAt: now,
          changedByUserId: args.uid,
          workspaceMetadata,
        });
      }

      tx.set(assignmentRef, nextAssignment);

      const dto = toDto(nextAssignment);
      if (!dto) {
        // Structurally unreachable — this branch always assigns a reviewer.
        return { ok: false, reason: "write_failed" as const };
      }
      return { ok: true, assignment: dto, historyEntry };
    });
  } catch (err) {
    logger.warn("[workspaces/workspaceReviewMutations] putWorkspaceReviewAssignment transaction failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "write_failed" };
  }

  if (!transactionResult.ok) return transactionResult;

  // ---- Best-effort, post-commit, append-only history — exactly the
  // legacy assignment route's own established composition. ----
  try {
    const historyResult = await createAdaptiveHumanReviewAssignmentHistory(args.runId, transactionResult.historyEntry);
    if (historyResult.status === "failed") {
      logger.warn("[workspaces/workspaceReviewMutations] Assignment-history write did not save after a successful mutation", { workspaceId: args.workspaceId, runId: args.runId });
    }
  } catch {
    logger.warn("[workspaces/workspaceReviewMutations] Assignment-history write threw after a successful mutation", { workspaceId: args.workspaceId, runId: args.runId });
  }

  return { ok: true, assignment: transactionResult.assignment };
}

// ============================================
// DELETE (unassign)
// ============================================

export type DeleteWorkspaceReviewAssignmentFailureReason =
  | "team_workspaces_disabled"
  | "firestore_unavailable"
  | TeamMutationAuthorizationDenialReason
  | "run_not_found"
  | "active_panel"
  | "panel_unreadable"
  | "stale_revision"
  | "write_failed";

export type DeleteWorkspaceReviewAssignmentResult = { ok: true } | { ok: false; reason: DeleteWorkspaceReviewAssignmentFailureReason };

export async function deleteWorkspaceReviewAssignment(args: { uid: string; workspaceId: string; runId: string; expectedRevision: number; now?: string }): Promise<DeleteWorkspaceReviewAssignmentResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) return { ok: false, reason: "team_workspaces_disabled" };
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };

  const now = args.now ?? new Date().toISOString();

  let transactionResult: { ok: true; historyEntry: AdaptiveHumanReviewAssignmentHistoryV1 } | { ok: false; reason: DeleteWorkspaceReviewAssignmentFailureReason };
  try {
    transactionResult = await adminDb.runTransaction(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "reviews.manage" });
      if (!auth.ok) return { ok: false, reason: auth.reason };
      // Same explicit dual-capability requirement as putWorkspaceReviewAssignment — see the
      // comment there. Same `auth.membership` snapshot, no second lookup.
      if (!roleHasCapability(auth.membership.role, "research.read")) return { ok: false, reason: "insufficient_capability" as const };

      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) return { ok: false, reason: "run_not_found" as const };
      const runData = runSnap.data() as Record<string, unknown>;
      const target = resolveWorkspaceReviewTarget({
        requestedWorkspaceId: args.workspaceId,
        hasWorkspaceIdField: "workspaceId" in runData,
        workspaceIdValue: runData.workspaceId,
        userId: runData.userId,
        hasProjectIdField: "projectId" in runData,
        projectIdValue: runData.projectId,
      });
      if (target.kind !== "valid_workspace_review_target") return { ok: false, reason: "run_not_found" as const };

      const panelGate = await readPanelGate(tx, runRef, args.runId);
      if (panelGate === "open") return { ok: false, reason: "active_panel" as const };
      if (panelGate === "invalid") return { ok: false, reason: "panel_unreadable" as const };

      const assignmentRef = runRef.collection("humanReviewAssignment").doc("current");
      const assignmentSnap = await tx.get(assignmentRef);
      const current = assignmentSnap.exists ? (assignmentSnap.data() as AdaptiveHumanReviewAssignmentV1) : null;
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== args.expectedRevision) return { ok: false, reason: "stale_revision" as const };

      const nextAssignment = buildNextAdaptiveHumanReviewAssignment({
        teamId: null,
        runId: args.runId,
        newReviewerUserId: null,
        actorUserId: args.uid,
        now,
        currentRevision,
        currentAssignedAt: current?.assignedAt ?? null,
        currentAssignedByUserId: current?.assignedByUserId ?? null,
        workspaceMetadata: { workspaceId: target.workspaceId, projectId: target.projectId, dueAt: null },
      });
      const historyEntry = buildAdaptiveHumanReviewAssignmentHistoryEntry({
        teamId: null,
        runId: args.runId,
        previousReviewerUserId: current?.assignedReviewerUserId ?? null,
        newReviewerUserId: null,
        assignmentRevision: nextAssignment.revision,
        changedAt: now,
        changedByUserId: args.uid,
        workspaceMetadata: { workspaceId: target.workspaceId, projectId: target.projectId, dueAt: null },
      });

      tx.set(assignmentRef, nextAssignment);
      return { ok: true, historyEntry };
    });
  } catch (err) {
    logger.warn("[workspaces/workspaceReviewMutations] deleteWorkspaceReviewAssignment transaction failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "write_failed" };
  }

  if (!transactionResult.ok) return transactionResult;

  try {
    const historyResult = await createAdaptiveHumanReviewAssignmentHistory(args.runId, transactionResult.historyEntry);
    if (historyResult.status === "failed") {
      logger.warn("[workspaces/workspaceReviewMutations] Assignment-history write did not save after a successful removal", { workspaceId: args.workspaceId, runId: args.runId });
    }
  } catch {
    logger.warn("[workspaces/workspaceReviewMutations] Assignment-history write threw after a successful removal", { workspaceId: args.workspaceId, runId: args.runId });
  }

  return { ok: true };
}

// ============================================
// POST review-decision (ordinary, non-panel)
// ============================================

export type SubmitWorkspaceReviewDecisionFailureReason =
  | "team_workspaces_disabled"
  | "firestore_unavailable"
  | TeamMutationAuthorizationDenialReason
  | "run_not_found"
  | "active_panel"
  | "panel_unreadable"
  | "governance_record_absent"
  | "governance_record_malformed"
  | "unsupported_version"
  | "stale_expected_updated_at"
  | "not_reviewable"
  | { kind: "not_authorized"; reason: OrdinaryReviewerAuthorizationDenialReason }
  | "review_content_unavailable"
  | "write_failed";

export type SubmitWorkspaceReviewDecisionResult =
  | { ok: true; status: AdaptiveReviewDecisionStatus; reviewedAt: string }
  | { ok: false; reason: SubmitWorkspaceReviewDecisionFailureReason };

export async function submitWorkspaceReviewDecision(args: {
  uid: string;
  workspaceId: string;
  runId: string;
  update: { status: AdaptiveReviewDecisionStatus; comment?: string; conditions?: string[] };
  expectedUpdatedAt: string;
  now?: string;
}): Promise<SubmitWorkspaceReviewDecisionResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) return { ok: false, reason: "team_workspaces_disabled" };
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };

  const now = args.now ?? new Date().toISOString();

  type Committed = { record: GovernanceRecordV1; priorStatus: GovernanceRecordV1["humanReview"]["status"] };
  let transactionResult: { ok: true } & Committed | { ok: false; reason: SubmitWorkspaceReviewDecisionFailureReason };
  try {
    transactionResult = await adminDb.runTransaction(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "reviews.submit" });
      if (!auth.ok) return { ok: false, reason: auth.reason };

      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) return { ok: false, reason: "run_not_found" as const };
      const runData = runSnap.data() as Record<string, unknown>;
      const target = resolveWorkspaceReviewTarget({
        requestedWorkspaceId: args.workspaceId,
        hasWorkspaceIdField: "workspaceId" in runData,
        workspaceIdValue: runData.workspaceId,
        userId: runData.userId,
        hasProjectIdField: "projectId" in runData,
        projectIdValue: runData.projectId,
      });
      if (target.kind !== "valid_workspace_review_target") return { ok: false, reason: "run_not_found" as const };

      const panelGate = await readPanelGate(tx, runRef, args.runId);
      if (panelGate === "open") return { ok: false, reason: "active_panel" as const };
      if (panelGate === "invalid") return { ok: false, reason: "panel_unreadable" as const };

      const parsed = parseGovernanceRecord(runData.governanceRecord);
      if (!parsed.ok) {
        if (parsed.reason === "absent") return { ok: false, reason: "governance_record_absent" as const };
        if (parsed.reason === "unsupported_version") return { ok: false, reason: "unsupported_version" as const };
        return { ok: false, reason: "governance_record_malformed" as const };
      }
      const record = parsed.record;

      // OCC BEFORE status — never masked by a terminal-status error the
      // caller's own UI hasn't seen yet, matching submitAdaptiveHumanReview()'s
      // own established ordering.
      if (record.updatedAt !== args.expectedUpdatedAt) return { ok: false, reason: "stale_expected_updated_at" as const };
      if (!isHumanReviewStatusReviewable(record.humanReview.status)) return { ok: false, reason: "not_reviewable" as const };

      const assignmentSnap = await tx.get(runRef.collection("humanReviewAssignment").doc("current"));
      const assignment = assignmentSnap.exists ? (assignmentSnap.data() as AdaptiveHumanReviewAssignmentV1) : null;
      const hasCanonicalAssignment = assignment?.assignedReviewerUserId === args.uid;

      const reviewerCandidate: WorkspaceReviewCandidate = { uid: args.uid, workspaceId: args.workspaceId, role: auth.membership.role, status: auth.membership.status };
      const authz = isOrdinaryReviewerAuthorized({ reviewer: reviewerCandidate, runWorkspaceId: args.workspaceId, creatorUid: target.creatorUid, hasCanonicalAssignment });
      if (!authz.authorized) return { ok: false, reason: { kind: "not_authorized" as const, reason: authz.reason } };

      // Team Workspace Boundary Hardening, backend correction (10C.4A-U2B)
      // — canonical governance-state integrity, independent of and in
      // addition to the UI safeguard. Checked LAST, only after every
      // identity/authorization/OCC check above has already succeeded, so
      // this can never become an authorization oracle for a caller who
      // isn't otherwise entitled to decide on this run. Reads
      // `record.decisionReceipt` already loaded above — zero additional
      // Firestore reads, and evaluated against the SAME transactionally-
      // read `governanceRecord`, so a receipt that changes between page
      // load and submission is caught here, not merely at the client.
      if (!isSubstantiveDecisionReceiptConclusion(record.decisionReceipt.conclusion)) {
        return { ok: false, reason: "review_content_unavailable" as const };
      }

      const priorStatus = record.humanReview.status;
      const updateResult = applyHumanReviewUpdate(record, { status: args.update.status, comment: args.update.comment, conditions: args.update.conditions, reviewedAt: now, reviewerId: args.uid }, now);
      if (!updateResult.ok) return { ok: false, reason: "write_failed" as const };

      tx.update(runRef, { "governanceRecord.humanReview": updateResult.record.humanReview, "governanceRecord.updatedAt": now });

      return { ok: true, record: updateResult.record, priorStatus };
    });
  } catch (err) {
    logger.warn("[workspaces/workspaceReviewMutations] submitWorkspaceReviewDecision transaction failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "write_failed" };
  }

  if (!transactionResult.ok) return transactionResult;

  const { record, priorStatus } = transactionResult;
  const newStatus = record.humanReview.status;

  // ---- Best-effort, post-commit — reusing the mature, existing
  // Workspace-agnostic writers exactly as the legacy decision route
  // already composes them (§32/§33). ----
  try {
    const eventOutcome = await writeAdaptiveHumanReviewEvent({ runId: args.runId, teamId: null, schemaId: record.schemaId, answerShape: record.answerShape, reviewerId: args.uid, prevStatus: priorStatus, nextStatus: newStatus, at: now });
    if (!eventOutcome.written) {
      logger.warn("[workspaces/workspaceReviewMutations] Governance event did not save after a successful review", { workspaceId: args.workspaceId, runId: args.runId });
    }
  } catch {
    logger.warn("[workspaces/workspaceReviewMutations] Governance event write threw after a successful review", { workspaceId: args.workspaceId, runId: args.runId });
  }

  if (isAdaptiveReviewTerminalStatus(newStatus)) {
    const priorStatusForHistory = isAdaptiveReviewNonTerminalStatus(priorStatus) ? priorStatus : "unreviewed";
    try {
      const decisionId = buildWorkspaceReviewDecisionId(args.workspaceId, args.runId, now, newStatus);
      const historyEntry = buildAdaptiveHumanReviewHistoryEntry({
        decisionId,
        runId: args.runId,
        teamId: null,
        schemaId: record.schemaId as PersistedAdaptiveSchemaId,
        answerShape: record.answerShape,
        priorStatus: priorStatusForHistory,
        newStatus,
        reviewerId: args.uid,
        reviewedAt: now,
        governanceRecordUpdatedAt: record.updatedAt,
        comment: args.update.comment,
        conditions: args.update.conditions,
        now,
      });
      const historyResult = await createAdaptiveHumanReviewHistory(args.runId, historyEntry);
      if (historyResult.status === "failed") {
        logger.warn("[workspaces/workspaceReviewMutations] Immutable review-history write did not save after a successful review", { workspaceId: args.workspaceId, runId: args.runId });
      }
      const auditResult = await writeAdaptiveAdminAuditEvent({ decisionId, actorUid: args.uid, teamId: null, runId: args.runId, schemaId: record.schemaId, answerShape: record.answerShape, priorStatus: priorStatusForHistory, newStatus, reviewedAt: now });
      if (auditResult.status === "failed") {
        logger.warn("[workspaces/workspaceReviewMutations] Admin audit write did not save after a successful review", { workspaceId: args.workspaceId, runId: args.runId });
      }
    } catch {
      logger.warn("[workspaces/workspaceReviewMutations] History/audit write threw after a successful review", { workspaceId: args.workspaceId, runId: args.runId });
    }
  }

  return { ok: true, status: newStatus as AdaptiveReviewDecisionStatus, reviewedAt: now };
}
