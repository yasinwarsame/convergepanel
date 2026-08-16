/**
 * Project Foundation, Phase 6C — `GET /api/user/projects` (list, active
 * only) and `POST /api/user/projects` (create). Backend-dark by default:
 * `PROJECTS_ENABLED`/`PROJECTS_CANARY_UIDS` are both absent in production,
 * so every request here currently short-circuits at the rollout gate,
 * before any Project read or write — see `resolveProjectsMode()`.
 */

import { NextRequest, NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { logger } from "@/lib/logger";
import { PROJECTS_ENABLED, PROJECTS_CANARY_UIDS } from "@/lib/env";
import { resolveProjectsMode } from "@/lib/projects/projectsRollout";
import { resolvePersonalWorkspaceForOwner } from "@/lib/workspaces/resolvePersonalWorkspaceForOwner";
import { personalWorkspaceErrorResponse } from "@/lib/workspaces/personalWorkspaceErrorResponse";
import { validateProjectName } from "@/lib/projects/projectName";
import { parseCreateProjectBody } from "@/lib/projects/projectMutationBody";
import { createProject, countProjectsInWorkspace } from "@/lib/firestore/projects";
import { toProjectSummaryDto } from "@/lib/projects/projectDto";
import { writeProjectEvent } from "@/lib/projects/projectEvents";
import { listProjectsForOwner } from "@/lib/projects/listProjectsForOwner";
import {
  projectsDisabledResponse,
  invalidRequestBodyResponse,
  unexpectedFieldResponse,
  invalidProjectNameResponse,
  tooManyProjectsResponse,
  internalErrorResponse,
} from "@/lib/projects/projectErrorResponse";
import { checkRateLimit } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_PROJECTS_PER_WORKSPACE = 200;

async function getUid(req: NextRequest, method: "GET" | "POST"): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: `${method} /api/user/projects`, method, failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

/** Shared by GET and POST — the backend rollout gate always runs immediately after authentication, before any Project data access. */
function checkProjectsEnabled(uid: string): NextResponse | null {
  const mode = resolveProjectsMode({ uid, globalEnabled: PROJECTS_ENABLED, canaryUidsRaw: PROJECTS_CANARY_UIDS });
  if (!mode.enabled) {
    const { status, body } = projectsDisabledResponse();
    return NextResponse.json(body, { status });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const uidOrRes = await getUid(req, "GET");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const gateRes = checkProjectsEnabled(uid);
  if (gateRes) return gateRes;

  const { searchParams } = req.nextUrl;
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const cursorRaw = searchParams.get("cursor");

  const result = await listProjectsForOwner({ uid, limit, cursorRaw });

  switch (result.status) {
    case "ok":
      return NextResponse.json({
        ok: true,
        items: result.items.map((item) => toProjectSummaryDto(item.project, item.documentUpdateTime)),
        hasMore: result.hasMore,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      });
    case "invalid_cursor":
      return NextResponse.json({ ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." }, { status: 400 });
    case "integrity_violation": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
    case "workspaces_disabled":
    case "invalid_uid":
    case "not_found":
    case "malformed":
    case "wrong_owner":
    case "wrong_type":
    case "lookup_failed": {
      const { status, body } = personalWorkspaceErrorResponse(result.status);
      return NextResponse.json(body, { status });
    }
  }
}

export async function POST(req: NextRequest) {
  const uidOrRes = await getUid(req, "POST");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const gateRes = checkProjectsEnabled(uid);
  if (gateRes) return gateRes;

  const rateLimitResult = await checkRateLimit({ maxRequests: 20, windowSeconds: 60, identifier: `project-create:${uid}` });
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

  const parsedBody = parseCreateProjectBody(rawBody);
  if (!parsedBody.ok) {
    const { status, body } = parsedBody.reason === "unknown_field" ? unexpectedFieldResponse() : invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const nameResult = validateProjectName(parsedBody.name);
  if (!nameResult.ok) {
    const { status, body } = invalidProjectNameResponse();
    return NextResponse.json(body, { status });
  }

  // Project creation must never provision a Workspace as a side effect —
  // reuses the exact same prerequisite check GET /api/user/workspace and
  // GET /api/user/workspace/runs already use, never a separate/weaker one.
  const workspaceResult = await resolvePersonalWorkspaceForOwner(uid);
  if (workspaceResult.status !== "found") {
    const { status, body } = personalWorkspaceErrorResponse(workspaceResult.status);
    return NextResponse.json(body, { status });
  }
  const workspaceId = workspaceResult.workspace.id;

  // Best-effort abuse/storage guard — counts active + archived together
  // so archiving can never be used to bypass it. Not race-safe under true
  // concurrency; see countProjectsInWorkspace()'s own doc comment.
  const countResult = await countProjectsInWorkspace(workspaceId);
  if (countResult.status === "ok" && countResult.count >= MAX_PROJECTS_PER_WORKSPACE) {
    const { status, body } = tooManyProjectsResponse();
    return NextResponse.json(body, { status });
  }
  if (countResult.status !== "ok") {
    logger.warn("[projects] Project count guard failed, proceeding without it (fail-open on this specific abuse guard, not on authorization)", { workspaceId });
  }

  const createResult = await createProject({ workspaceId, name: nameResult.name, createdByUserId: uid });
  if (createResult.status !== "created") {
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }

  // Secondary, best-effort — the response below is a success regardless
  // of whether this write succeeds (writeProjectEvent catches/logs its own
  // failure internally). Awaited so the request lifetime covers the
  // attempt rather than leaving it to finish after the response is sent.
  await writeProjectEvent({
    eventType: "project_created",
    actorUid: uid,
    workspaceId,
    projectId: createResult.project.id,
  });

  return NextResponse.json({ ok: true, project: toProjectSummaryDto(createResult.project, createResult.documentUpdateTime) }, { status: 201 });
}
