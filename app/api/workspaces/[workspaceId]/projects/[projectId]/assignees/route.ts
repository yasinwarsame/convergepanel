/**
 * Project/Research Assignment —
 * `POST /api/workspaces/{workspaceId}/projects/{projectId}/assignees`. Sets
 * a Team Project's full assignee list (D1/D3). POST only.
 *
 * Thin route: identity → UID-scoped rate limit → strict body → one
 * `updateTeamProjectFields({kind: "set_assignees"})` call → exhaustive
 * response mapping. Performs NO non-transactional authorization read of
 * its own; the primitive owns Team admission, the dedicated Project
 * Assignment admission (D10), the transaction-scoped `projects.manage`
 * check, canonicalization and the 20-unique bound BEFORE any membership
 * read, target validation on every write, OCC before no-op, and the
 * in-transaction audit event.
 *
 * The route's own raw-array ceiling (`MAX_RAW_ASSIGNEE_UIDS`) is a
 * convenience rejection; correctness never depends on it.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { parseProjectAssigneesBody } from "@/lib/projects/assignmentBody";
import { validateUpdateTimeToken } from "@/lib/projects/updateTimeToken";
import { updateTeamProjectFields } from "@/lib/firestore/teamProjects";
import { enrichTeamProjectDtos } from "@/lib/workspaces/teamProjectAssigneeEnrichment";
import { invalidRequestBodyResponse, unexpectedFieldResponse, internalErrorResponse, invalidUpdateTimeResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { teamProjectAuthorizationDeniedResponse, teamProjectNotFoundConcealedResponse } from "@/lib/projects/teamProjectErrorResponse";
import { projectArchivedTargetResponse, staleUpdateTimeConflictResponse, invalidProjectStatusTransitionResponse } from "@/lib/projects/projectErrorResponse";
import { assigneeNotEligibleResponse, tooManyAssigneesResponse } from "@/lib/projects/assignmentErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/workspaces/[workspaceId]/projects/[projectId]/assignees", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; projectId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, projectId } = params;

  // UID-scoped, never Workspace-scoped.
  const rateLimitResult = await checkRateLimit({ maxRequests: 20, windowSeconds: 60, identifier: `team-project-assignees:${uid}` });
  if (!rateLimitResult.allowed) {
    return NextResponse.json({ ok: false, errorCode: "rate_limited", message: "Too many requests. Please try again shortly." }, { status: 429 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const parsedBody = parseProjectAssigneesBody(rawBody);
  if (!parsedBody.ok) {
    if (parsedBody.reason === "unknown_field") {
      const { status, body } = unexpectedFieldResponse();
      return NextResponse.json(body, { status });
    }
    if (parsedBody.reason === "oversized") {
      const { status, body } = tooManyAssigneesResponse();
      return NextResponse.json(body, { status });
    }
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const tokenResult = validateUpdateTimeToken(parsedBody.expectedUpdateTime);
  if (!tokenResult.ok) {
    const { status, body } = invalidUpdateTimeResponse();
    return NextResponse.json(body, { status });
  }

  const result = await updateTeamProjectFields({
    uid,
    workspaceId,
    projectId,
    mutation: { kind: "set_assignees", assigneeUids: parsedBody.assigneeUids },
    expectedUpdateTime: tokenResult.timestamp,
  });

  switch (result.status) {
    case "updated": {
      const [dto] = await enrichTeamProjectDtos(workspaceId, [{ project: result.project, documentUpdateTime: result.documentUpdateTime }]);
      return NextResponse.json({ ok: true, changed: true, project: dto });
    }
    case "updated_projection_unavailable": {
      const [dto] = await enrichTeamProjectDtos(workspaceId, [{ project: result.project, documentUpdateTime: null }]);
      return NextResponse.json({ ok: true, changed: true, project: dto, projectionUnavailable: true });
    }
    case "unchanged": {
      const [dto] = await enrichTeamProjectDtos(workspaceId, [{ project: result.project, documentUpdateTime: result.documentUpdateTime }]);
      return NextResponse.json({ ok: true, changed: false, project: dto });
    }
    case "team_workspaces_disabled":
    case "project_assignment_disabled": {
      // Concealed identically to "unauthorized" — never a rollout oracle.
      const { status, body } = teamProjectAuthorizationDeniedResponse("team_workspaces_disabled");
      return NextResponse.json(body, { status });
    }
    case "unauthorized": {
      const { status, body } = teamProjectAuthorizationDeniedResponse(result.reason);
      return NextResponse.json(body, { status });
    }
    case "project_not_found": {
      const { status, body } = teamProjectNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    case "project_archived": {
      const { status, body } = projectArchivedTargetResponse();
      return NextResponse.json(body, { status });
    }
    case "invalid_transition": {
      // Structurally unreachable for set_assignees; mapped rather than assumed away.
      const { status, body } = invalidProjectStatusTransitionResponse();
      return NextResponse.json(body, { status });
    }
    case "invalid_assignees": {
      const { status, body } = invalidRequestBodyResponse();
      return NextResponse.json(body, { status });
    }
    case "too_many_assignees": {
      const { status, body } = tooManyAssigneesResponse();
      return NextResponse.json(body, { status });
    }
    case "assignee_not_eligible": {
      const { status, body } = assigneeNotEligibleResponse();
      return NextResponse.json(body, { status });
    }
    case "precondition_failed": {
      const { status, body } = staleUpdateTimeConflictResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "update_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
