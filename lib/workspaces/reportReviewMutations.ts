/**
 * Order B, Stage B1 (owner-authorized 2026-11-02): the ONLY writers of Report Review state.
 * Design contract: docs/workspaces/approval-b-report-review-design.md (rev 5) §3, §4, §5a.
 *
 *   submitReportReview   — explicit submission (D-B2). Creates `runs/{R}.reportReview` cycle 1.
 *   resubmitReportReview — D-B6: after a DECIDED cycle, archives it write-once and starts cycle n+1.
 *
 * Every decision is made inside ONE Firestore transaction from documents read in that transaction:
 *   admission (REPORT_REVIEW_ENABLED compile-time switch + Team Workspaces) → membership + `research.organize` + `research.read`
 *   (D-B3a; Reviewer/Viewer never) → run bound to THIS Workspace → no open review panel → eligibility
 *   (`evaluateReportReviewEligibility`, the D-B7 option (a) exclusion rule) → writes.
 *
 * Write-once history: archived cycles (`runs/{R}/reportReviewCycles/{n}`) and events (`runs/{R}/reportReviewEvents/{id}`)
 * are written ONLY here and ONLY with `tx.create()`, which fails the whole transaction if the document already exists.
 * No code path updates or deletes them (pinned by reportReviewArchiveImmutability.spec.ts). Clients cannot write them
 * at all: firestore.rules has no `runs` match, so every client read/write is denied.
 *
 * This module never reads or writes `governanceRecord`, `adaptiveOutput` or any governed-review document, and the
 * governed-run writer (lib/runPanelExecution.ts / lib/firestore/runs.ts) is unchanged.
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
import { createAdaptiveHumanReviewAssignmentHistory } from "@/lib/firestore/runs";
import { buildAdaptiveHumanReviewAssignmentHistoryEntry, type AdaptiveHumanReviewAssignmentHistoryV1 } from "@/lib/governance/adaptiveHumanReviewAssignment";
import {
  buildReportReviewCycleArchive,
  buildReportReviewRecord,
  evaluateReportReviewEligibility,
  isReportReviewDecided,
  parseReportReviewRecord,
  validateReportReviewPurpose,
  type ReportReviewEventV1,
  type ReportReviewIneligibleReason,
  type ReportReviewRecordV1,
} from "@/lib/governance/reportReview";

import { REPORT_REVIEW_CYCLES_COLLECTION, REPORT_REVIEW_EVENTS_COLLECTION } from "./reportReviewCollections";
import { runQuestionSnapshot, writeReportReviewWorkspaceAuditEvent } from "./reportReviewWorkspaceAudit";
export { REPORT_REVIEW_CYCLES_COLLECTION, REPORT_REVIEW_EVENTS_COLLECTION };

export type ReportReviewMutationFailure =
  | { ok: false; reason: "disabled" | "team_workspaces_disabled" | "firestore_unavailable" | "write_failed" }
  | { ok: false; reason: TeamMutationAuthorizationDenialReason | "insufficient_capability" }
  | { ok: false; reason: "run_not_found" | "active_panel" | "panel_unreadable" | "invalid_purpose" }
  | { ok: false; reason: "ineligible"; ineligible: ReportReviewIneligibleReason }
  | { ok: false; reason: "not_decided" | "cycle_conflict" | "record_malformed" };

export type SubmitReportReviewResult = { ok: true; created: boolean; record: ReportReviewRecordV1 } | ReportReviewMutationFailure;
export type ResubmitReportReviewResult = { ok: true; record: ReportReviewRecordV1; archivedCycle: number } | ReportReviewMutationFailure;
type ResubmitTxResult = { ok: true; record: ReportReviewRecordV1; archivedCycle: number; historyEntry: AdaptiveHumanReviewAssignmentHistoryV1 | null } | ReportReviewMutationFailure;

type Gate = { ok: true } | { ok: false; reason: "disabled" | "team_workspaces_disabled" | "firestore_unavailable" };

function admissionGate(uid: string, workspaceId: string): Gate {
  if (!REPORT_REVIEW_ENABLED) return { ok: false, reason: "disabled" };
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid,
    workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) return { ok: false, reason: "team_workspaces_disabled" };
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };
  return { ok: true };
}

/** Shared in-transaction prelude: authority, run binding and panel gate. Reads only. */
async function authorizeAndReadRun(tx: FirebaseFirestore.Transaction, args: { uid: string; workspaceId: string; runId: string }) {
  // D-B3a: active member holding `research.organize` (checked by the shared authorizer) AND `research.read`.
  const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "research.organize" });
  if (!auth.ok) return { ok: false as const, reason: auth.reason };
  if (!roleHasCapability(auth.membership.role, "research.read")) return { ok: false as const, reason: "insufficient_capability" as const };

  const runRef = adminDb!.collection("runs").doc(args.runId);
  const runSnap = await tx.get(runRef);
  if (!runSnap.exists) return { ok: false as const, reason: "run_not_found" as const };
  const run = runSnap.data() as Record<string, unknown>;
  const target = resolveWorkspaceReviewTarget({
    requestedWorkspaceId: args.workspaceId,
    hasWorkspaceIdField: "workspaceId" in run,
    workspaceIdValue: run.workspaceId,
    userId: run.userId,
    hasProjectIdField: "projectId" in run,
    projectIdValue: run.projectId,
  });
  if (target.kind !== "valid_workspace_review_target") return { ok: false as const, reason: "run_not_found" as const };

  const panelGate = await readPanelGate(tx, runRef, args.runId);
  if (panelGate === "open") return { ok: false as const, reason: "active_panel" as const };
  if (panelGate === "invalid") return { ok: false as const, reason: "panel_unreadable" as const };

  return { ok: true as const, runRef, run, workspaceId: target.workspaceId, projectId: target.projectId };
}

