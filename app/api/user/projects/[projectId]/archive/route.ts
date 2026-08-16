/**
 * Project Foundation, Phase 6C — `POST /api/user/projects/{projectId}/archive`.
 * A dedicated action endpoint, not folded into the rename PATCH — archiving
 * is a meaningfully different, less-reversible-feeling operation worth its
 * own audit trail and its own explicit state-transition validation.
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
  logIdentityResolutionFailure({ route: "POST /api/user/projects/[projectId]/archive", method: "POST", failureCategory: identity.reason });
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

  // Staleness is checked FIRST, independent of the transition check —
  // your own stated preference: a stale expectedUpdateTime -> conflict,
  // even if the current status already happens to equal the requested
  // target. Idempotency is a client concern (refetch + retry), never
  // something the server papers over.
  if (!updateTimeTokensEqual(documentUpdateTime, tokenResult.timestamp)) {
    const { status, body } = staleUpdateTimeConflictResponse();
    return NextResponse.json(body, { status });
  }

  // Fresh token, but the transition itself doesn't apply — a repeated
  // archive request is NOT silently treated as success, per Phase 6A.2.
  if (project.status !== "active") {
    const { status, body } = invalidProjectStatusTransitionResponse();
    return NextResponse.json(body, { status });
  }

  const updateResult = await updateProjectFields({
    projectId: project.id,
    data: { status: "archived", updatedAt: Timestamp.now() },
    expectedUpdateTime: tokenResult.timestamp,
  });

  switch (updateResult.status) {
    case "updated":
      void writeProjectEvent({ eventType: "project_archived", actorUid: uid, workspaceId: project.workspaceId, projectId: project.id });
      return NextResponse.json({
        ok: true,
        project: toProjectSummaryDto({ ...project, status: "archived" }, updateResult.documentUpdateTime),
      });
    case "precondition_failed": {
      // A race landed here despite the two checks above passing — the
      // native Firestore precondition is the authoritative anti-race
      // guarantee, not those earlier checks. Reported the same way as
      // an early-detected stale token: a generic conflict, never a
      // distinguishable signal about what actually changed.
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
