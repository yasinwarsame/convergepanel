/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D — the adaptive
 * human-review decision route (docs/governance-decision-receipts-design.md
 * §21.5-21.10). `{runId}` in the path is the REAL panel `runId`
 * (`runs/{runId}`), deliberately NOT the `teamRuns` projection's own
 * document ID — the server derives the deterministic projection ID
 * (`${callerTeamId}:${runId}`) internally, from the CALLER's own resolved
 * team, never from a client-supplied projection ID or team ID.
 *
 * This route ONLY submits a terminal review decision. No list endpoint,
 * dashboard, review UI, reviewer assignment, multiple reviewers, review
 * history, reopening, comment threads, quorum, or export exist yet — none
 * of that is implemented here (Part E, if ever built).
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getRequestUid, loadUserAndTeam, memberRole, isTeamAdmin } from "@/lib/teams/teamApiAuth";
import { getAdaptiveTeamRunProjection, syncAdaptiveTeamRunProjectionAfterReview } from "@/lib/firestore/teamRuns";
import {
  submitAdaptiveHumanReview,
  writeAdaptiveHumanReviewEvent,
  createAdaptiveHumanReviewHistory,
  getAdaptiveHumanReviewAssignment,
  getAdaptiveHumanReviewPanel,
} from "@/lib/firestore/runs";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { parseAdaptiveReviewDecisionRequest } from "@/lib/governance/adaptiveHumanReviewRequest";
import { writeAdaptiveAdminAuditEvent } from "@/lib/governance/auditLog";
import {
  buildAdaptiveReviewDecisionId,
  buildAdaptiveHumanReviewHistoryEntry,
  isAdaptiveReviewNonTerminalStatus,
  isAdaptiveReviewTerminalStatus,
} from "@/lib/governance/adaptiveHumanReviewHistory";
import { hasAdaptiveReviewSubmissionOverride } from "@/lib/governance/adaptiveHumanReviewAssignment";
import { PersistedAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

type AdaptiveReviewPanelGateResult = { blocked: false } | { blocked: true; status: number; code: string; message: string };

/**
 * Multi-Reviewer Panel Foundation, Part B
 * (docs/governance-decision-receipts-design.md §29, §30) — the panel
 * "presence" gate for the existing direct single-reviewer decision route.
 * A dedicated helper, per §30's own guidance, so the route body stays
 * readable.
 *
 * CRITICAL, deliberate asymmetry from the single-reviewer assignment
 * check immediately below this gate: the ASSIGNMENT lookup fails OPEN on
 * a read failure (treated as unassigned, §28) — this PANEL lookup fails
 * CLOSED. An infrastructure failure here must never silently let a direct
 * single-reviewer decision bypass an active panel's governance; a panel,
 * once open, is a stronger governance commitment than a single
 * assignment, and losing visibility into it must never be treated as
 * equivalent to "no panel exists."
 *
 * - absent → not blocked (no panel was ever created for this run; the
 *   existing single-reviewer path governs entirely, unchanged).
 * - found, status "open" → blocked, 409 (multi-reviewer review is
 *   configured; no vote/finalization route exists yet in Part B, so this
 *   run is intentionally not directly decidable until Part C–E ship).
 * - found, status "cancelled" → not blocked (§30's approved coexistence
 *   rule: a cancelled panel restores the single-reviewer path).
 * - malformed / unsupported_version → blocked, 409 (fail closed — never
 *   silently falls back to single-reviewer behavior on corrupted data).
 * - firestore_unavailable / read_failed → blocked, 503 (fail closed).
 */
export async function evaluateAdaptiveReviewPanelGate(runId: string): Promise<AdaptiveReviewPanelGateResult> {
  const result = await getAdaptiveHumanReviewPanel(runId);
  switch (result.status) {
    case "absent":
      return { blocked: false };
    case "found":
      if (result.panel.status === "open") {
        return {
          blocked: true,
          status: 409,
          code: "adaptive_review_panel_active",
          message: "This run is under multi-reviewer panel review. Direct decision submission is not available.",
        };
      }
      return { blocked: false }; // "cancelled"
    case "malformed":
    case "unsupported_version":
      return {
        blocked: true,
        status: 409,
        code: "adaptive_review_panel_invalid",
        message: "This run's review panel could not be read.",
      };
    case "firestore_unavailable":
    case "read_failed":
      return {
        blocked: true,
        status: 503,
        code: "adaptive_review_panel_unavailable",
        message: "Could not verify review panel status. Please try again.",
      };
  }
}

export async function POST(req: NextRequest, { params }: { params: { runId: string } }) {
  const uidOrRes = await getRequestUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const runId = params.runId;
  if (!runId) {
    return errorResponse(400, "bad_request", "runId required");
  }

  if (!adminDb) {
    return errorResponse(500, "internal_error", "Database unavailable.");
  }

  // ---- Authorization (Part D2) ----
  const ctx = await loadUserAndTeam(uid);
  if (!ctx?.team) {
    return errorResponse(403, "forbidden", "Team access required");
  }
  const team = ctx.team;
  const role = memberRole(uid, team);
  if (!isTeamAdmin(role)) {
    return errorResponse(403, "insufficient_role", "Admin access required");
  }

  // ============================================
  // Multi-Reviewer Panel Foundation, Part B — the panel-presence gate.
  // Ordered BEFORE the single-reviewer assignment check below: an open
  // panel takes precedence over — and blocks — the single-reviewer path
  // entirely, regardless of any existing assignment. See
  // evaluateAdaptiveReviewPanelGate's own doc comment for the fail-closed
  // rationale (a deliberate asymmetry from the assignment check's
  // fail-open behavior immediately below).
  // ============================================
  const panelGate = await evaluateAdaptiveReviewPanelGate(runId);
  if (panelGate.blocked) {
    return errorResponse(panelGate.status, panelGate.code, panelGate.message);
  }

  // ============================================
  // Part E3 — Single-Reviewer Assignment for Adaptive Human Review. The
  // SMALLEST additive check this feature requires against the existing
  // decision route (§20, protected scope): if a reviewer is assigned to
  // this run, only that reviewer or an actor with the documented
  // administrative override permission (team OWNER — §28) may submit.
  // This NEVER grants permission beyond the existing isTeamAdmin() gate
  // above — it only ever narrows who, among already-admin callers, may
  // proceed. A caller who is already authorized to view this run receives
  // a clear 403, never a 404 used to conceal the assignment.
  // ============================================
  const assignmentResult = await getAdaptiveHumanReviewAssignment(runId);
  if (assignmentResult.status === "found" && assignmentResult.assignment.assignedReviewerUserId !== null) {
    const assignedReviewerUserId = assignmentResult.assignment.assignedReviewerUserId;
    const isAssignedReviewer = uid === assignedReviewerUserId;
    if (!isAssignedReviewer && !hasAdaptiveReviewSubmissionOverride(role)) {
      return errorResponse(403, "reviewer_assigned", "This run is assigned to another reviewer.");
    }
  }
  // A read failure (firestore_unavailable/read_failed) is treated as
  // "unassigned" for this check ONLY — never blocking a legitimate
  // decision submission because the assignment lookup itself hiccuped;
  // the canonical decision transaction below remains the sole source of
  // truth for whether the review itself may proceed.

  // ---- Request validation (Part D3) ----
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON.");
  }

  const parsedBody = parseAdaptiveReviewDecisionRequest(rawBody);
  if (!parsedBody.ok) {
    return errorResponse(400, "validation_error", `Invalid review request: ${parsedBody.reason}`);
  }
  const decision = parsedBody.value;

  // ---- Deterministic adaptive projection lookup (Part D2) ----
  // The deterministic ID itself is the primary tenant-isolation mechanism
  // (a run belonging to a different team simply has no document at
  // `${team.id}:${runId}`), but stored fields are still checked
  // defensively — never trusted solely because the ID happened to resolve.
  const projectionResult = await getAdaptiveTeamRunProjection(team.id, runId);
  if (projectionResult.status === "firestore_unavailable" || projectionResult.status === "read_failed") {
    return errorResponse(500, "internal_error", "Could not verify review eligibility.");
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
    logger.warn("[adaptive-runs/decision] Forged or malformed adaptive projection rejected", { runId, teamId: team.id });
    return errorResponse(404, "projection_invalid", "No valid adaptive review projection exists for this run.");
  }

  // ---- Parent run + governanceRecord pre-check (Part D2/D4) ----
  // A best-effort, non-transactional read purely to produce an accurate
  // HTTP error code and to gather teamId/schemaId/answerShape for the
  // projection sync and governance event below. The transaction inside
  // submitAdaptiveHumanReview() re-reads and re-validates everything fresh
  // and is the sole AUTHORITATIVE check — this pre-check can never
  // substitute for it, since state could change between the two reads.
  const runSnap = await adminDb.collection("runs").doc(runId).get();
  if (!runSnap.exists) {
    return errorResponse(404, "not_found", "Run not found.");
  }
  const runData = runSnap.data();
  const preParse = parseGovernanceRecord(runData?.governanceRecord);
  if (!preParse.ok) {
    if (preParse.reason === "absent") {
      return errorResponse(404, "governance_record_absent", "This run has no governance record to review.");
    }
    return errorResponse(500, "internal_error", "This run's governance record could not be read.");
  }

  // Informational-only cross-check (§21.6 point 5): if the run owner's
  // CURRENT team differs from the caller's team, this is logged for
  // monitoring but never blocks the review — mirrors System A's own
  // established leniency for old runs missing a userId field.
  const runOwnerUid = typeof runData?.userId === "string" ? runData.userId : undefined;
  if (runOwnerUid) {
    try {
      const ownerSnap = await adminDb.collection("users").doc(runOwnerUid).get();
      const ownerTeamId = ownerSnap.data()?.teamId;
      if (ownerTeamId && ownerTeamId !== team.id) {
        logger.info("[adaptive-runs/decision] Run owner's current team differs from projection team (not blocking)", {
          runId,
          teamId: team.id,
        });
      }
    } catch {
      // Purely informational — never blocks or fails the request.
    }
  }

  const record = preParse.record;

  // ---- Transactional canonical write (Part D5/D6) ----
  const reviewedAt = new Date().toISOString();
  const reviewerName = ctx.user?.name || ctx.user?.email || undefined;

  const submitResult = await submitAdaptiveHumanReview({
    runId,
    update: {
      status: decision.status,
      comment: decision.comment,
      conditions: decision.conditions,
    },
    reviewerId: uid,
    reviewerName,
    expectedUpdatedAt: decision.expectedUpdatedAt,
    now: reviewedAt,
  });

  if (!submitResult.ok) {
    switch (submitResult.reason) {
      case "firestore_unavailable":
        return errorResponse(500, "internal_error", "Database unavailable.");
      case "run_missing":
        return errorResponse(404, "not_found", "Run not found.");
      case "governance_record_absent":
        return errorResponse(404, "governance_record_absent", "This run has no governance record to review.");
      case "governance_record_malformed":
      case "unsupported_version":
        return errorResponse(500, "internal_error", "This run's governance record could not be read.");
      case "stale_expected_updated_at":
        return errorResponse(409, "stale_expected_updated_at", "This run has changed since you last viewed it. Please refresh and try again.");
      case "terminal_review_exists":
        return errorResponse(409, "terminal_review_exists", "This run already has a final review decision.");
      default:
        // invalid_status / invalid_fields / invalid_timestamp / conditions_required — the
        // request-validation layer above should already prevent these; the
        // transaction's own re-validation is a defense-in-depth backstop.
        return errorResponse(400, "validation_error", "Invalid review decision.");
    }
  }

  const { record: updatedRecord, priorHumanReviewStatus } = submitResult;

  // ---- Canonical-success semantics (Part D11) ----
  // The transaction has committed — from here on, the review is a success.
  // Neither the projection sync nor the governance event below can change
  // that; both are best-effort, and their own failures are only ever
  // reflected in `projectionSyncStatus` or server logs, never an HTTP
  // error and never a rollback of the canonical decision.

  const syncResult = await syncAdaptiveTeamRunProjectionAfterReview({
    teamId: team.id,
    runId,
    humanReviewStatus: updatedRecord.humanReview.status,
    reviewedAt: updatedRecord.humanReview.reviewedAt,
    updatedAt: reviewedAt,
  });
  const projectionSyncStatus: "synced" | "failed" = syncResult.status === "synced" ? "synced" : "failed";
  if (projectionSyncStatus === "failed") {
    logger.warn("[adaptive-runs/decision] Projection sync did not save after a successful canonical review", {
      runId,
      teamId: team.id,
      reason: syncResult.status,
    });
  }

  try {
    const eventOutcome = await writeAdaptiveHumanReviewEvent({
      runId,
      teamId: team.id,
      schemaId: record.schemaId,
      answerShape: record.answerShape,
      reviewerId: uid,
      prevStatus: priorHumanReviewStatus,
      nextStatus: updatedRecord.humanReview.status,
      at: reviewedAt,
    });
    if (!eventOutcome.written) {
      logger.warn("[adaptive-runs/decision] Governance event did not save after a successful canonical review", {
        runId,
        teamId: team.id,
        reason: eventOutcome.reason,
      });
    }
  } catch {
    logger.warn("[adaptive-runs/decision] Governance event write threw after a successful canonical review", { runId, teamId: team.id });
  }

  // ============================================
  // IMMUTABLE ADAPTIVE REVIEW HISTORY AND ADMIN AUDIT INTEGRATION —
  // secondary, idempotent artifacts. Both run AFTER the canonical
  // transaction has already committed (§27.5) — neither can invalidate the
  // already-successful canonical decision; both failures are reflected
  // only in the compact `historyStatus`/`auditStatus` response fields and
  // server logs, never an HTTP error.
  // ============================================
  const newStatusForHistory = updatedRecord.humanReview.status;
  let historyStatus: "recorded" | "already_exists" | "failed" = "failed";
  let auditStatus: "recorded" | "already_exists" | "failed" = "failed";

  if (!isAdaptiveReviewTerminalStatus(newStatusForHistory)) {
    // Should never happen — a successfully committed decision transaction
    // only ever moves `humanReview.status` to one of the 4 terminal
    // values (§21.4/§27). Fail safe rather than fabricate a history/audit
    // record against an unexpected status.
    logger.warn("[adaptive-runs/decision] Unexpected non-terminal status after a successful canonical review, skipping history/audit", {
      runId,
      teamId: team.id,
    });
  } else {
    const decisionId = buildAdaptiveReviewDecisionId(team.id, runId, reviewedAt, newStatusForHistory);
    const priorStatusForHistory = isAdaptiveReviewNonTerminalStatus(priorHumanReviewStatus) ? priorHumanReviewStatus : "unreviewed";

    try {
      const historyEntry = buildAdaptiveHumanReviewHistoryEntry({
        decisionId,
        runId,
        teamId: team.id,
        schemaId: record.schemaId as PersistedAdaptiveSchemaId,
        answerShape: record.answerShape,
        priorStatus: priorStatusForHistory,
        newStatus: newStatusForHistory,
        reviewerId: uid,
        reviewedAt,
        governanceRecordUpdatedAt: updatedRecord.updatedAt,
        comment: decision.comment,
        conditions: decision.conditions,
        now: reviewedAt,
      });
      const historyResult = await createAdaptiveHumanReviewHistory(runId, historyEntry);
      historyStatus = historyResult.status;
      if (historyStatus === "failed") {
        logger.warn("[adaptive-runs/decision] Immutable review-history write did not save after a successful canonical review", {
          runId,
          teamId: team.id,
          decisionId,
        });
      }
    } catch {
      historyStatus = "failed";
      logger.warn("[adaptive-runs/decision] Immutable review-history write threw after a successful canonical review", { runId, teamId: team.id });
    }

    try {
      const auditResult = await writeAdaptiveAdminAuditEvent({
        decisionId,
        actorUid: uid,
        teamId: team.id,
        runId,
        schemaId: record.schemaId,
        answerShape: record.answerShape,
        priorStatus: priorStatusForHistory,
        newStatus: newStatusForHistory,
        reviewedAt,
      });
      auditStatus = auditResult.status;
      if (auditStatus === "failed") {
        logger.warn("[adaptive-runs/decision] Admin audit write did not save after a successful canonical review", {
          runId,
          teamId: team.id,
          decisionId,
        });
      }
    } catch {
      auditStatus = "failed";
      logger.warn("[adaptive-runs/decision] Admin audit write threw after a successful canonical review", { runId, teamId: team.id });
    }
  }

  return NextResponse.json({
    ok: true,
    review: {
      status: updatedRecord.humanReview.status,
      reviewedAt: updatedRecord.humanReview.reviewedAt,
    },
    projectionSyncStatus,
    historyStatus,
    auditStatus,
  });
}
