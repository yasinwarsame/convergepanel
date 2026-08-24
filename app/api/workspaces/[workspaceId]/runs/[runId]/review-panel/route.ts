/**
 * Approval Workflow, Phase 9B.5.2 —
 * `GET/PUT/DELETE /api/workspaces/{workspaceId}/runs/{runId}/review-panel`.
 * Workspace-qualified multi-reviewer panel management. Adaptive Deep
 * Research only; legacy Team panel route
 * (`/api/teams/adaptive-runs/[runId]/review-panel`) is completely untouched
 * by this file.
 *
 * PUT/DELETE deliberately do NOT duplicate `reviews.manage`/`research.read`
 * at the route layer — both are checked exactly once, inside the mutation
 * service's own transaction (`authorizeTeamWorkspaceMutationInTransaction()`
 * + an explicit `research.read` check against the same membership
 * snapshot), so there is never a second, independent authorization window
 * between a route-level pre-check and the write (mirrors 9B.5.1's
 * assignment route exactly, including its 9B.5.1-R1C correction).
 *
 * GET's admission ordering is DELIBERATELY DIFFERENT from every other
 * Phase 9 route (§60 of the Phase 9B.5.2 spec): Team Workspace access is
 * established FIRST, and the Approval Workflow admission decision is
 * deferred into `getWorkspaceReviewPanel()` itself — because whether "not
 * admitted" should conceal or drain-read an existing panel can only be
 * decided after reading whether a panel exists, and querying that sensitive
 * target state before Team Workspace access is established would be
 * unsafe. Every other route in this file, and every route in 9B.5.1,
 * checks Approval Workflow admission before any Firestore access at all —
 * this is the one narrow, justified exception.
 *
 * PUT (create/reconfigure) requires Approval Workflow admission at the
 * route layer, like every other Phase 9 mutation — creating new panel
 * activity is never a drain operation. DELETE (cancel) requires NEITHER —
 * cancelling an already-open panel is a drain operation, mirroring the
 * legacy panel route's own permanent, documented design.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunWorkspaceNotFoundConcealedResponse, teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { teamWorkspacesDisabledResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import {
  getWorkspaceReviewPanel,
  putWorkspaceReviewPanel,
  deleteWorkspaceReviewPanel,
  validateWorkspacePanelReviewerUserIds,
  type PutWorkspaceReviewPanelFailureReason,
  type DeleteWorkspaceReviewPanelFailureReason,
} from "@/lib/workspaces/workspaceReviewPanelMutations";
import type { TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

async function getUid(req: NextRequest, method: string): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "/api/workspaces/[workspaceId]/runs/[runId]/review-panel", method, failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") return errorResponse(401, "unauthorized", "Please sign in.");
  return errorResponse(401, "auth_error", "Authentication failed.");
}

function checkApprovalAdmission(uid: string): NextResponse | null {
  const admission = resolveApprovalWorkflowAdmission({ uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (admission.admitted) return null;
  const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
  return NextResponse.json(body, { status });
}

function authDenialResponse(reason: TeamMutationAuthorizationDenialReason): NextResponse {
  if (reason === "insufficient_capability") {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }
  const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
  return NextResponse.json(body, { status });
}

function mutationErrorResponse(reason: PutWorkspaceReviewPanelFailureReason | DeleteWorkspaceReviewPanelFailureReason): NextResponse {
  if (reason === "team_workspaces_disabled") {
    const { status, body } = teamWorkspacesDisabledResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "firestore_unavailable" || reason === "write_failed") {
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "run_not_found") {
    const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "panel_finalized") return errorResponse(409, "panel_finalized", "This review panel has been finalized and can no longer be changed.");
  if (reason === "panel_already_cancelled") return errorResponse(409, "panel_cancelled", "This review panel has been cancelled and cannot be reopened.");
  if (reason === "panel_unreadable") return errorResponse(409, "panel_unreadable", "This run's review panel could not be read.");
  if (reason === "panel_absent") return errorResponse(404, "panel_absent", "No review panel exists for this run.");
  if (reason === "single_review_active") {
    return errorResponse(409, "single_review_active", "This run has an active single-reviewer assignment. Remove it before starting a panel review.");
  }
  if (reason === "not_pending") return errorResponse(409, "not_pending", "This review is no longer pending — the panel can only change while a review is pending.");
  if (reason === "stale_revision") return errorResponse(409, "panel_stale", "This panel changed since you last viewed it. Please refresh and try again.");
  if (typeof reason === "object" && reason.kind === "target_not_eligible") {
    return errorResponse(400, "target_not_eligible", "One or more proposed reviewers are not currently eligible to review this run.");
  }
  return authDenialResponse(reason as TeamMutationAuthorizationDenialReason);
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req, "GET");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, runId } = params;

  // Team Workspace access FIRST — see module doc comment for why GET's
  // ordering deliberately differs from every other Phase 9 route.
  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamRunAccessDeniedResponse(access.reason);
    return NextResponse.json(body, { status });
  }
  if (!access.capabilities.includes("research.read") || !access.capabilities.includes("reviews.read")) {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }

  const admission = resolveApprovalWorkflowAdmission({ uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  const result = await getWorkspaceReviewPanel({ workspaceId, runId, approvalAdmitted: admission.admitted });
  switch (result.status) {
    case "ok":
      return NextResponse.json({ ok: true, panel: result.panel });
    case "run_not_found":
    case "not_admitted": {
      const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    case "panel_unreadable":
      return errorResponse(409, "panel_unreadable", "This run's review panel could not be read.");
    case "firestore_unavailable":
    case "read_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}

interface PutBody {
  reviewerUserIds?: unknown;
  expectedRevision?: unknown;
}

export async function PUT(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req, "PUT");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, runId } = params;

  const admissionDenial = checkApprovalAdmission(uid);
  if (admissionDenial) return admissionDenial;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON.");
  }
  const body = (rawBody ?? {}) as PutBody;

  const reviewerIdsResult = validateWorkspacePanelReviewerUserIds(body.reviewerUserIds);
  if (!reviewerIdsResult.ok) {
    if (reviewerIdsResult.reason === "invalid_shape") return errorResponse(400, "validation_error", "reviewerUserIds must be a non-empty array of user IDs.");
    if (reviewerIdsResult.reason === "duplicates") return errorResponse(400, "validation_error", "reviewerUserIds must not contain duplicates.");
    return errorResponse(400, "validation_error", "reviewerUserIds must contain between 2 and 9 reviewers.");
  }

  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    return errorResponse(400, "validation_error", "expectedRevision must be a non-negative integer.");
  }

  const result = await putWorkspaceReviewPanel({ uid, workspaceId, runId, reviewerUserIds: reviewerIdsResult.value, expectedRevision: body.expectedRevision });
  if (!result.ok) return mutationErrorResponse(result.reason);
  return NextResponse.json({ ok: true, panel: result.panel });
}

interface DeleteBody {
  expectedRevision?: unknown;
}

export async function DELETE(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req, "DELETE");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, runId } = params;

  // Deliberately NO Approval Workflow admission check — cancelling an
  // already-open panel is a drain operation, mirroring the legacy panel
  // route's own permanent design.

  let expectedRevision = 0;
  try {
    const rawBody = await req.json();
    const body = (rawBody ?? {}) as DeleteBody;
    if (body.expectedRevision !== undefined) {
      if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
        return errorResponse(400, "validation_error", "expectedRevision must be a non-negative integer.");
      }
      expectedRevision = body.expectedRevision;
    }
  } catch {
    // A body-less DELETE is valid — expectedRevision defaults to 0, matching the 9B.5.1 assignment route's own convention.
  }

  const result = await deleteWorkspaceReviewPanel({ uid, workspaceId, runId, expectedRevision });
  if (!result.ok) return mutationErrorResponse(result.reason);
  return NextResponse.json({ ok: true });
}
