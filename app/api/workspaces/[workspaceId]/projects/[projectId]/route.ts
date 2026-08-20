/**
 * Team Project Backend, Phase 8C-A — `PATCH /api/workspaces/{workspaceId}/projects/{projectId}`
 * (rename only). No `GET` handler at this path, mirroring the Personal
 * route's identical Phase 6C decision — Project detail UI is not part of
 * this slice (Section 3).
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { parseRenameProjectBody } from "@/lib/projects/projectMutationBody";
import { validateProjectName } from "@/lib/projects/projectName";
import { validateUpdateTimeToken } from "@/lib/projects/updateTimeToken";
import { updateTeamProjectFields } from "@/lib/firestore/teamProjects";
import { toTeamProjectSummaryDto } from "@/lib/projects/teamProjectDto";
import { writeProjectEvent } from "@/lib/projects/projectEvents";
import { teamWorkspacesDisabledResponse, invalidRequestBodyResponse, unexpectedFieldResponse, invalidUpdateTimeResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { invalidProjectNameResponse, staleUpdateTimeConflictResponse } from "@/lib/projects/projectErrorResponse";
import { teamProjectAuthorizationDeniedResponse, teamProjectNotFoundConcealedResponse, teamProjectInvalidStatusTransitionResponse } from "@/lib/projects/teamProjectErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "PATCH /api/workspaces/[workspaceId]/projects/[projectId]", method: "PATCH", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function PATCH(req: NextRequest, { params }: { params: { workspaceId: string; projectId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, projectId } = params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const parsedBody = parseRenameProjectBody(rawBody);
  if (!parsedBody.ok) {
    const { status, body } = parsedBody.reason === "unknown_field" ? unexpectedFieldResponse() : invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const nameResult = validateProjectName(parsedBody.name);
  if (!nameResult.ok) {
    const { status, body } = invalidProjectNameResponse();
    return NextResponse.json(body, { status });
  }

  const tokenResult = validateUpdateTimeToken(parsedBody.expectedUpdateTime);
  if (!tokenResult.ok) {
    const { status, body } = invalidUpdateTimeResponse();
    return NextResponse.json(body, { status });
  }

  const updateResult = await updateTeamProjectFields({
    uid,
    workspaceId,
    projectId,
    mutation: { kind: "rename", name: nameResult.name },
    expectedUpdateTime: tokenResult.timestamp,
  });

  switch (updateResult.status) {
    case "updated":
      await writeProjectEvent({ eventType: "project_renamed", actorUid: uid, workspaceId, projectId });
      return NextResponse.json({ ok: true, project: toTeamProjectSummaryDto(updateResult.project, updateResult.documentUpdateTime) });
    case "team_workspaces_disabled": {
      const { status, body } = teamWorkspacesDisabledResponse();
      return NextResponse.json(body, { status });
    }
    case "unauthorized": {
      const { status, body } = teamProjectAuthorizationDeniedResponse(updateResult.reason);
      return NextResponse.json(body, { status });
    }
    case "project_not_found": {
      const { status, body } = teamProjectNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    case "invalid_transition": {
      // Structurally unreachable for rename (no status precondition) —
      // handled anyway, fail-closed, rather than left as an unchecked case.
      const { status, body } = teamProjectInvalidStatusTransitionResponse();
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
