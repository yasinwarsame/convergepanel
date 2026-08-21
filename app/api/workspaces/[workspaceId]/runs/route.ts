/**
 * Team Run Lists, Phase 8C-B2 — `GET /api/workspaces/{workspaceId}/runs`
 * (general list, `research.read` scoped to the whole Workspace) and
 * `GET /api/workspaces/{workspaceId}/runs?scope=unfiled` (same route,
 * `projectId==null` only). Read-only; no run creation, no mutation, no
 * Project association of any kind.
 *
 * Authorization is `resolveTeamRunWorkspaceAccess()` (rollout-first,
 * reuses `resolveWorkspaceAccess()` exactly once, rejects any non-Team
 * grant) followed by an explicit `research.read` capability check —
 * never a creator/ownership check of any kind. `run.userId` plays no
 * role in whether this route returns a row.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { listTeamWorkspaceRuns, type TeamWorkspaceRunsScope } from "@/lib/workspaces/listTeamWorkspaceRuns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/runs", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function parseScope(searchParams: URLSearchParams): { ok: true; scope: TeamWorkspaceRunsScope } | { ok: false } {
  const raw = searchParams.get("scope");
  if (raw === null) return { ok: true, scope: "all" };
  if (raw === "unfiled") return { ok: true, scope: "unfiled" };
  return { ok: false };
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const workspaceId = params.workspaceId;

  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamRunAccessDeniedResponse(access.reason);
    return NextResponse.json(body, { status });
  }
  // Centralized capability map only — never a hardcoded role comparison,
  // never `run.userId === uid`, never a creator check.
  if (!access.capabilities.includes("research.read")) {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }

  const { searchParams } = req.nextUrl;
  const scopeResult = parseScope(searchParams);
  if (!scopeResult.ok) {
    return NextResponse.json({ ok: false, errorCode: "invalid_scope", message: "Unsupported scope value." }, { status: 400 });
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const cursorRaw = searchParams.get("cursor");

  const result = await listTeamWorkspaceRuns({ workspaceId, scope: scopeResult.scope, limit, cursorRaw });
  switch (result.status) {
    case "ok":
      return NextResponse.json({
        ok: true,
        items: result.items,
        hasMore: result.hasMore,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        scope: scopeResult.scope,
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
