/**
 * Order B, Stage B2 (owner-authorized 2026-11-03): the report-review DECISION writer.
 *
 * One Firestore transaction, all reads before writes:
 *   admission (compile-time REPORT_REVIEW_ENABLED + Team Workspaces) → membership with `reviews.submit` (+ research.read)
 *   → run bound to THIS Workspace → no open panel → a valid reportReview and NO governanceRecord (fail closed) →
 *   OCC on cycle and updatedAt → the shared decision contract (lib/governance/reportReviewDecision.ts: current
 *   canonical assignment for the current cycle, not the run creator, not the submitter, cycle open) → writes.
 *
 * Writes, atomically in the same transaction:
 *   - `reportReview.humanReview` = { status, reviewerId, reviewedAt, comment?, conditions? } and `reportReview.updatedAt`;
 *   - one write-once audit event `runs/{R}/reportReviewEvents/{id}` (type `report_review_decided`) carrying the cycle,
 *     prior and new status, reviewer, timestamp and purpose. Durable by construction: if the event cannot be written,
 *     the decision is not written either.
 *
 * Idempotent retry: if the cycle is already decided by THIS caller with THIS status (a retry after a lost response),
 * the current decision is returned with `replayed: true` and nothing is written. Any other decided state is refused.
 * Previous cycles live in write-once archives (B1) and are never touched here.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { REPORT_REVIEW_ENABLED } from "./reportReviewRollout";
import { resolveTeamWorkspaceTargetAdmission } from "./teamWorkspaceTargetAdmission";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "./authorizeTeamWorkspaceMutationInTransaction";
import { resolveWorkspaceReviewTarget } from "./resolveWorkspaceReviewTarget";
import { roleHasCapability } from "./capabilities";
import { readPanelGate } from "./workspaceReviewMutations";
import { REPORT_REVIEW_EVENTS_COLLECTION } from "./reportReviewCollections";
import { runQuestionSnapshot, writeReportReviewWorkspaceAuditEvent } from "./reportReviewWorkspaceAudit";
import type { WorkspaceReviewCandidate } from "./workspaceReviewEligibility";
import { isReportReviewDecided, parseReportReviewRecord, type ReportReviewHumanReview, type ReportReviewRecordV1 } from "@/lib/governance/reportReview";
import { evaluateReportReviewDecisionAuthority, validateDecisionUpdate, type ReportReviewDecisionDenial } from "@/lib/governance/reportReviewDecision";

export type DecideReportReviewFailure =
  | { ok: false; reason: "disabled" | "team_workspaces_disabled" | "firestore_unavailable" | "write_failed" }
  | { ok: false; reason: TeamMutationAuthorizationDenialReason | "insufficient_capability" }
  | { ok: false; reason: "run_not_found" | "active_panel" | "panel_unreadable" | "record_malformed" | "integrity_violation" }
  | { ok: false; reason: "invalid_decision" | "conditions_required" | "cycle_conflict" | "stale_expected_updated_at" | "decision_conflict" }
  | { ok: false; reason: "not_authorized"; denial: ReportReviewDecisionDenial };

export type DecideReportReviewResult = { ok: true; replayed: boolean; record: ReportReviewRecordV1 } | DecideReportReviewFailure;

export async function decideReportReview(args: {
  uid: string;
  workspaceId: string;
  runId: string;
  decision: unknown;
  expectedCycle: number;
  expectedUpdatedAt: string;
  now?: string;
}): Promise<DecideReportReviewResult> {
  if (!REPORT_REVIEW_ENABLED) return { ok: false, reason: "disabled" };
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) return { ok: false, reason: "team_workspaces_disabled" };
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };
  const decision = validateDecisionUpdate(args.decision);
  if (!decision.ok) return { ok: false, reason: decision.reason };
  const now = args.now ?? new Date().toISOString();

  try {
    return await adminDb.runTransaction<DecideReportReviewResult>(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "reviews.submit" });
      if (!auth.ok) return { ok: false, reason: auth.reason };
      if (!roleHasCapability(auth.membership.role, "research.read")) return { ok: false, reason: "insufficient_capability" };

      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) return { ok: false, reason: "run_not_found" };
      const run = runSnap.data() as Record<string, unknown>;
      const target = resolveWorkspaceReviewTarget({
        requestedWorkspaceId: args.workspaceId,
        hasWorkspaceIdField: "workspaceId" in run,
        workspaceIdValue: run.workspaceId,
        userId: run.userId,
        hasProjectIdField: "projectId" in run,
        projectIdValue: run.projectId,
      });
      if (target.kind !== "valid_workspace_review_target") return { ok: false, reason: "run_not_found" };

      const panelGate = await readPanelGate(tx, runRef, args.runId);
      if (panelGate === "open") return { ok: false, reason: "active_panel" };
      if (panelGate === "invalid") return { ok: false, reason: "panel_unreadable" };

      const parsed = parseReportReviewRecord(run.reportReview);
      if (!parsed.ok) return parsed.reason === "absent" ? { ok: false, reason: "run_not_found" } : { ok: false, reason: "record_malformed" };
      if (run.governanceRecord !== undefined && run.governanceRecord !== null) return { ok: false, reason: "integrity_violation" }; // never both
      const record = parsed.record;

      const assignmentSnap = await tx.get(runRef.collection("humanReviewAssignment").doc("current"));
      const assignment = assignmentSnap.exists ? (assignmentSnap.data() as { assignedReviewerUserId?: unknown; cycle?: unknown }) : null;

      // OCC first, so a caller never learns a status it has not seen through a stale page.
      if (record.cycle !== args.expectedCycle) return { ok: false, reason: "cycle_conflict" };

      // Idempotent replay: the same reviewer already recorded the same decision on this cycle.
      const hr = record.humanReview;
      if (isReportReviewDecided(record) && hr.reviewerId === args.uid && hr.status === decision.update.status) {
        // A replay must be the SAME decision: same comment and same conditions. Anything else is a conflict, never a
        // silent "success" that drops the caller's new text.
        const sameComment = (hr.comment ?? null) === decision.update.comment;
        const sameConditions = JSON.stringify(hr.conditions ?? null) === JSON.stringify(decision.update.conditions);
        if (sameComment && sameConditions) return { ok: true, replayed: true, record };
        return { ok: false, reason: "decision_conflict" };
      }
      if (record.updatedAt !== args.expectedUpdatedAt) return { ok: false, reason: "stale_expected_updated_at" };

      const reviewer: WorkspaceReviewCandidate = { uid: args.uid, workspaceId: auth.membership.workspaceId, role: auth.membership.role, status: auth.membership.status };
      const authority = evaluateReportReviewDecisionAuthority({ reviewer, workspaceId: args.workspaceId, creatorUid: target.creatorUid, record, assignment });
      if (!authority.authorized) return { ok: false, reason: "not_authorized", denial: authority.reason };

      // ---- writes ----
      const humanReview: ReportReviewHumanReview = { status: decision.update.status, reviewerId: args.uid, reviewedAt: now };
      if (decision.update.comment !== null) humanReview.comment = decision.update.comment;
      if (decision.update.conditions !== null) humanReview.conditions = decision.update.conditions;
      tx.update(runRef, { "reportReview.humanReview": humanReview, "reportReview.updatedAt": now });
      tx.create(runRef.collection(REPORT_REVIEW_EVENTS_COLLECTION).doc(), {
        version: 1,
        type: "report_review_decided",
        runId: args.runId,
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        actorUid: args.uid,
        cycle: record.cycle,
        priorStatus: hr.status,
        status: decision.update.status,
        purposeCode: record.purpose.code,
        hasComment: decision.update.comment !== null,
        conditionsCount: decision.update.conditions?.length ?? 0,
        at: now,
      });
      // B3: the Workspace Audit row for the decision, which also closes the cycle (decision committed iff row committed).
      writeReportReviewWorkspaceAuditEvent(
        tx,
        { eventType: "workspace_report_review_decided", actorUid: args.uid, workspaceId: target.workspaceId, projectId: target.projectId, runId: args.runId, runQuestion: runQuestionSnapshot(run), cycle: record.cycle, priorStatus: hr.status, status: decision.update.status, purposeCode: record.purpose.code },
        now
      );
      return { ok: true, replayed: false, record: { ...record, humanReview, updatedAt: now } };
    });
  } catch (err) {
    logger.warn("[workspaces/reportReviewDecisionMutation] decideReportReview transaction failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "write_failed" };
  }
}
