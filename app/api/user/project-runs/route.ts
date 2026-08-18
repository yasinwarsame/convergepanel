/**
 * Project Read Foundation, Phase 7A — `GET /api/user/project-runs`. The
 * read contract Phase 7's UI will consume: runs scoped to exactly one
 * Project (`?projectId=`), or exactly Unfiled (`?scope=unfiled`) — never
 * both, never neither. GET only, read-only; no mutation surface.
 *
 * Rollout: gated on `resolveProjectsMode()` (Project backend eligibility)
 * — the same gate every other Project route uses. Not rate-limited,
 * matching this codebase's established precedent that every rate-limited
 * route is a mutation; no paginated authenticated GET/list route here is.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { PROJECTS_ENABLED, PROJECTS_CANARY_UIDS } from "@/lib/env";
import { resolveProjectsMode } from "@/lib/projects/projectsRollout";
import { parseProjectRunsQuery } from "@/lib/projects/projectRunsQuery";
import { listProjectRunsForOwner } from "@/lib/projects/listProjectRunsForOwner";
import { toProjectSummaryDto } from "@/lib/projects/projectDto";
import { projectsDisabledResponse, projectNotFoundConcealedResponse, internalErrorResponse } from "@/lib/projects/projectErrorResponse";
import { personalWorkspaceErrorResponse } from "@/lib/workspaces/personalWorkspaceErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/project-runs", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const mode = resolveProjectsMode({ uid, globalEnabled: PROJECTS_ENABLED, canaryUidsRaw: PROJECTS_CANARY_UIDS });
  if (!mode.enabled) {
    const { status, body } = projectsDisabledResponse();
    return NextResponse.json(body, { status });
  }

  const parsedQuery = parseProjectRunsQuery(req.nextUrl.searchParams);
  if (!parsedQuery.ok) {
    const messages: Record<typeof parsedQuery.reason, string> = {
      missing_scope: "Specify either projectId or scope=unfiled.",
      ambiguous_scope: "Specify either projectId or scope=unfiled, not both.",
      unknown_scope: "Unsupported scope value.",
    };
    return NextResponse.json({ ok: false, errorCode: parsedQuery.reason, message: messages[parsedQuery.reason] }, { status: 400 });
  }

  const result = await listProjectRunsForOwner({ uid, scope: parsedQuery.scope, limit: parsedQuery.limit, cursorRaw: parsedQuery.cursorRaw });

  switch (result.status) {
    case "ok": {
      const scopeDto = parsedQuery.scope.type === "project" && result.projectMeta
        ? { type: "project" as const, project: toProjectSummaryDto(result.projectMeta.project, result.projectMeta.documentUpdateTime) }
        : { type: "unfiled" as const };
      return NextResponse.json({
        ok: true,
        items: result.items,
        hasMore: result.hasMore,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        scope: scopeDto,
      });
    }
    case "invalid_cursor":
      return NextResponse.json({ ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." }, { status: 400 });
    case "integrity_violation":
    case "query_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
    case "workspace_failure": {
      const { status, body } = personalWorkspaceErrorResponse(result.workspaceStatus);
      return NextResponse.json(body, { status });
    }
    case "project_failure": {
      const { status, body } = projectNotFoundConcealedResponse(result.projectStatus);
      return NextResponse.json(body, { status });
    }
  }
}
