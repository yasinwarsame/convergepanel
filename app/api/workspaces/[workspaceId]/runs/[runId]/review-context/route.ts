/**
 * Approval Workflow, Phase 9B.6 —
 * `GET /api/workspaces/{workspaceId}/runs/{runId}/review-context`.
 * One consolidated, read-only presentation model for the Phase 9C
 * run-review UI — see `lib/workspaces/reviewContext.ts` for the full
 * admission-model and `viewer.can*` design rationale.
 *
 * Admission ordering deliberately mirrors the Phase 9B.5.2 panel GET
 * route, NOT the simpler "Approval gate before any Firestore access"
 * pattern every other Phase 9 route uses: Team Workspace access is
 * established FIRST, and the Approval-admission decision is deferred into
 * `getReviewContext()` itself, because whether "not admitted" should
 * conceal or drain-return this run's context depends on whether an
 * existing PANEL makes it drain-eligible — which can only be known after
 * reading state that must not be queried before Team Workspace access is
 * established.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunWorkspaceNotFoundConcealedResponse, teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { getReviewContext } from "@/lib/workspaces/reviewContext";
import type { WorkspaceReviewCandidate } from "@/lib/workspaces/workspaceReviewEligibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: "/api/workspaces/[workspaceId]/runs/[runId]/review-context", method: "GET", failureCategory: identity.reason });
    if (identity.reason === "missing_credentials") return errorResponse(401, "unauthorized", "Please sign in.");
    return errorResponse(401, "auth_error", "Authentication failed.");
  }
  const uid = identity.uid;
  const { workspaceId, runId } = params;

  // Team Workspace access FIRST — see module doc comment.
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
  const callerCandidate: WorkspaceReviewCandidate = { uid, workspaceId, role: access.membership.role, status: access.membership.status };

  const result = await getReviewContext({ workspaceId, runId, uid, callerCandidate, approvalAdmitted: admission.admitted });
  switch (result.status) {
    case "ok":
      return NextResponse.json({ ok: true, context: result.context });
    case "run_not_found":
    case "not_admitted": {
      const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "read_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
