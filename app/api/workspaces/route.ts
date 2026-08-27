/**
 * Team Workspace Core Foundation, Phase 8B — `POST /api/workspaces`, the
 * minimal API surface needed to exercise `createTeamWorkspace()`, at the
 * frozen Phase 8A Team API namespace root (`/api/workspaces/{workspaceId}/...`
 * — this route creates the `{workspaceId}` those later paths address).
 *
 * Every identity-derived field is server-derived from the authenticated
 * uid alone (`resolveRequestIdentity()`, the same hardened resolver every
 * other authenticated route in this codebase uses) — the request body is
 * parsed ONLY for `name`; no `ownerUserId`, `createdByUserId`, `type`, or
 * `schemaVersion` field is ever accepted from a client.
 *
 * Gated by `TEAM_WORKSPACES_ENABLED`/`TEAM_WORKSPACES_CANARY_UIDS`
 * (`lib/workspaces/teamWorkspacesRollout.ts`) — checked inside
 * `createTeamWorkspace()` itself before any Firestore access, mirroring
 * `PROJECTS_ENABLED`/`PROJECTS_CANARY_UIDS`'s existing precedent.
 *
 * Phase 9C.1-R1C adds `GET /api/workspaces` — the general "list the Team
 * Workspaces I actively belong to" discovery/selection surface, added at
 * this same resource root rather than inventing a duplicate endpoint (the
 * corrective prompt's explicit preference). It exists to let the Reviews
 * UI present an explicit chooser when a uid has more than one active
 * Team Workspace (see `resolveViewerTeamWorkspaceSelection()` /
 * `listViewerTeamWorkspaces()`) — never a Workspace authorization
 * shortcut; every later read/mutation still authorizes the selected
 * Workspace independently.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { parseCreateTeamWorkspaceBody } from "@/lib/workspaces/teamWorkspaceMutationBody";
import { validateTeamWorkspaceName } from "@/lib/workspaces/teamWorkspaceName";
import { createTeamWorkspace } from "@/lib/firestore/workspaceMemberships";
import { teamWorkspacesDisabledResponse, invalidRequestBodyResponse, unexpectedFieldResponse, invalidTeamWorkspaceNameResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";
import { listViewerTeamWorkspaces, VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE, VIEWER_WORKSPACE_LIST_MAX_PAGE_SIZE } from "@/lib/workspaces/listViewerTeamWorkspaces";
import { listWorkspaceCanaryMembershipsForUid } from "@/lib/workspaces/resolveWorkspaceCanaryMembershipsForUid";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveUidOrErrorResponse(req: NextRequest, method: "GET" | "POST"): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: `${method} /api/workspaces`, method, failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const uidOrRes = await resolveUidOrErrorResponse(req, "GET");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const rollout = resolveTeamWorkspacesMode({ uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });

  if (rollout.enabled) {
    // MODE A — global/uid-canary admitted. Unchanged existing behavior,
    // unchanged pagination/cursor semantics — never touched by the
    // Workspace-canary branch below.
    const { searchParams } = req.nextUrl;
    const limitRaw = parseInt(searchParams.get("limit") || String(VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE), 10);
    const limit = Math.min(VIEWER_WORKSPACE_LIST_MAX_PAGE_SIZE, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE));
    const cursor = searchParams.get("cursor");

    const result = await listViewerTeamWorkspaces({ uid, cursor, limit });
    if (result.status !== "ok") {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }

    return NextResponse.json({ ok: true, items: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore }, { status: 200 });
  }

  // MODE B — not global/uid-canary admitted. Bounded (≤10) Workspace-canary
  // discovery: a fully non-admitted caller and a caller who belongs to
  // zero admitted Workspaces are byte-identically concealed as the SAME
  // 503 this route has always returned for "not admitted" — a caller can
  // never distinguish "no Workspace-canary list configured" from "list
  // configured but I have no active membership in any of it."
  const canaryResult = await listWorkspaceCanaryMembershipsForUid({ uid, canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS });
  if (canaryResult.status !== "ok") {
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }
  if (canaryResult.items.length === 0) {
    const { status, body } = teamWorkspacesDisabledResponse();
    return NextResponse.json(body, { status });
  }

  // Bounded by construction (≤10 configured ids) — never paginate this
  // branch, and never mix its cursor semantics with Mode A's.
  return NextResponse.json({ ok: true, items: canaryResult.items, nextCursor: null, hasMore: false }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const uidOrRes = await resolveUidOrErrorResponse(req, "POST");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const parsedBody = parseCreateTeamWorkspaceBody(rawBody);
  if (!parsedBody.ok) {
    const { status, body } = parsedBody.reason === "unknown_field" ? unexpectedFieldResponse() : invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const nameResult = validateTeamWorkspaceName(parsedBody.name);
  if (!nameResult.ok) {
    const { status, body } = invalidTeamWorkspaceNameResponse();
    return NextResponse.json(body, { status });
  }

  const result = await createTeamWorkspace({ uid, name: nameResult.name });

  switch (result.status) {
    case "created":
      return NextResponse.json({ ok: true, workspace: result.workspace, membership: result.membership }, { status: 201 });
    case "team_workspaces_disabled": {
      const { status, body } = teamWorkspacesDisabledResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "create_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
