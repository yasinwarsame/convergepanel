/**
 * Transactional Multi-Reviewer Finalization, Part E
 * (docs/governance-decision-receipts-design.md §29-§33). `{runId}` is the
 * real `runs/{runId}` panel run ID — `teamId`, actor identity,
 * `finalStatus`, vote IDs, `quorum`, the aggregation result, the final
 * decision ID, timestamps, comments, conditions, and the policy version
 * are NEVER accepted from the client anywhere in this route; every
 * authoritative value is server-derived by the finalization transaction
 * itself.
 *
 * PART E SCOPE ONLY: no owner override, no multi-reviewer UI. Ordinary
 * finalization (this route) is available to any team `owner`/`admin` —
 * §E4's own recommendation, since finalization here is a mechanical
 * "the vote is already decided" action once the pure engine reports
 * `ready`, not an executive judgment call (that remains reserved for a
 * future owner-only override, Part F).
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getRequestUid, loadUserAndTeam, isTeamAdmin, memberRole } from "@/lib/teams/teamApiAuth";
import { getAdaptiveTeamRunProjection, syncAdaptiveTeamRunProjectionAfterReview } from "@/lib/firestore/teamRuns";
import {
  finalizeAdaptiveHumanReviewPanel,
  createAdaptiveHumanReviewHistory,
  createAdaptivePanelFinalizationHistory,
  writeAdaptivePanelFinalizationGovernanceEvent,
} from "@/lib/firestore/runs";
import { writeAdaptivePanelFinalizationAdminAuditEvent } from "@/lib/governance/auditLog";
import { buildAdaptiveHumanReviewHistoryEntry, isAdaptiveReviewNonTerminalStatus } from "@/lib/governance/adaptiveHumanReviewHistory";
import { buildAdaptivePanelFinalizationHistoryEntry } from "@/lib/governance/adaptivePanelFinalization";
import { isValidTimestamp } from "@/lib/adaptiveSchema/governanceRecordParser";
import { PersistedAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";
import type { TeamDocument } from "@/lib/governance/teamTypes";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function mapFinalizationFailure(reason: string) {
  switch (reason) {
    case "firestore_unavailable":
      return errorResponse(503, "firestore_unavailable", "Database unavailable.");
    case "run_missing":
      return errorResponse(404, "not_found", "Run not found.");
    case "governance_record_absent":
      return errorResponse(404, "governance_record_absent", "This run has no governance record.");
    case "governance_record_malformed":
    case "unsupported_version":
      return errorResponse(500, "internal_error", "This run's governance record could not be read.");
    case "governance_stale":
      return errorResponse(409, "governance_stale", "This run has changed since you last viewed it. Please refresh and try again.");
    case "not_pending":
      return errorResponse(409, "not_pending", "This review is no longer pending.");
    case "panel_absent":
      return errorResponse(404, "panel_absent", "No review panel exists for this run.");
    case "panel_malformed":
    case "panel_unsupported_version":
      return errorResponse(409, "adaptive_review_panel_invalid", "This run's review panel could not be read.");
    case "panel_cancelled":
      return errorResponse(409, "panel_cancelled", "This review panel has been cancelled.");
    case "panel_stale":
      return errorResponse(409, "panel_stale", "This panel changed since you last viewed it. Please refresh and try again.");
    case "vote_malformed":
    case "vote_unsupported_version":
      return errorResponse(500, "internal_error", "One or more votes for this panel could not be read.");
    case "quorum_not_met":
      return errorResponse(409, "quorum_not_met", "Not enough reviewers have voted yet.");
    case "panel_deadlocked":
      return errorResponse(409, "panel_deadlocked", "The panel's votes do not have a strict majority. Additional votes or reconfiguration are required.");
    case "aggregation_invalid":
      return errorResponse(500, "internal_error", "This panel's votes could not be evaluated.");
    case "inconsistent_finalization_state":
      return errorResponse(409, "inconsistent_finalization_state", "This run's review state is inconsistent and could not be verified.");
    default:
      return errorResponse(500, "internal_error", "Could not finalize the review panel.");
  }
}

export async function POST(req: NextRequest, { params }: { params: { runId: string } }) {
  const uidOrRes = await getRequestUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const runId = params.runId;
  if (!runId) return errorResponse(400, "bad_request", "runId required");
  if (!adminDb) return errorResponse(503, "firestore_unavailable", "Database unavailable.");

  const ctx = await loadUserAndTeam(uid);
  if (!ctx?.team) return errorResponse(403, "forbidden", "Team access required");
  const team = ctx.team as TeamDocument;
  const role = memberRole(uid, team);
  if (!isTeamAdmin(role)) return errorResponse(403, "insufficient_role", "Admin access required");

  // Step 5.10 — deliberately NO opt-in/global-guard check here. Finalizing
  // an already-ready panel is a DRAIN operation, not new activity — it must
  // remain available even after the team (or the whole feature, globally)
  // has been disabled, so a ready panel can never become permanently
  // stranded by a rollback.

  const projectionResult = await getAdaptiveTeamRunProjection(team.id, runId);
  if (projectionResult.status === "firestore_unavailable" || projectionResult.status === "read_failed") {
    return errorResponse(503, "firestore_unavailable", "Could not verify review eligibility.");
  }
  if (projectionResult.status === "not_found") {
    return errorResponse(404, "projection_missing", "No adaptive review projection exists for this run.");
  }
  const projection = projectionResult.projection;
  const projectionValid =
    projection.adaptive === true &&
    typeof projection.teamId === "string" &&
    projection.teamId === team.id &&
    typeof projection.runId === "string" &&
    projection.runId === runId;
  if (!projectionValid) {
    logger.warn("[adaptive-runs/review-panel/finalize] Forged or malformed adaptive projection rejected", { runId, teamId: team.id });
    return errorResponse(404, "projection_invalid", "No valid adaptive review projection exists for this run.");
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON.");
  }
  const body = (rawBody ?? {}) as { expectedPanelRevision?: unknown; expectedGovernanceUpdatedAt?: unknown };

  if (typeof body.expectedPanelRevision !== "number" || !Number.isInteger(body.expectedPanelRevision) || body.expectedPanelRevision < 1) {
    return errorResponse(400, "validation_error", "expectedPanelRevision must be a positive integer.");
  }
  if (typeof body.expectedGovernanceUpdatedAt !== "string" || !isValidTimestamp(body.expectedGovernanceUpdatedAt)) {
    return errorResponse(400, "validation_error", "expectedGovernanceUpdatedAt must be a valid timestamp.");
  }

  const result = await finalizeAdaptiveHumanReviewPanel({
    runId,
    teamId: team.id,
    actorUserId: uid,
    expectedPanelRevision: body.expectedPanelRevision,
    expectedGovernanceUpdatedAt: body.expectedGovernanceUpdatedAt,
  });

  if (!result.ok) {
    if (result.reason === "quorum_not_met") {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "quorum_not_met", message: "Not enough reviewers have voted yet." },
          submittedCount: result.submittedCount,
          quorum: result.quorum,
        },
        { status: 409 }
      );
    }
    return mapFinalizationFailure(result.reason);
  }

  const { panel, humanReview, priorHumanReviewStatus, schemaId, answerShape, submittedCount } = result;
  // `finalDecisionId`/`finalizedAt`/etc. are guaranteed present — the
  // transaction only ever returns `ok: true` with a `status: "finalized"`
  // panel.
  const finalDecisionId = panel.finalDecisionId!;
  const finalizedAt = panel.finalizedAt!;
  const finalStatus = panel.finalStatus!;
  const aggregationPolicyVersion = panel.aggregationPolicyVersion!;
  const preFinalizationPanelRevision = panel.revision - 1;

  // ---- Secondary artifacts (§E11) — best-effort, attempted for BOTH a
  // fresh finalization and an idempotent retry (all writers below are
  // create-only/idempotent, so a retry safely reports "already_exists"
  // rather than needing a separate code path). None may roll back the
  // already-committed canonical success. ----
  let historyStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const priorStatusForHistory = isAdaptiveReviewNonTerminalStatus(priorHumanReviewStatus) ? priorHumanReviewStatus : "unreviewed";
    const historyEntry = buildAdaptiveHumanReviewHistoryEntry({
      decisionId: finalDecisionId,
      runId,
      teamId: team.id,
      schemaId: schemaId as PersistedAdaptiveSchemaId,
      answerShape,
      priorStatus: priorStatusForHistory,
      newStatus: finalStatus,
      reviewerId: panel.finalizedByUserId!,
      reviewedAt: finalizedAt,
      governanceRecordUpdatedAt: finalizedAt,
      comment: humanReview.comment,
      conditions: humanReview.conditions,
      now: finalizedAt,
    });
    const historyResult = await createAdaptiveHumanReviewHistory(runId, historyEntry);
    historyStatus = historyResult.status;
  } catch {
    logger.warn("[adaptive-runs/review-panel/finalize] Immutable review-history write threw after a successful canonical finalization", { runId, teamId: team.id });
  }

  let panelHistoryStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const panelHistoryEntry = buildAdaptivePanelFinalizationHistoryEntry({
      teamId: team.id,
      runId,
      preFinalizationPanelRevision,
      finalizedPanelRevision: panel.revision,
      finalStatus,
      finalDecisionId,
      aggregationPolicyVersion,
      reviewerCount: panel.requiredReviewerCount,
      submittedCount,
      supportingReviewerCount: humanReview.supportingReviewerCount ?? 0,
      actorUserId: panel.finalizedByUserId!,
      finalizedAt,
    });
    const panelHistoryResult = await createAdaptivePanelFinalizationHistory(runId, panelHistoryEntry);
    panelHistoryStatus = panelHistoryResult.status;
  } catch {
    logger.warn("[adaptive-runs/review-panel/finalize] Panel finalization history write threw after a successful canonical finalization", { runId, teamId: team.id });
  }

  let eventStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const eventResult = await writeAdaptivePanelFinalizationGovernanceEvent({
      runId,
      teamId: team.id,
      schemaId,
      answerShape,
      finalStatus,
      finalDecisionId,
      aggregationPolicyVersion,
      supportingReviewerCount: humanReview.supportingReviewerCount ?? 0,
      actorUserId: panel.finalizedByUserId!,
      finalizedAt,
    });
    eventStatus = eventResult.status;
  } catch {
    logger.warn("[adaptive-runs/review-panel/finalize] Governance event write threw after a successful canonical finalization", { runId, teamId: team.id });
  }

  let auditStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const auditResult = await writeAdaptivePanelFinalizationAdminAuditEvent({
      actorUid: panel.finalizedByUserId!,
      teamId: team.id,
      runId,
      priorHumanReviewStatus,
      finalStatus,
      panelRevision: preFinalizationPanelRevision,
      finalDecisionId,
      aggregationPolicyVersion,
      finalizedAt,
    });
    auditStatus = auditResult.status;
  } catch {
    logger.warn("[adaptive-runs/review-panel/finalize] Admin audit write threw after a successful canonical finalization", { runId, teamId: team.id });
  }

  let projectionSyncStatus: "synced" | "failed" = "failed";
  try {
    const syncResult = await syncAdaptiveTeamRunProjectionAfterReview({
      teamId: team.id,
      runId,
      humanReviewStatus: finalStatus,
      reviewedAt: humanReview.reviewedAt,
      updatedAt: finalizedAt,
    });
    projectionSyncStatus = syncResult.status === "synced" ? "synced" : "failed";
  } catch {
    logger.warn("[adaptive-runs/review-panel/finalize] Projection sync threw after a successful canonical finalization", { runId, teamId: team.id });
  }

  return NextResponse.json({
    ok: true,
    finalization: {
      status: finalStatus,
      finalizedAt,
    },
    panelRevision: panel.revision,
    historyStatus,
    panelHistoryStatus,
    projectionSyncStatus,
    eventStatus,
    auditStatus,
  });
}
