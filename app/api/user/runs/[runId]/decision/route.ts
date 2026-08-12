/**
 * Personal Reviewer Inbox + Action Flow — the personal (teamId: null)
 * decision-submission route. Mirrors
 * app/api/teams/adaptive-runs/[runId]/decision/route.ts's own structure
 * closely, but authorizes via resolveAdaptiveRunAccess (the assigned
 * personal reviewer only) instead of team membership, and reuses the
 * SAME canonical mutation this codebase already has —
 * submitAdaptiveHumanReview() in lib/firestore/runs.ts takes no team
 * parameter at all, so it is called here completely unchanged. Only the
 * side-effect writers around it (history/admin-audit) are personal-scoped
 * variants (teamId: null); there is no teamRuns projection to sync for a
 * personal run, and no multi-reviewer panel can exist for one (panels are
 * created exclusively by team-only routes), so neither is checked here.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import {
  submitAdaptiveHumanReview,
  createAdaptiveHumanReviewHistory,
  getAdaptiveHumanReviewAssignment,
} from "@/lib/firestore/runs";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { parseAdaptiveReviewDecisionRequest } from "@/lib/governance/adaptiveHumanReviewRequest";
import { writeAdaptiveAdminAuditEvent } from "@/lib/governance/auditLog";
import {
  buildPersonalReviewDecisionId,
  buildAdaptiveHumanReviewHistoryEntry,
  isAdaptiveReviewNonTerminalStatus,
  isAdaptiveReviewTerminalStatus,
} from "@/lib/governance/adaptiveHumanReviewHistory";
import { resolveAdaptiveRunAccess } from "@/lib/governance/adaptiveRunAccess";
import { PersistedAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/user/runs/[runId]/decision", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return errorResponse(401, "unauthorized", "Please sign in.");
  }
  return errorResponse(401, "auth_error", "Authentication failed.");
}

export async function POST(req: NextRequest, { params }: { params: { runId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const runId = params.runId;
  if (!runId) {
    return errorResponse(400, "bad_request", "runId required");
  }
  if (!adminDb) {
    return errorResponse(500, "internal_error", "Database unavailable.");
  }

  // ---- Authorization: the canonical per-run assignment is authoritative,
  // never users/{owner}.governanceReviewerUid directly (Part 4). ----
  const runSnap = await adminDb.collection("runs").doc(runId).get();
  if (!runSnap.exists) {
    return errorResponse(404, "not_found", "Run not found.");
  }
  const runData = runSnap.data();
  const owner = typeof runData?.userId === "string" ? runData.userId : "";

  const preParse = parseGovernanceRecord(runData?.governanceRecord);
  const assignmentResult = await getAdaptiveHumanReviewAssignment(runId);
  const assignment = assignmentResult.status === "found" ? assignmentResult.assignment : null;

  const access = resolveAdaptiveRunAccess({
    uid,
    runOwnerUid: owner,
    assignment,
    humanReviewStatus: preParse.ok ? preParse.record.humanReview.status : null,
  });

  if (access.role === "owner") {
    // Owners never submit a decision on their own report — no self-review
    // concept exists anywhere in this codebase.
    return errorResponse(403, "forbidden", "You do not have access to submit a decision on this run.");
  }
  if (access.role !== "personal_reviewer") {
    return errorResponse(403, "forbidden", "You do not have access to submit a decision on this run.");
  }
  if (!access.capabilities.canSubmitReview) {
    // A real, valid, currently-assigned reviewer, but the review is no
    // longer pending (terminal) — a distinct, more specific outcome than
    // "not authorized at all" (Part 5: reviewer retains read access,
    // never decision access, once terminal).
    return errorResponse(409, "terminal_review_exists", "This run already has a final review decision.");
  }

  // ---- Request validation — reused verbatim, zero duplication (Part 13) ----
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

  if (!preParse.ok) {
    if (preParse.reason === "absent") {
      return errorResponse(404, "governance_record_absent", "This run has no governance record to review.");
    }
    return errorResponse(500, "internal_error", "This run's governance record could not be read.");
  }
  const record = preParse.record;

  let reviewerName: string | undefined;
  try {
    const reviewerSnap = await adminDb.collection("users").doc(uid).get();
    const name = reviewerSnap.data()?.name;
    reviewerName = typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    reviewerName = undefined;
  }

  // ---- Transactional canonical write — the EXACT SAME function the team
  // decision route calls, completely unmodified. This function takes no
  // team parameter at all; it operates purely on runId. ----
  const reviewedAt = new Date().toISOString();
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
        return errorResponse(400, "validation_error", "Invalid review decision.");
    }
  }

  const { record: updatedRecord, priorHumanReviewStatus } = submitResult;

  // ---- Canonical success — everything below is best-effort audit/history,
  // never able to roll back or invalidate the already-committed decision. ----
  const newStatusForHistory = updatedRecord.humanReview.status;
  let historyStatus: "recorded" | "already_exists" | "failed" = "failed";
  let auditStatus: "recorded" | "already_exists" | "failed" = "failed";

  if (!isAdaptiveReviewTerminalStatus(newStatusForHistory)) {
    logger.warn("[user/runs/decision] Unexpected non-terminal status after a successful canonical review, skipping history/audit", { runId });
  } else {
    const decisionId = buildPersonalReviewDecisionId(runId, reviewedAt, newStatusForHistory);
    const priorStatusForHistory = isAdaptiveReviewNonTerminalStatus(priorHumanReviewStatus) ? priorHumanReviewStatus : "unreviewed";

    try {
      const historyEntry = buildAdaptiveHumanReviewHistoryEntry({
        decisionId,
        runId,
        teamId: null,
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
        logger.warn("[user/runs/decision] Immutable review-history write did not save after a successful canonical review", { runId, decisionId });
      }
    } catch {
      historyStatus = "failed";
      logger.warn("[user/runs/decision] Immutable review-history write threw after a successful canonical review", { runId });
    }

    try {
      const auditResult = await writeAdaptiveAdminAuditEvent({
        decisionId,
        actorUid: uid,
        teamId: null,
        runId,
        schemaId: record.schemaId,
        answerShape: record.answerShape,
        priorStatus: priorStatusForHistory,
        newStatus: newStatusForHistory,
        reviewedAt,
      });
      auditStatus = auditResult.status;
      if (auditStatus === "failed") {
        logger.warn("[user/runs/decision] Admin audit write did not save after a successful canonical review", { runId, decisionId });
      }
    } catch {
      auditStatus = "failed";
      logger.warn("[user/runs/decision] Admin audit write threw after a successful canonical review", { runId });
    }
  }

  return NextResponse.json({
    ok: true,
    review: {
      status: updatedRecord.humanReview.status,
      reviewedAt: updatedRecord.humanReview.reviewedAt,
    },
    historyStatus,
    auditStatus,
  });
}
