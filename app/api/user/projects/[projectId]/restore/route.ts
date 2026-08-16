/**
 * Project Foundation, Phase 6C — `POST /api/user/projects/{projectId}/restore`.
 * Mirror image of the archive route: `archived -> active`, same OCC
 * contract, same fresh-token-but-invalid-transition handling.
 */

import { NextRequest, NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { PROJECTS_ENABLED, PROJECTS_CANARY_UIDS } from "@/lib/env";
import { resolveProjectsMode } from "@/lib/projects/projectsRollout";
import { resolveProjectForOwner } from "@/lib/projects/resolveProjectForOwner";
import { parseStatusTransitionBody } from "@/lib/projects/projectMutationBody";
import { validateUpdateTimeToken, updateTimeTokensEqual } from "@/lib/projects/updateTimeToken";
import { updateProjectFields } from "@/lib/firestore/projects";
import { toProjectSummaryDto } from "@/lib/projects/projectDto";
import { writeProjectEvent } from "@/lib/projects/projectEvents";
import {
  projectsDisabledResponse,
  projectNotFoundConcealedResponse,
  invalidRequestBodyResponse,
  unexpectedFieldResponse,
  invalidUpdateTimeResponse,
  staleUpdateTimeConflictResponse,
  invalidProjectStatusTransitionResponse,
  internalErrorResponse,
} from "@/lib/projects/projectErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/user/projects/[projectId]/restore", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const mode = resolveProjectsMode({ uid, globalEnabled: PROJECTS_ENABLED, canaryUidsRaw: PROJECTS_CANARY_UIDS });
  if (!mode.enabled) {
    const { status, body } = projectsDisabledResponse();
    return NextResponse.json(body, { status });
  }

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

  const resolveResult = await resolveProjectForOwner(uid, params.projectId);
  if (resolveResult.status !== "found") {
    const { status, body } = projectNotFoundConcealedResponse(resolveResult.status);
    return NextResponse.json(body, { status });
  }
  const { project, documentUpdateTime } = resolveResult;

  if (!updateTimeTokensEqual(documentUpdateTime, tokenResult.timestamp)) {
    const { status, body } = staleUpdateTimeConflictResponse();
    return NextResponse.json(body, { status });
  }

  if (project.status !== "archived") {
    const { status, body } = invalidProjectStatusTransitionResponse();
    return NextResponse.json(body, { status });
  }

  const updateResult = await updateProjectFields({
    projectId: project.id,
    data: { status: "active", updatedAt: Timestamp.now() },
    expectedUpdateTime: tokenResult.timestamp,
  });

  switch (updateResult.status) {
    case "updated":
      // Secondary, best-effort — awaited so the request lifetime covers
      // the attempt; writeProjectEvent catches/logs its own failure and
      // never turns this into a failed response.
      await writeProjectEvent({ eventType: "project_restored", actorUid: uid, workspaceId: project.workspaceId, projectId: project.id });
      return NextResponse.json({
        ok: true,
        project: toProjectSummaryDto({ ...project, status: "active" }, updateResult.documentUpdateTime),
      });
    case "precondition_failed": {
      const { status, body } = staleUpdateTimeConflictResponse();
      return NextResponse.json(body, { status });
    }
    case "not_found": {
      const { status, body } = projectNotFoundConcealedResponse("not_found");
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "update_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
