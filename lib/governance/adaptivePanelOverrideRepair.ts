/**
 * Multi-Reviewer Owner Override, Part F (§F9) — internal, idempotent
 * repair service for the secondary artifacts of an ALREADY
 * owner-override-finalized panel. Mirrors
 * `repairAdaptivePanelFinalizationArtifacts`'s exact structure and
 * discipline (not exposed via any route or UI button — no established
 * protected public-repair pattern exists in this codebase to reuse), but
 * targets the override-specific artifacts and consistency rules instead of
 * the aggregation ones. Never changes canonical
 * `governanceRecord.humanReview`, never changes `panel.finalStatus`, never
 * reopens a panel, never reads, modifies, or aggregates a vote.
 *
 * FAIL-CLOSED ON DISAGREEMENT: if the canonical `humanReview` and the
 * finalized panel do not agree with each other (wrong status, wrong
 * `decidedVia`, wrong `panelRevision` correlation, missing
 * `overrideJustification`, or `humanReview` still reviewable despite the
 * panel claiming finalized), this function refuses to repair anything and
 * reports the inconsistency — it never guesses which side is "right."
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { parseGovernanceRecord, isHumanReviewStatusReviewable } from "@/lib/adaptiveSchema/governanceRecordParser";
import { PersistedAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";
import {
  getAdaptiveHumanReviewPanel,
  createAdaptiveHumanReviewHistory,
  createAdaptivePanelOverrideHistory,
  writeAdaptivePanelOverrideGovernanceEvent,
} from "@/lib/firestore/runs";
import { syncAdaptiveTeamRunProjectionAfterReview } from "@/lib/firestore/teamRuns";
import { writeAdaptivePanelOverrideAdminAuditEvent } from "@/lib/governance/auditLog";
import { buildAdaptiveHumanReviewHistoryEntry } from "@/lib/governance/adaptiveHumanReviewHistory";
import { buildAdaptivePanelOverrideHistoryEntry } from "@/lib/governance/adaptivePanelOverride";

export type RepairAdaptivePanelOverrideArtifactsResult =
  | { status: "firestore_unavailable" }
  | { status: "run_missing" }
  | { status: "governance_record_absent" | "governance_record_malformed" | "unsupported_version" }
  | { status: "no_panel" }
  | { status: "panel_not_finalized" }
  | { status: "panel_not_overridden" }
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

export async function repairAdaptivePanelOverrideArtifacts(runId: string, teamId: string): Promise<RepairAdaptivePanelOverrideArtifactsResult> {
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

  // §F9 — an open or cancelled panel is never a repair target; repair only
  // ever concerns an ALREADY finalized panel's secondary artifacts.
  if (panel.status !== "finalized") {
    return { status: "panel_not_finalized" };
  }
  // A panel finalized via AGGREGATION is not this repair service's
  // concern at all — `repairAdaptivePanelFinalizationArtifacts` owns that
  // case. Never silently repairs the wrong kind of finalization.
  if (panel.finalizedVia !== "owner_override") {
    return { status: "panel_not_overridden" };
  }

  const preOverrideRevision = panel.revision - 1;

  // ---- Fail-closed consistency check — never guess ----
  if (isHumanReviewStatusReviewable(record.humanReview.status)) {
    return { status: "inconsistent", reason: "human_review_still_reviewable_despite_finalized_panel" };
  }
  if (record.humanReview.decidedVia !== "multi_reviewer_owner_override") {
    return { status: "inconsistent", reason: "human_review_not_attributed_to_owner_override" };
  }
  if (record.humanReview.status !== panel.finalStatus) {
    return { status: "inconsistent", reason: "human_review_status_does_not_match_panel_final_status" };
  }
  if (record.humanReview.panelRevision !== preOverrideRevision) {
    return { status: "inconsistent", reason: "human_review_panel_revision_does_not_match_panel" };
  }
  if (!record.humanReview.overrideJustification || !record.humanReview.overrideJustification.trim()) {
    return { status: "inconsistent", reason: "human_review_missing_override_justification" };
  }
  if (panel.overrideJustificationPresent !== true || !panel.overrideByUserId) {
    return { status: "inconsistent", reason: "panel_missing_override_provenance" };
  }

  const finalDecisionId = panel.finalDecisionId!;
  const finalizedAt = panel.finalizedAt!;
  const finalStatus = panel.finalStatus!;
  const overrideByUserId = panel.overrideByUserId!;
  const conditionsCount = record.humanReview.conditions?.length ?? 0;

  // Fixed, documented convention — identical to the finalization repair
  // service's own precedent: the canonical record no longer carries which
  // non-terminal status preceded a terminal decision once it has already
  // committed, so this is never fabricated as if positively known.
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
      reviewerId: overrideByUserId,
      reviewedAt: finalizedAt,
      governanceRecordUpdatedAt: finalizedAt,
      comment: record.humanReview.comment,
      conditions: record.humanReview.conditions,
      now: finalizedAt,
    });
    const result = await createAdaptiveHumanReviewHistory(runId, historyEntry);
    historyStatus = result.status;
  } catch {
    logger.warn("[adaptivePanelOverrideRepair] History repair write threw", { runId, teamId });
  }

  let panelHistoryStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const panelHistoryEntry = buildAdaptivePanelOverrideHistoryEntry({
      teamId,
      runId,
      preOverridePanelRevision: preOverrideRevision,
      overriddenPanelRevision: panel.revision,
      finalStatus,
      finalDecisionId,
      overrideByUserId,
      conditionsCount,
      finalizedAt,
    });
    const result = await createAdaptivePanelOverrideHistory(runId, panelHistoryEntry);
    panelHistoryStatus = result.status;
  } catch {
    logger.warn("[adaptivePanelOverrideRepair] Panel-history repair write threw", { runId, teamId });
  }

  let eventStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const result = await writeAdaptivePanelOverrideGovernanceEvent({
      runId,
      teamId,
      schemaId: record.schemaId,
      answerShape: record.answerShape,
      finalStatus,
      finalDecisionId,
      overrideByUserId,
      finalizedAt,
    });
    eventStatus = result.status;
  } catch {
    logger.warn("[adaptivePanelOverrideRepair] Governance-event repair write threw", { runId, teamId });
  }

  let auditStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const result = await writeAdaptivePanelOverrideAdminAuditEvent({
      actorUid: overrideByUserId,
      teamId,
      runId,
      priorHumanReviewStatus: priorStatusForHistory,
      finalStatus,
      panelRevision: preOverrideRevision,
      finalDecisionId,
      conditionsCount,
      finalizedAt,
    });
    auditStatus = result.status;
  } catch {
    logger.warn("[adaptivePanelOverrideRepair] Admin-audit repair write threw", { runId, teamId });
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
    logger.warn("[adaptivePanelOverrideRepair] Projection-sync repair threw", { runId, teamId });
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
