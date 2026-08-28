/**
 * Approval Workflow, Phase 9B.5.2 —
 * `POST /api/workspaces/{workspaceId}/runs/{runId}/review-panel/finalize`.
 * Deliberately NO Approval Workflow admission check — finalizing an
 * already-`ready` panel is a drain operation, mirroring the legacy
 * finalize route's own permanent design.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { teamRunWorkspaceNotFoundConcealedResponse, teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { finalizeWorkspaceReviewPanel, type FinalizeWorkspaceReviewPanelFailureReason } from "@/lib/workspaces/workspaceReviewPanelMutations";
import { isValidTimestamp } from "@/lib/adaptiveSchema/governanceRecordParser";
import type { TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function authDenialResponse(reason: TeamMutationAuthorizationDenialReason): NextResponse {
  if (reason === "insufficient_capability") {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }
  const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
  return NextResponse.json(body, { status });
}

function finalizeErrorResponse(reason: FinalizeWorkspaceReviewPanelFailureReason): NextResponse {
  // Phase 10C.1A: "team_workspaces_disabled" falls through to the same
  // concealed authDenialResponse() mapping as every other non-infrastructure
  // denial reason below, closing the rollout-admission oracle.
  if (reason === "firestore_unavailable" || reason === "write_failed" || reason === "aggregation_invalid" || reason === "vote_unreadable") {
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "run_not_found" || reason === "panel_absent") {
    const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "panel_cancelled") return errorResponse(409, "panel_cancelled", "This review panel has been cancelled.");
  if (reason === "panel_unreadable") return errorResponse(409, "panel_unreadable", "This run's review panel could not be read.");
  if (reason === "governance_stale") return errorResponse(409, "governance_stale", "This run has changed since you last viewed it. Please refresh and try again.");
  if (reason === "not_pending") return errorResponse(409, "not_pending", "This review is no longer pending.");
  if (reason === "panel_stale") return errorResponse(409, "panel_stale", "This panel changed since you last viewed it. Please refresh and try again.");
  if (reason === "quorum_not_met") return errorResponse(409, "quorum_not_met", "Not enough reviewers have voted yet.");
  if (reason === "panel_deadlocked") return errorResponse(409, "panel_deadlocked", "The panel's votes do not have a strict majority. Additional votes or reconfiguration are required.");
  if (reason === "inconsistent_finalization_state") return errorResponse(409, "inconsistent_finalization_state", "This run's review state is inconsistent and could not be verified.");
  return authDenialResponse(reason as TeamMutationAuthorizationDenialReason);
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: "/api/workspaces/[workspaceId]/runs/[runId]/review-panel/finalize", method: "POST", failureCategory: identity.reason });
    if (identity.reason === "missing_credentials") return errorResponse(401, "unauthorized", "Please sign in.");
    return errorResponse(401, "auth_error", "Authentication failed.");
  }
  const uid = identity.uid;
  const { workspaceId, runId } = params;

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

  const result = await finalizeWorkspaceReviewPanel({ uid, workspaceId, runId, expectedPanelRevision: body.expectedPanelRevision, expectedGovernanceUpdatedAt: body.expectedGovernanceUpdatedAt });
  if (!result.ok) return finalizeErrorResponse(result.reason);
  return NextResponse.json({ ok: true, finalization: { status: result.status, finalizedAt: result.finalizedAt } });
}
