/**
 * Approval Workflow, Phase 9B.5.1 —
 * `POST /api/workspaces/{workspaceId}/runs/{runId}/review-resubmit`.
 * A thin HTTP wrapper around `resubmitWorkspaceReview()` (Phase 9B.3) —
 * the transaction, OCC contract, authorization (creator-with-access OR
 * `reviews.manage` manager — never `reviews.submit`), and audit-event
 * semantics are entirely unchanged, reused verbatim. This route adds
 * nothing beyond admission gating, request parsing, and status mapping.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { teamRunWorkspaceNotFoundConcealedResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { teamWorkspacesDisabledResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { resubmitWorkspaceReview, type ResubmitWorkspaceReviewFailureReason } from "@/lib/workspaces/resubmitWorkspaceReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "/api/workspaces/[workspaceId]/runs/[runId]/review-resubmit", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") return errorResponse(401, "unauthorized", "Please sign in.");
  return errorResponse(401, "auth_error", "Authentication failed.");
}

function resubmitErrorResponse(reason: ResubmitWorkspaceReviewFailureReason): NextResponse {
  if (reason === "team_workspaces_disabled") {
    const { status, body } = teamWorkspacesDisabledResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "firestore_unavailable" || reason === "write_failed" || reason === "unsupported_version" || reason === "governance_record_malformed") {
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }
  if (
    reason === "run_not_found" ||
    reason === "governance_record_absent" ||
    reason === "workspace_not_found" ||
    reason === "workspace_malformed" ||
    reason === "membership_not_found" ||
    reason === "membership_removed" ||
    reason === "membership_malformed" ||
    reason === "owner_integrity_violation" ||
    reason === "not_creator_or_manager"
  ) {
    // Every "this caller may not see/act on this run" reason collapses to
    // the same concealed 404 — never a distinguishable oracle for whether
    // the run exists, belongs to a different Workspace, or the caller
    // simply isn't the creator/a manager.
    const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "stale_expected_updated_at") {
    return errorResponse(409, "stale_expected_updated_at", "This run has changed since you last viewed it. Please refresh and try again.");
  }
  if (reason === "not_changes_requested") {
    return errorResponse(409, "not_changes_requested", "This run is not currently in changes_requested — nothing to resubmit.");
  }
  // Exhaustiveness backstop — every ResubmitWorkspaceReviewFailureReason is handled above.
  const { status, body } = internalErrorResponse();
  return NextResponse.json(body, { status });
}

interface ResubmitBody {
  expectedUpdatedAt?: unknown;
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, runId } = params;

  const admission = resolveApprovalWorkflowAdmission({ uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (!admission.admitted) {
    const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON.");
  }
  const body = (rawBody ?? {}) as ResubmitBody;
  if (typeof body.expectedUpdatedAt !== "string" || body.expectedUpdatedAt.length === 0) {
    return errorResponse(400, "validation_error", "expectedUpdatedAt is required.");
  }

  const result = await resubmitWorkspaceReview({ uid, workspaceId, runId, expectedUpdatedAt: body.expectedUpdatedAt });
  if (!result.ok) return resubmitErrorResponse(result.reason);
  return NextResponse.json({ ok: true, review: { status: result.record.humanReview.status }, assignmentActionable: result.assignmentActionable });
}
