/**
 * TEAM-VERIFICATION-PARITY-R5-I1 —
 * `GET /api/workspaces/{workspaceId}/projects/{projectId}/video-verifications`:
 * the durable Team Video verifications filed in exactly one Project.
 *
 * identity -> resolveTeamRunWorkspaceAccess -> research.read -> ONE Project
 * lookup and validation (exists, well formed, same Workspace) ->
 * listTeamVideoVerifications(scope "project"). A missing, malformed or
 * foreign-Workspace Project is concealed exactly like "doesn't exist"; a
 * Project lookup INFRASTRUCTURE failure is distinguished as the Team
 * lookup-unavailable response (503) so a transient outage is never mistaken
 * for "no such Project".
 *
 * An ARCHIVED Project stays readable — archiving withdraws the ability to file
 * NEW work, not the ability to read what is already filed — and
 * `research.organize` / `projects.manage` are never required to read. No
 * creator/uploader filter. Read-only: no write, provider, quota or governance.
 *
 * The addressed Project is validated exactly once, here; the list helper
 * receives its already-validated public DTO and performs no second Project
 * read.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse, teamRunLookupUnavailableResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { teamProjectNotFoundConcealedResponse } from "@/lib/projects/teamProjectErrorResponse";
import { getProject } from "@/lib/firestore/projects";
import { listTeamVideoVerifications } from "@/lib/workspaces/listTeamVideoVerifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/projects/[projectId]/video-verifications", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; projectId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, projectId } = params;

  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamRunAccessDeniedResponse(access.reason);
    return NextResponse.json(body, { status });
  }
  if (!access.capabilities.includes("research.read")) {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }

  const projectResult = await getProject(projectId);
  switch (projectResult.status) {
    case "not_found":
    case "malformed": {
      const { status, body } = teamProjectNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "read_failed": {
      const { status, body } = teamRunLookupUnavailableResponse();
      return NextResponse.json(body, { status });
    }
    case "found":
      break;
  }
  if (projectResult.project.workspaceId !== workspaceId) {
    // Cross-Workspace Project — concealed identically to not_found.
    const { status, body } = teamProjectNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }

  const { searchParams } = req.nextUrl;
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const cursorRaw = searchParams.get("cursor");
  const project = { id: projectResult.project.id, name: projectResult.project.name, status: projectResult.project.status };

  const result = await listTeamVideoVerifications({ workspaceId, scope: { kind: "project", project }, limit, cursorRaw });
  switch (result.status) {
    case "ok":
      return NextResponse.json({
        ok: true,
        items: result.items,
        hasMore: result.hasMore,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      });
    case "invalid_cursor":
      return NextResponse.json({ ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." }, { status: 400 });
    case "integrity_violation":
    case "query_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
