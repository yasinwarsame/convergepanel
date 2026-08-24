/**
 * Approval Workflow, Phase 9B.6 —
 * `GET /api/workspaces/{workspaceId}/runs/{runId}/reviewer-candidates`.
 * Powers assignment and panel reviewer selectors. NOT a general Workspace
 * member directory (Phase 9C.0 Correction C) — see
 * `lib/workspaces/reviewerCandidates.ts` for the eligibility rationale.
 *
 * Normal Approval Workflow admission required — no drain access (managers
 * configuring reviewer sets is "new work", never a drain surface).
 * Requires `reviews.manage` AND `research.read`, mirroring every other
 * manager-only Phase 9 mutation's explicit dual-capability requirement.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunWorkspaceNotFoundConcealedResponse, teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { getReviewerCandidates } from "@/lib/workspaces/reviewerCandidates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: "/api/workspaces/[workspaceId]/runs/[runId]/reviewer-candidates", method: "GET", failureCategory: identity.reason });
    if (identity.reason === "missing_credentials") return errorResponse(401, "unauthorized", "Please sign in.");
    return errorResponse(401, "auth_error", "Authentication failed.");
  }
  const uid = identity.uid;
  const { workspaceId, runId } = params;

  // Normal admission only — no drain access.
  const admission = resolveApprovalWorkflowAdmission({ uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (!admission.admitted) {
    const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }

  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamRunAccessDeniedResponse(access.reason);
    return NextResponse.json(body, { status });
  }
  if (!access.capabilities.includes("research.read") || !access.capabilities.includes("reviews.manage")) {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }

  const result = await getReviewerCandidates({ workspaceId, runId });
  switch (result.status) {
    case "ok":
      return NextResponse.json({ ok: true, reviewers: result.reviewers });
    case "run_not_found": {
      const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    case "query_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