function eventDoc(args: Omit<ReportReviewEventV1, "version">): ReportReviewEventV1 {
  return { version: 1, ...args };
}

/**
 * Explicit submission (D-B2). Idempotent: if this run's report review is already open, nothing is written and the
 * current record is returned with `created: false` (a retry after a lost response is therefore safe).
 */
export async function submitReportReview(args: { uid: string; workspaceId: string; runId: string; purpose: unknown; now?: string }): Promise<SubmitReportReviewResult> {
  const gate = admissionGate(args.uid, args.workspaceId);
  if (!gate.ok) return gate;
  const purpose = validateReportReviewPurpose(args.purpose);
  if (!purpose.ok) return { ok: false, reason: "invalid_purpose" };
  const now = args.now ?? new Date().toISOString();

  try {
    return await adminDb!.runTransaction<SubmitReportReviewResult>(async (tx) => {
      const pre = await authorizeAndReadRun(tx, args);
      if (!pre.ok) return pre;

      const eligibility = evaluateReportReviewEligibility(pre.run);
      if (!eligibility.eligible) {
        if (eligibility.reason === "already_submitted") {
          const existing = parseReportReviewRecord(pre.run.reportReview);
          if (existing.ok) return { ok: true, created: false, record: existing.record };
          return { ok: false, reason: "record_malformed" };
        }
        return { ok: false, reason: "ineligible", ineligible: eligibility.reason };
      }

      const record = buildReportReviewRecord({ cycle: 1, scope: eligibility.scope, purpose: purpose.purpose, actorUid: args.uid, now });
      tx.update(pre.runRef, { reportReview: record });
      tx.create(
        pre.runRef.collection(REPORT_REVIEW_EVENTS_COLLECTION).doc(),
        eventDoc({ type: "report_review_submitted", runId: args.runId, workspaceId: pre.workspaceId, projectId: pre.projectId, actorUid: args.uid, fromCycle: null, toCycle: 1, purposeCode: record.purpose.code, at: now })
      );
      // B3: the Workspace Audit Log row, in this same transaction (submission committed iff audit row committed).
      writeReportReviewWorkspaceAuditEvent(
        tx,
        { eventType: "workspace_report_review_submitted", actorUid: args.uid, workspaceId: pre.workspaceId, projectId: pre.projectId, runId: args.runId, runQuestion: runQuestionSnapshot(pre.run), cycle: 1, purposeCode: record.purpose.code },
        now
      );
      return { ok: true, created: true, record };
    });
  } catch (err) {
    logger.warn("[workspaces/reportReviewMutations] submitReportReview transaction failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "write_failed" };
  }
}

/**
 * D-B6: resubmission after a DECIDED cycle starts a new cycle. It never resets a decision in place.
 *   - `expectedCycle` must equal the current cycle (otherwise `cycle_conflict`; concurrent resubmits cannot both win).
 *   - The decided cycle and its assignment are archived with `tx.create()` at `reportReviewCycles/{cycle}`: if that
 *     archive already exists the transaction fails, so history can never be overwritten.
 *   - The new cycle starts `unreviewed`; the assignment document is reset to unassigned for the new cycle
 *     (`source: "cycle_reset"`), so no reviewer is carried over silently. The reset is recorded in the shared
 *     assignment history (best-effort, post-commit, exactly like every other assignment writer).
 *   - Ownership rule: an assignment made after the decision but before resubmission belongs to the DECIDED cycle; it is
 *     archived with that cycle (a concurrent assignment makes this transaction retry on the new state) and then reset.
 *   - The run must still pass the exclusion rule (no governance record can have appeared).
 */
export async function resubmitReportReview(args: { uid: string; workspaceId: string; runId: string; purpose: unknown; expectedCycle: unknown; now?: string }): Promise<ResubmitReportReviewResult> {
  const gate = admissionGate(args.uid, args.workspaceId);
  if (!gate.ok) return gate;
  const purpose = validateReportReviewPurpose(args.purpose);
  if (!purpose.ok) return { ok: false, reason: "invalid_purpose" };
  if (typeof args.expectedCycle !== "number" || !Number.isInteger(args.expectedCycle) || args.expectedCycle < 1) return { ok: false, reason: "cycle_conflict" };
  const expectedCycle = args.expectedCycle;
  const now = args.now ?? new Date().toISOString();

  try {
    const txResult = await adminDb!.runTransaction<ResubmitTxResult>(async (tx) => {
      const pre = await authorizeAndReadRun(tx, args);
      if (!pre.ok) return pre;

      const current = parseReportReviewRecord(pre.run.reportReview);
      if (!current.ok) return current.reason === "absent" ? { ok: false, reason: "ineligible", ineligible: "no_review_information" } : { ok: false, reason: "record_malformed" };
      if (current.record.cycle !== expectedCycle) return { ok: false, reason: "cycle_conflict" };
      if (!isReportReviewDecided(current.record)) return { ok: false, reason: "not_decided" };

      // The exclusion rule must still hold (evaluated as if no report review existed yet).
      const { reportReview: _ignored, ...withoutReportReview } = pre.run;
      void _ignored;
      const eligibility = evaluateReportReviewEligibility(withoutReportReview);
      if (!eligibility.eligible) return { ok: false, reason: "ineligible", ineligible: eligibility.reason };

      const assignmentRef = pre.runRef.collection("humanReviewAssignment").doc("current");
      const assignmentSnap = await tx.get(assignmentRef);
      const assignment = assignmentSnap.exists ? (assignmentSnap.data() as Record<string, unknown>) : null;
      const currentRevision = typeof assignment?.revision === "number" ? assignment.revision : 0;

      // ---- writes (all reads done) ----
      tx.create(
        pre.runRef.collection(REPORT_REVIEW_CYCLES_COLLECTION).doc(String(current.record.cycle)),
        buildReportReviewCycleArchive({ runId: args.runId, record: current.record, assignment, actorUid: args.uid, now })
      );
      const next = buildReportReviewRecord({ cycle: current.record.cycle + 1, scope: eligibility.scope, purpose: purpose.purpose, actorUid: args.uid, now });
      tx.update(pre.runRef, { reportReview: next });
      tx.set(assignmentRef, {
        schemaVersion: 1,
        teamId: null,
        runId: args.runId,
        assignedReviewerUserId: null,
        assignedAt: null,
        assignedByUserId: null,
        updatedAt: now,
        updatedByUserId: args.uid,
        revision: currentRevision + 1,
        workspaceId: pre.workspaceId,
        projectId: pre.projectId,
        dueAt: null,
        cycle: next.cycle,
        source: "cycle_reset",
      });
      tx.create(
        pre.runRef.collection(REPORT_REVIEW_EVENTS_COLLECTION).doc(),
        eventDoc({ type: "report_review_resubmitted", runId: args.runId, workspaceId: pre.workspaceId, projectId: pre.projectId, actorUid: args.uid, fromCycle: current.record.cycle, toCycle: next.cycle, purposeCode: next.purpose.code, at: now })
      );
      const previousReviewerUserId = typeof assignment?.assignedReviewerUserId === "string" ? assignment.assignedReviewerUserId : null;
      // B3: one Workspace Audit row records the archive of the decided cycle, the new cycle, and the reviewer reset.
      writeReportReviewWorkspaceAuditEvent(
        tx,
        {
          eventType: "workspace_report_review_resubmitted",
          actorUid: args.uid,
          workspaceId: pre.workspaceId,
          projectId: pre.projectId,
          runId: args.runId,
          runQuestion: runQuestionSnapshot(pre.run),
          cycle: next.cycle,
          fromCycle: current.record.cycle,
          purposeCode: next.purpose.code,
          clearedReviewerUid: previousReviewerUserId,
        },
        now
      );
      // History only when a reviewer is actually removed (no no-op "unassigned" entries).
      const historyEntry =
        assignment === null || previousReviewerUserId === null
          ? null
          : buildAdaptiveHumanReviewAssignmentHistoryEntry({
              teamId: null,
              runId: args.runId,
              previousReviewerUserId,
              newReviewerUserId: null,
              assignmentRevision: currentRevision + 1,
              changedAt: now,
              changedByUserId: args.uid,
              workspaceMetadata: { workspaceId: pre.workspaceId, projectId: pre.projectId, dueAt: null },
            });
      return { ok: true, record: next, archivedCycle: current.record.cycle, historyEntry };
    });
    if (!txResult.ok) return txResult;
    if (txResult.historyEntry) {
      try {
        const h = await createAdaptiveHumanReviewAssignmentHistory(args.runId, txResult.historyEntry);
        if (h.status === "failed") logger.warn("[workspaces/reportReviewMutations] cycle-reset assignment history did not save", { workspaceId: args.workspaceId, runId: args.runId });
      } catch {
        logger.warn("[workspaces/reportReviewMutations] cycle-reset assignment history threw", { workspaceId: args.workspaceId, runId: args.runId });
      }
    }
    return { ok: true, record: txResult.record, archivedCycle: txResult.archivedCycle };
  } catch (err) {
    logger.warn("[workspaces/reportReviewMutations] resubmitReportReview transaction failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "write_failed" };
  }
}
