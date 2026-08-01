/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — read-only adaptive
 * review-DETAIL endpoint (docs/governance-decision-receipts-design.md §25).
 * Data source for a future Part E2 decision form. No mutation behavior —
 * this route never writes anything.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getRequestUid, loadUserAndTeam, memberRole, isTeamAdmin } from "@/lib/teams/teamApiAuth";
import { getAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { buildAdaptiveReviewDetailResponse } from "@/lib/governance/adaptiveReviewDetail";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: NextRequest, { params }: { params: { runId: string } }) {
  const uidOrRes = await getRequestUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const runId = params.runId;
  if (!runId) {
    return errorResponse(400, "bad_request", "runId required");
  }

  if (!adminDb) {
    return errorResponse(503, "firestore_unavailable", "Database unavailable.");
  }

  // ---- Authorization ----
  const ctx = await loadUserAndTeam(uid);
  if (!ctx?.team) {
    return errorResponse(403, "forbidden", "Team access required");
  }
  const team = ctx.team;
  const role = memberRole(uid, team);
  if (!isTeamAdmin(role)) {
    return errorResponse(403, "insufficient_role", "Admin access required");
  }

  // ---- Deterministic adaptive projection lookup ----
  const projectionResult = await getAdaptiveTeamRunProjection(team.id, runId);
  if (projectionResult.status === "firestore_unavailable") {
    return errorResponse(503, "firestore_unavailable", "Database unavailable.");
  }
  if (projectionResult.status === "read_failed") {
    return errorResponse(503, "firestore_unavailable", "Could not load review projection.");
  }
  if (projectionResult.status === "not_found") {
    return errorResponse(404, "projection_missing", "No adaptive review projection exists for this run.");
  }
  const projection = projectionResult.projection;

  if (projection.projectionVersion !== 1) {
    logger.warn("[adaptive-runs/detail] Unsupported projection version", { runId, teamId: team.id });
    return errorResponse(500, "internal_error", "This review projection could not be read.");
  }

  const projectionValid =
    projection.adaptive === true &&
    typeof projection.teamId === "string" &&
    projection.teamId === team.id &&
    typeof projection.runId === "string" &&
    projection.runId === runId;
  if (!projectionValid) {
    logger.warn("[adaptive-runs/detail] Forged or malformed adaptive projection rejected", { runId, teamId: team.id });
    return errorResponse(404, "projection_invalid", "No valid adaptive review projection exists for this run.");
  }

  // ---- Parent run + governanceRecord — the canonical source, always ----
  const runSnap = await adminDb.collection("runs").doc(runId).get();
  if (!runSnap.exists) {
    return errorResponse(404, "not_found", "Run not found.");
  }
  const runData = runSnap.data();

  const parseResult = parseGovernanceRecord(runData?.governanceRecord);
  if (!parseResult.ok) {
    if (parseResult.reason === "absent") {
      return errorResponse(404, "governance_record_absent", "This run has no governance record to review.");
    }
    // "malformed" and "unsupported_version" are both real, distinct data
    // states, but neither is safe to expose in detail to the client — both
    // map to a generic internal error, matching the decision route's own
    // established precedent (Part D) for the identical parse-failure states.
    return errorResponse(500, "internal_error", "This run's governance record could not be read.");
  }
  const record = parseResult.record;

  // The canonical parent record is authoritative. A stale projection
  // (created or last synced before a later parent change) is logged for
  // monitoring only — metadata, never the actual statuses or content —
  // and is never repaired inside this GET, and never blocks or changes
  // the response, which is always built from `record` alone.
  if (typeof projection.humanReviewStatus === "string" && projection.humanReviewStatus !== record.humanReview.status) {
    logger.info("[adaptive-runs/detail] Projection humanReviewStatus disagrees with canonical parent (parent wins, not repaired here)", {
      runId,
      teamId: team.id,
    });
  }

  return NextResponse.json(buildAdaptiveReviewDetailResponse(runId, record));
}
