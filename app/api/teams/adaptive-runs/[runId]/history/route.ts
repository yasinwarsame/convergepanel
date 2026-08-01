/**
 * Immutable Adaptive Review History and Admin Audit Integration — read-only
 * review-history endpoint (docs/governance-decision-receipts-design.md §27).
 * Reads the immutable `runs/{runId}/humanReviewHistory` subcollection —
 * never `governanceRecord.humanReview` (that remains canonical CURRENT
 * state, read by the detail endpoint) and never the `teamRuns` projection.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getRequestUid, loadUserAndTeam, memberRole, isTeamAdmin } from "@/lib/teams/teamApiAuth";
import { getAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import { logger } from "@/lib/logger";
import {
  classifyAdaptiveHumanReviewHistoryRow,
  sortAdaptiveReviewHistoryRows,
  AdaptiveReviewHistoryResponseV1,
} from "@/lib/governance/adaptiveHumanReviewHistory";

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

  // ---- Authorization — identical pattern to the detail route: the
  // deterministic adaptive projection lookup is the primary tenant-
  // isolation mechanism; cross-team existence is never disclosed. ----
  const ctx = await loadUserAndTeam(uid);
  if (!ctx?.team) {
    return errorResponse(403, "forbidden", "Team access required");
  }
  const team = ctx.team;
  const role = memberRole(uid, team);
  if (!isTeamAdmin(role)) {
    return errorResponse(403, "insufficient_role", "Admin access required");
  }

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
    logger.warn("[adaptive-runs/history] Forged or malformed adaptive projection rejected", { runId, teamId: team.id });
    return errorResponse(404, "projection_invalid", "No valid adaptive review projection exists for this run.");
  }

  const runSnap = await adminDb.collection("runs").doc(runId).get();
  if (!runSnap.exists) {
    return errorResponse(404, "not_found", "Run not found.");
  }

  // ---- Read the immutable history subcollection — at most one entry in
  // practice today (a single-shot terminal decision), but the read/sort
  // logic does not assume that. ----
  let historySnap;
  try {
    historySnap = await adminDb.collection("runs").doc(runId).collection("humanReviewHistory").get();
  } catch {
    return errorResponse(503, "firestore_unavailable", "Could not load review history.");
  }

  const validRows: Array<{ item: AdaptiveReviewHistoryResponseV1["items"][number]; historyId: string }> = [];
  for (const doc of historySnap.docs) {
    const result = classifyAdaptiveHumanReviewHistoryRow(doc.id, doc.data());
    if (result.status === "valid") {
      validRows.push({ item: result.item, historyId: result.historyId });
    } else {
      logger.warn("[adaptive-runs/history] Skipped a malformed or unsupported history row", { runId, historyId: result.historyId });
    }
  }

  const response: AdaptiveReviewHistoryResponseV1 = {
    ok: true,
    version: 1,
    runId,
    items: sortAdaptiveReviewHistoryRows(validRows),
  };
  return NextResponse.json(response);
}
