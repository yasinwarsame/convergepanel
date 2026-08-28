/**
 * Team Project Backend, Phase 8C-A — `POST /api/workspaces/{workspaceId}/projects/{projectId}/restore`.
 * Mirror image of the archive route: `archived -> active`, same OCC
 * contract, same fresh-token-but-invalid-transition handling — see the
 * archive route's doc comment for why the lifecycle precondition is
 * validated inside `updateTeamProjectFields()`'s transaction rather than
 * at this route layer.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { parseStatusTransitionBody } from "@/lib/projects/projectMutationBody";
import { validateUpdateTimeToken } from "@/lib/projects/updateTimeToken";
import { updateTeamProjectFields } from "@/lib/firestore/teamProjects";
import { toTeamProjectSummaryDto } from "@/lib/projects/teamProjectDto";
import { writeTeamProjectEventSafely as writeSafely } from "@/lib/projects/writeTeamProjectEventSafely";
import { invalidRequestBodyResponse, unexpectedFieldResponse, invalidUpdateTimeResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { staleUpdateTimeConflictResponse } from "@/lib/projects/projectErrorResponse";
import { teamProjectAuthorizationDeniedResponse, teamProjectNotFoundConcealedResponse, teamProjectInvalidStatusTransitionResponse } from "@/lib/projects/teamProjectErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/workspaces/[workspaceId]/projects/[projectId]/restore", method: "POST", failureCategory: identity.reason });
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

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const parsedBody = parseStatusTransitionBody(rawBody);
  if (!parsedBody.ok) {
    const { status, body } = parsedBody.reason === "unknown_field" ? unexpectedFieldResponse() : invalidRequestBodyResponse();
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
    mutation: { kind: "restore" },
    expectedUpdateTime: tokenResult.timestamp,
  });

  switch (updateResult.status) {
    case "updated":
      await writeSafely({ eventType: "project_restored", actorUid: uid, workspaceId, projectId });
      return NextResponse.json({ ok: true, project: toTeamProjectSummaryDto(updateResult.project, updateResult.documentUpdateTime) });
    case "updated_projection_unavailable": {
      await writeSafely({ eventType: "project_restored", actorUid: uid, workspaceId, projectId });
      return NextResponse.json({
        ok: true,
        project: toTeamProjectSummaryDto(updateResult.project, null),
        projectionUnavailable: true,
        message: "The restore was applied, but we couldn't confirm the latest state. Refresh to load the current version before making further changes.",
      });
    }
    case "team_workspaces_disabled": {
      // Phase 10C.1A: concealed identically to "unauthorized" below.
      const { status, body } = teamProjectAuthorizationDeniedResponse("team_workspaces_disabled");
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
