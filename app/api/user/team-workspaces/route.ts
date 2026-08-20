/**
 * Team Workspace Core Foundation, Phase 8B — `POST /api/user/team-workspaces`,
 * the minimal API surface needed to exercise `createTeamWorkspace()`. No
 * GET/list endpoint, no member-management, no invitations — those are
 * later Phase 8 subphases (see docs/workspaces/phase8-team-workspace-foundation.md).
 *
 * Every identity-derived field is server-derived from the authenticated
 * uid alone (`resolveRequestIdentity()`, the same hardened resolver every
 * other `/api/user/**` route uses) — the request body is parsed ONLY for
 * `name`; no `ownerUserId`, `createdByUserId`, `type`, or `schemaVersion`
 * field is ever accepted from a client.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { parseCreateTeamWorkspaceBody } from "@/lib/workspaces/teamWorkspaceMutationBody";
import { validateTeamWorkspaceName } from "@/lib/workspaces/teamWorkspaceName";
import { createTeamWorkspace } from "@/lib/firestore/workspaceMemberships";
import { teamWorkspacesDisabledResponse, invalidRequestBodyResponse, unexpectedFieldResponse, invalidTeamWorkspaceNameResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: "POST /api/user/team-workspaces", method: "POST", failureCategory: identity.reason });
    if (identity.reason === "missing_credentials") {
      return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
    }
    return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
  }
  const uid = identity.uid;

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
