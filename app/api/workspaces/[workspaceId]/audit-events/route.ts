/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 —
 * `GET /api/workspaces/{workspaceId}/audit-events`. Read-only. v1 event
 * source: `workspaceMembershipEvents` only (`workspace_member_removed`).
 *
 * Deliberately independent of the legacy `/api/governance/audit` route:
 * no import from `lib/governance/`, no billing-plan gate, no
 * `governanceReviewerFor`/`governanceReviewerUid` relationship — per
 * PHASE TEAM-GOV-R1's architecture audit, Team Workspace administration
 * uses Workspace membership + capability authorization exclusively.
 *
 * Gate order (frozen):
 *   authentication -> resolveWorkspaceAuditAccess() (Team rollout
 *   admission + resolveWorkspaceAccess() + Team-type guard) ->
 *   audit.read capability -> bounded event read + safe identity
 *   enrichment (listWorkspaceAuditEvents()) -> response.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveWorkspaceAuditAccess } from "@/lib/workspaces/resolveWorkspaceAuditAccess";
import { teamAuditAccessDeniedResponse, teamAuditInsufficientCapabilityResponse } from "@/lib/workspaces/teamAuditAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { listWorkspaceAuditEvents, AUDIT_LOG_DEFAULT_LIMIT, AUDIT_LOG_MAX_LIMIT } from "@/lib/workspaces/listWorkspaceAuditEvents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/audit-events", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const workspaceId = params.workspaceId;

  const access = await resolveWorkspaceAuditAccess({ uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamAuditAccessDeniedResponse(access.reason);
    return NextResponse.json(body, { status });
  }
  // Centralized capability map only — never a hardcoded role comparison.
  if (!access.capabilities.includes("audit.read")) {
    const { status, body } = teamAuditInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }

  const { searchParams } = req.nextUrl;
  const limit = Math.min(AUDIT_LOG_MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") || String(AUDIT_LOG_DEFAULT_LIMIT), 10) || AUDIT_LOG_DEFAULT_LIMIT));
  const cursorRaw = searchParams.get("cursor");

  const result = await listWorkspaceAuditEvents({ workspaceId, limit, cursorRaw });
  switch (result.status) {
    case "ok":
      return NextResponse.json({
        ok: true,
        events: result.items,
        hasMore: result.hasMore,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      });
    case "invalid_cursor":
      return NextResponse.json({ ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." }, { status: 400 });
    case "query_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
