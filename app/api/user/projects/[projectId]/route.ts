/**
 * Project Foundation, Phase 6C — `PATCH /api/user/projects/{projectId}`
 * (rename only). Deliberately NO `GET` handler at this path — Phase 6C
 * does not implement a Project detail endpoint; the list DTO already
 * carries every field Phase 7 needs.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { PROJECTS_ENABLED, PROJECTS_CANARY_UIDS } from "@/lib/env";
import { resolveProjectsMode } from "@/lib/projects/projectsRollout";
import { resolveProjectForOwner } from "@/lib/projects/resolveProjectForOwner";
import { validateProjectName } from "@/lib/projects/projectName";
import { parseRenameProjectBody } from "@/lib/projects/projectMutationBody";
import { validateUpdateTimeToken, updateTimeTokensEqual } from "@/lib/projects/updateTimeToken";
import { updateProjectFields } from "@/lib/firestore/projects";
import { toProjectSummaryDto } from "@/lib/projects/projectDto";
import { writeProjectEvent } from "@/lib/projects/projectEvents";
import {
  projectsDisabledResponse,
  projectNotFoundConcealedResponse,
  invalidRequestBodyResponse,
  unexpectedFieldResponse,
  invalidProjectNameResponse,
  invalidUpdateTimeResponse,
  staleUpdateTimeConflictResponse,
  internalErrorResponse,
} from "@/lib/projects/projectErrorResponse";
import { Timestamp } from "firebase-admin/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "PATCH /api/user/projects/[projectId]", method: "PATCH", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function PATCH(req: NextRequest, { params }: { params: { projectId: string } }) {
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

  // Authorization: existence, ownership, Workspace validity — all
  // resolved through the unmodified Phase 6B resolver. Rename is allowed
  // regardless of current status (active or archived) — no status
  // transition to validate here, only freshness.
  const resolveResult = await resolveProjectForOwner(uid, params.projectId);
  if (resolveResult.status !== "found") {
    const { status, body } = projectNotFoundConcealedResponse(resolveResult.status);
    return NextResponse.json(body, { status });
  }
  const { project, documentUpdateTime } = resolveResult;

  // Early, clear rejection for the common case — the AUTHORITATIVE
  // anti-race guarantee is the native Firestore precondition passed to
  // updateProjectFields() below, not this comparison; a concurrent write
  // landing between this check and that call is still caught there.
  if (!updateTimeTokensEqual(documentUpdateTime, tokenResult.timestamp)) {
    const { status, body } = staleUpdateTimeConflictResponse();
    return NextResponse.json(body, { status });
  }

  const updateResult = await updateProjectFields({
    projectId: project.id,
    data: { name: nameResult.name, updatedAt: Timestamp.now() },
    expectedUpdateTime: tokenResult.timestamp,
  });

  switch (updateResult.status) {
    case "updated":
      // Secondary, best-effort — awaited so the request lifetime covers
      // the attempt; writeProjectEvent catches/logs its own failure and
      // never turns this into a failed response.
      await writeProjectEvent({ eventType: "project_renamed", actorUid: uid, workspaceId: project.workspaceId, projectId: project.id });
      return NextResponse.json({
        ok: true,
        project: toProjectSummaryDto({ ...project, name: nameResult.name }, updateResult.documentUpdateTime),
      });
    case "precondition_failed": {
      const { status, body } = staleUpdateTimeConflictResponse();
      return NextResponse.json(body, { status });
    }
    case "not_found": {
      // Structurally unreachable in practice — resolveProjectForOwner
      // just confirmed this Project exists and there is no delete
      // capability anywhere yet. Handled fail-closed regardless, with
      // the same concealed 404 an existence failure always gets.
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
