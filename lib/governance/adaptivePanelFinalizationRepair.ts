/**
 * Transactional Multi-Reviewer Finalization, Part E (§E16) — internal,
 * idempotent repair service for the secondary artifacts of an ALREADY
 * finalized panel. Not exposed via any route or UI button — this codebase
 * has no established protected public-repair pattern to reuse (confirmed
 * by the same precedent the existing single-reviewer repair services
 * already follow). Never changes canonical `governanceRecord.humanReview`,
 * never changes `panel.finalStatus`, never reopens a panel, never modifies
 * a vote.
 *
 * FAIL-CLOSED ON DISAGREEMENT: if the canonical `humanReview` and the
 * finalized panel do not agree with each other (wrong status, wrong
 * `decidedVia`, wrong `panelRevision` correlation, or `humanReview` still
 * reviewable despite the panel claiming finalized), this function refuses
 * to repair anything and reports the inconsistency — it never guesses
 * which side is "right."
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { parseGovernanceRecord, isHumanReviewStatusReviewable } from "@/lib/adaptiveSchema/governanceRecordParser";
import { PersistedAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";
import {
  getAdaptiveHumanReviewPanel,
  getAdaptiveHumanReviewVote,
  createAdaptiveHumanReviewHistory,
  createAdaptivePanelFinalizationHistory,
  writeAdaptivePanelFinalizationGovernanceEvent,
} from "@/lib/firestore/runs";
import { syncAdaptiveTeamRunProjectionAfterReview } from "@/lib/firestore/teamRuns";
import { writeAdaptivePanelFinalizationAdminAuditEvent } from "@/lib/governance/auditLog";
import { buildAdaptiveHumanReviewHistoryEntry } from "@/lib/governance/adaptiveHumanReviewHistory";
import { buildAdaptivePanelFinalizationHistoryEntry } from "@/lib/governance/adaptivePanelFinalization";

export type RepairAdaptivePanelFinalizationArtifactsResult =
  | { status: "firestore_unavailable" }
  | { status: "run_missing" }
  | { status: "governance_record_absent" | "governance_record_malformed" | "unsupported_version" }
  | { status: "no_panel" }
  | { status: "panel_not_finalized" }
  | { status: "panel_malformed" | "panel_unsupported_version" }
  | { status: "inconsistent"; reason: string }
  | {
      status: "repaired" | "already_complete";
      historyStatus: "recorded" | "already_exists" | "failed";
      panelHistoryStatus: "recorded" | "already_exists" | "failed";
      eventStatus: "recorded" | "already_exists" | "failed";
      auditStatus: "recorded" | "already_exists" | "failed";
      projectionSyncStatus: "synced" | "failed";
    };

export async function repairAdaptivePanelFinalizationArtifacts(runId: string, teamId: string): Promise<RepairAdaptivePanelFinalizationArtifactsResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  const runSnap = await adminDb.collection("runs").doc(runId).get();
  if (!runSnap.exists) {
    return { status: "run_missing" };
  }
  const govParse = parseGovernanceRecord(runSnap.data()?.governanceRecord);
  if (!govParse.ok) {
    if (govParse.reason === "absent") return { status: "governance_record_absent" };
    if (govParse.reason === "unsupported_version") return { status: "unsupported_version" };
    return { status: "governance_record_malformed" };
  }
  const record = govParse.record;

  const panelResult = await getAdaptiveHumanReviewPanel(runId, teamId);
  if (panelResult.status === "firestore_unavailable" || panelResult.status === "read_failed") {
    return { status: "firestore_unavailable" };
  }
  if (panelResult.status === "absent") {
    return { status: "no_panel" };
  }
  if (panelResult.status === "malformed") {
    return { status: "panel_malformed" };
  }
  if (panelResult.status === "unsupported_version") {
    return { status: "panel_unsupported_version" };
  }
  const panel = panelResult.panel;

  // §E24 — an open or cancelled panel is never a repair target; repair
  // only ever concerns an ALREADY finalized panel's secondary artifacts.
  if (panel.status !== "finalized") {
    return { status: "panel_not_finalized" };
  }

  const preFinalizationRevision = panel.revision - 1;

  // ---- Fail-closed consistency check — never guess ----
  if (isHumanReviewStatusReviewable(record.humanReview.status)) {
    return { status: "inconsistent", reason: "human_review_still_reviewable_despite_finalized_panel" };
  }
  if (record.humanReview.decidedVia !== "multi_reviewer_panel") {
    return { status: "inconsistent", reason: "human_review_not_attributed_to_multi_reviewer_panel" };
  }
  if (record.humanReview.status !== panel.finalStatus) {
    return { status: "inconsistent", reason: "human_review_status_does_not_match_panel_final_status" };
  }
  if (record.humanReview.panelRevision !== preFinalizationRevision) {
    return { status: "inconsistent", reason: "human_review_panel_revision_does_not_match_panel" };
  }

  const finalDecisionId = panel.finalDecisionId!;
  const finalizedAt = panel.finalizedAt!;
  const finalStatus = panel.finalStatus!;
  const aggregationPolicyVersion = panel.aggregationPolicyVersion!;
  const actorUserId = panel.finalizedByUserId!;

  // Read-only vote count for the (possibly-missing) panel-history entry's
  // metadata — never modifies a vote, never writes to the votes collection.
  const voteResults = await Promise.all(
    panel.reviewerUserIds.map((reviewerUserId) => getAdaptiveHumanReviewVote(runId, preFinalizationRevision, reviewerUserId, teamId))
  );
  const submittedCount = voteResults.filter((r) => r.status === "found").length;

  // Fixed, documented convention — identical to the existing single-reviewer
  // repair precedent (adaptiveReviewArtifactRepair.ts): the canonical
  // record no longer carries which non-terminal status preceded a
  // terminal decision once it has already committed, so this is never
  // fabricated as if positively known.
  const priorStatusForHistory: "unreviewed" = "unreviewed";

  let historyStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const historyEntry = buildAdaptiveHumanReviewHistoryEntry({
      decisionId: finalDecisionId,
      runId,
      teamId,
      schemaId: record.schemaId as PersistedAdaptiveSchemaId,
      answerShape: record.answerShape,
      priorStatus: priorStatusForHistory,
      newStatus: finalStatus,
      reviewerId: actorUserId,
      reviewedAt: finalizedAt,
      governanceRecordUpdatedAt: finalizedAt,
      comment: record.humanReview.comment,
      conditions: record.humanReview.conditions,
      now: finalizedAt,
    });
    const result = await createAdaptiveHumanReviewHistory(runId, historyEntry);
    historyStatus = result.status;
  } catch {
    logger.warn("[adaptivePanelFinalizationRepair] History repair write threw", { runId, teamId });
  }

  let panelHistoryStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const panelHistoryEntry = buildAdaptivePanelFinalizationHistoryEntry({
      teamId,
      runId,
      preFinalizationPanelRevision: preFinalizationRevision,
      finalizedPanelRevision: panel.revision,
      finalStatus,
      finalDecisionId,
      aggregationPolicyVersion,
      reviewerCount: panel.requiredReviewerCount,
      submittedCount,
      supportingReviewerCount: record.humanReview.supportingReviewerCount ?? 0,
      actorUserId,
      finalizedAt,
    });
    const result = await createAdaptivePanelFinalizationHistory(runId, panelHistoryEntry);
    panelHistoryStatus = result.status;
  } catch {
    logger.warn("[adaptivePanelFinalizationRepair] Panel-history repair write threw", { runId, teamId });
  }

  let eventStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const result = await writeAdaptivePanelFinalizationGovernanceEvent({
      runId,
      teamId,
      schemaId: record.schemaId,
      answerShape: record.answerShape,
      finalStatus,
      finalDecisionId,
      aggregationPolicyVersion,
      supportingReviewerCount: record.humanReview.supportingReviewerCount ?? 0,
      actorUserId,
      finalizedAt,
    });
    eventStatus = result.status;
  } catch {
    logger.warn("[adaptivePanelFinalizationRepair] Governance-event repair write threw", { runId, teamId });
  }

  let auditStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const result = await writeAdaptivePanelFinalizationAdminAuditEvent({
      actorUid: actorUserId,
      teamId,
      runId,
      priorHumanReviewStatus: priorStatusForHistory,
      finalStatus,
      panelRevision: preFinalizationRevision,
      finalDecisionId,
      aggregationPolicyVersion,
      finalizedAt,
    });
    auditStatus = result.status;
  } catch {
    logger.warn("[adaptivePanelFinalizationRepair] Admin-audit repair write threw", { runId, teamId });
  }

  let projectionSyncStatus: "synced" | "failed" = "failed";
  try {
    const result = await syncAdaptiveTeamRunProjectionAfterReview({
      teamId,
      runId,
      humanReviewStatus: finalStatus,
      reviewedAt: record.humanReview.reviewedAt,
      updatedAt: finalizedAt,
    });
    projectionSyncStatus = result.status === "synced" ? "synced" : "failed";
  } catch {
    logger.warn("[adaptivePanelFinalizationRepair] Projection-sync repair threw", { runId, teamId });
  }

  const allAlreadyComplete =
    historyStatus === "already_exists" && panelHistoryStatus === "already_exists" && eventStatus === "already_exists" && auditStatus === "already_exists";

  return {
    status: allAlreadyComplete ? "already_complete" : "repaired",
    historyStatus,
    panelHistoryStatus,
    eventStatus,
    auditStatus,
    projectionSyncStatus,
  };
}
