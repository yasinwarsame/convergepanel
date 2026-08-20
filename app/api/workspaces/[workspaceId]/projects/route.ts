/**
 * Team Project Backend, Phase 8C-A — `GET /api/workspaces/{workspaceId}/projects`
 * (list, active by default) and `POST /api/workspaces/{workspaceId}/projects`
 * (create). Gated by `TEAM_WORKSPACES_ENABLED`/`TEAM_WORKSPACES_CANARY_UIDS`
 * only — no separate `TEAM_PROJECTS_ENABLED` flag is introduced in this
 * slice (Section 10).
 *
 * GET is read-only and uses the existing, unmodified `resolveWorkspaceAccess()`
 * (Phase 8B) as its authoritative gate — no transaction-time
 * re-authorization is needed for a read (Section 6). POST uses the NEW
 * transaction-scoped `createTeamProject()` exclusively; `resolveWorkspaceAccess()`
 * is never used as an authoritative gate for a write (Section 12).
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { teamWorkspacesDisabledResponse, invalidRequestBodyResponse, unexpectedFieldResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { invalidProjectNameResponse, invalidProjectListStatusResponse, tooManyProjectsResponse } from "@/lib/projects/projectErrorResponse";
import { teamProjectAuthorizationDeniedResponse, teamWorkspaceReadNotFoundResponse } from "@/lib/projects/teamProjectErrorResponse";
import { parseProjectListStatusQuery } from "@/lib/projects/projectListStatusQuery";
import { parseCreateProjectBody } from "@/lib/projects/projectMutationBody";
import { validateProjectName } from "@/lib/projects/projectName";
import { listTeamProjects } from "@/lib/projects/listTeamProjects";
import { toTeamProjectSummaryDto } from "@/lib/projects/teamProjectDto";
import { createTeamProject } from "@/lib/firestore/teamProjects";
import { countProjectsInWorkspace } from "@/lib/firestore/projects";
import { writeProjectEvent } from "@/lib/projects/projectEvents";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_PROJECTS_PER_WORKSPACE = 200;

async function getUid(req: NextRequest, method: "GET" | "POST"): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: `${method} /api/workspaces/[workspaceId]/projects`, method, failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const uidOrRes = await getUid(req, "GET");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const workspaceId = params.workspaceId;

  const access = await resolveWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    if (access.reason === "team_workspaces_disabled") {
      const { status, body } = teamWorkspacesDisabledResponse();
      return NextResponse.json(body, { status });
    }
    const { status, body } = teamWorkspaceReadNotFoundResponse();
    return NextResponse.json(body, { status });
  }
  if (access.workspaceType !== "team") {
    const { status, body } = teamWorkspaceReadNotFoundResponse();
    return NextResponse.json(body, { status });
  }
  // Centralized capability map only — never a hardcoded role comparison.
  if (!access.capabilities.includes("projects.read")) {
    const { status, body } = teamProjectAuthorizationDeniedResponse("insufficient_capability");
    return NextResponse.json(body, { status });
  }

  const { searchParams } = req.nextUrl;
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const cursorRaw = searchParams.get("cursor");
  const statusResult = parseProjectListStatusQuery(searchParams);
  if (!statusResult.ok) {
    const { status: httpStatus, body } = invalidProjectListStatusResponse();
    return NextResponse.json(body, { status: httpStatus });
  }

  const result = await listTeamProjects({ workspaceId, limit, cursorRaw, status: statusResult.status });
  switch (result.status) {
    case "ok":
      return NextResponse.json({
        ok: true,
        items: result.items.map((item) => toTeamProjectSummaryDto(item.project, item.documentUpdateTime)),
        hasMore: result.hasMore,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      });
    case "invalid_cursor":
      return NextResponse.json({ ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." }, { status: 400 });
    case "integrity_violation":
    case "lookup_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const uidOrRes = await getUid(req, "POST");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const workspaceId = params.workspaceId;

  const rateLimitResult = await checkRateLimit({ maxRequests: 20, windowSeconds: 60, identifier: `team-project-create:${uid}` });
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

  // Best-effort abuse/storage guard — same non-authoritative posture as
  // the Personal create route's identical guard; never blocks on its own
  // failure, never itself an authorization decision.
  const countResult = await countProjectsInWorkspace(workspaceId);
  if (countResult.status === "ok" && countResult.count >= MAX_PROJECTS_PER_WORKSPACE) {
    const { status, body } = tooManyProjectsResponse();
    return NextResponse.json(body, { status });
  }
  if (countResult.status !== "ok") {
    logger.warn("[workspaces/projects] Project count guard failed, proceeding without it (fail-open on this specific abuse guard, not on authorization)", { workspaceId });
  }

  const createResult = await createTeamProject({ uid, workspaceId, name: nameResult.name });
  switch (createResult.status) {
    case "created": {
      await writeProjectEvent({ eventType: "project_created", actorUid: uid, workspaceId, projectId: createResult.project.id });
      return NextResponse.json({ ok: true, project: toTeamProjectSummaryDto(createResult.project, createResult.documentUpdateTime) }, { status: 201 });
    }
    case "team_workspaces_disabled": {
      const { status, body } = teamWorkspacesDisabledResponse();
      return NextResponse.json(body, { status });
    }
    case "unauthorized": {
      const { status, body } = teamProjectAuthorizationDeniedResponse(createResult.reason);
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "create_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
