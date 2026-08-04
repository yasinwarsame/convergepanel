/**
 * Multi-Reviewer Owner Override, Part F
 * (docs/governance-decision-receipts-design.md §34). `{runId}` is the real
 * `runs/{runId}` panel run ID — `teamId`, actor identity, `finalDecisionId`,
 * vote IDs, `quorum`, the aggregation result, timestamps other than the two
 * concurrency tokens, and panel state are NEVER accepted from the client
 * anywhere in this route; every authoritative value is server-derived by
 * the override transaction itself. Mirrors the finalize route's own
 * structure exactly (auth → projection check → body validation →
 * transaction → best-effort secondary artifacts), but authorization is
 * OWNER-ONLY (an `admin` is rejected, unlike ordinary finalization, which
 * any admin/owner may perform) and the transaction never reads votes.
 *
 * PART F SCOPE ONLY: no reviewer vote editing, no reopening a finalized
 * panel, no admin override.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getRequestUid, loadUserAndTeam, memberRole } from "@/lib/teams/teamApiAuth";
import { getAdaptiveTeamRunProjection, syncAdaptiveTeamRunProjectionAfterReview } from "@/lib/firestore/teamRuns";
import {
  overrideAdaptiveHumanReviewPanel,
  createAdaptiveHumanReviewHistory,
  createAdaptivePanelOverrideHistory,
  writeAdaptivePanelOverrideGovernanceEvent,
} from "@/lib/firestore/runs";
import { writeAdaptivePanelOverrideAdminAuditEvent } from "@/lib/governance/auditLog";
import { buildAdaptiveHumanReviewHistoryEntry, isAdaptiveReviewNonTerminalStatus } from "@/lib/governance/adaptiveHumanReviewHistory";
import { buildAdaptivePanelOverrideHistoryEntry, parseSubmitAdaptiveReviewOverrideRequest } from "@/lib/governance/adaptivePanelOverride";
import { PersistedAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";
import type { TeamDocument } from "@/lib/governance/teamTypes";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function mapValidationFailure(reason: string) {
  switch (reason) {
    case "malformed_body":
      return errorResponse(400, "validation_error", "Invalid request body.");
    case "missing_expected_panel_revision":
    case "invalid_expected_panel_revision":
      return errorResponse(400, "validation_error", "expectedPanelRevision must be a positive integer.");
    case "missing_expected_governance_updated_at":
    case "invalid_expected_governance_updated_at":
      return errorResponse(400, "validation_error", "expectedGovernanceUpdatedAt must be a valid timestamp.");
    case "invalid_status":
      return errorResponse(400, "validation_error", "status must be one of approved, approved_with_conditions, changes_requested, rejected.");
    case "missing_justification":
      return errorResponse(400, "validation_error", "A justification is required to override a review panel.");
    case "invalid_justification":
      return errorResponse(400, "validation_error", "justification must be a string.");
    case "justification_too_long":
      return errorResponse(400, "validation_error", "justification must be 4000 characters or fewer.");
    case "conditions_required":
      return errorResponse(400, "validation_error", "At least one condition is required for approved_with_conditions.");
    case "conditions_not_allowed":
      return errorResponse(400, "validation_error", "conditions are only allowed for approved_with_conditions.");
    case "too_many_conditions":
      return errorResponse(400, "validation_error", "Too many conditions.");
    case "condition_too_long":
      return errorResponse(400, "validation_error", "One or more conditions are too long.");
    case "invalid_conditions":
      return errorResponse(400, "validation_error", "conditions must be an array of strings.");
    default:
      return errorResponse(400, "validation_error", "Invalid request body.");
  }
}

function mapOverrideFailure(reason: string) {
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
    case "panel_already_finalized":
      return errorResponse(409, "panel_already_finalized", "This panel has already been finalized and cannot be overridden again.");
    case "inconsistent_finalization_state":
      return errorResponse(409, "inconsistent_finalization_state", "This run's review state is inconsistent and could not be verified.");
    default:
      return errorResponse(500, "internal_error", "Could not override the review panel.");
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

  // Owner-only (§F3) — deliberately NOT `isTeamAdmin`, which also accepts
  // `admin`. An admin can finalize a ready panel but can never override
  // one; only the exact "owner" role may.
  if (role !== "owner") {
    return errorResponse(403, "insufficient_role", "Owner access required.");
  }

  // Step 5.10 — deliberately NO opt-in/global-guard check here. Overriding
  // an already-open panel is a DRAIN operation (specifically the escape
  // hatch for a panel that CAN'T otherwise reach quorum) — it must remain
  // available even after the team (or the whole feature, globally) has
  // been disabled, so a deadlocked/waiting panel can never become
  // permanently stranded by a rollback.

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
    logger.warn("[adaptive-runs/review-panel/override] Forged or malformed adaptive projection rejected", { runId, teamId: team.id });
    return errorResponse(404, "projection_invalid", "No valid adaptive review projection exists for this run.");
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON.");
  }

  const parsed = parseSubmitAdaptiveReviewOverrideRequest(rawBody);
  if (!parsed.ok) {
    return mapValidationFailure(parsed.reason);
  }
  const { expectedPanelRevision, expectedGovernanceUpdatedAt, status, justification, conditions } = parsed.value;

  const result = await overrideAdaptiveHumanReviewPanel({
    runId,
    teamId: team.id,
    actorUserId: uid,
    expectedPanelRevision,
    expectedGovernanceUpdatedAt,
    status,
    justification,
    conditions,
  });

  if (!result.ok) {
    return mapOverrideFailure(result.reason);
  }

  const { panel, humanReview, priorHumanReviewStatus, schemaId, answerShape } = result;
  // `finalDecisionId`/`finalizedAt`/etc. are guaranteed present — the
  // transaction only ever returns `ok: true` with a `status: "finalized"`
  // panel.
  const finalDecisionId = panel.finalDecisionId!;
  const finalizedAt = panel.finalizedAt!;
  const finalStatus = panel.finalStatus!;
  const overrideByUserId = panel.overrideByUserId!;
  const preOverridePanelRevision = panel.revision - 1;
  const conditionsCount = humanReview.conditions?.length ?? 0;

  // ---- Secondary artifacts (§F8) — best-effort, attempted for BOTH a
  // fresh override and an idempotent retry. None may roll back the
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
      reviewerId: overrideByUserId,
      reviewedAt: finalizedAt,
      governanceRecordUpdatedAt: finalizedAt,
      comment: humanReview.comment,
      conditions: humanReview.conditions,
      now: finalizedAt,
    });
    const historyResult = await createAdaptiveHumanReviewHistory(runId, historyEntry);
    historyStatus = historyResult.status;
  } catch {
    logger.warn("[adaptive-runs/review-panel/override] Immutable review-history write threw after a successful canonical override", { runId, teamId: team.id });
  }

  let panelHistoryStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const panelHistoryEntry = buildAdaptivePanelOverrideHistoryEntry({
      teamId: team.id,
      runId,
      preOverridePanelRevision,
      overriddenPanelRevision: panel.revision,
      finalStatus,
      finalDecisionId,
      overrideByUserId,
      conditionsCount,
      finalizedAt,
    });
    const panelHistoryResult = await createAdaptivePanelOverrideHistory(runId, panelHistoryEntry);
    panelHistoryStatus = panelHistoryResult.status;
  } catch {
    logger.warn("[adaptive-runs/review-panel/override] Panel override history write threw after a successful canonical override", { runId, teamId: team.id });
  }

  let eventStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const eventResult = await writeAdaptivePanelOverrideGovernanceEvent({
      runId,
      teamId: team.id,
      schemaId,
      answerShape,
      finalStatus,
      finalDecisionId,
      overrideByUserId,
      finalizedAt,
    });
    eventStatus = eventResult.status;
  } catch {
    logger.warn("[adaptive-runs/review-panel/override] Governance event write threw after a successful canonical override", { runId, teamId: team.id });
  }

  let auditStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const auditResult = await writeAdaptivePanelOverrideAdminAuditEvent({
      actorUid: overrideByUserId,
      teamId: team.id,
      runId,
      priorHumanReviewStatus,
      finalStatus,
      panelRevision: preOverridePanelRevision,
      finalDecisionId,
      conditionsCount,
      finalizedAt,
    });
    auditStatus = auditResult.status;
  } catch {
    logger.warn("[adaptive-runs/review-panel/override] Admin audit write threw after a successful canonical override", { runId, teamId: team.id });
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
    logger.warn("[adaptive-runs/review-panel/override] Projection sync threw after a successful canonical override", { runId, teamId: team.id });
  }

  return NextResponse.json({
    ok: true,
    override: {
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
