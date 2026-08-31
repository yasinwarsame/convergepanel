/**
 * Team Member Management, Phase 12A — `POST /api/workspaces/{workspaceId}/members/{uid}/remove`.
 * Thin HTTP orchestration over `removeWorkspaceMembership()`
 * (`lib/firestore/workspaceMemberships.ts`) — this route never re-derives
 * authorization, owner-integrity, target-role policy, capacity, or
 * idempotency; all of that remains exclusively inside that transaction.
 *
 * Deliberately an empty request body: every canonical fact this action
 * needs (actor identity, Workspace, target uid) is already derivable from
 * the authenticated session and the URL path — the client submits no
 * actor role, target role, capability assertion, or Workspace-owner UID.
 * An unexpected field in the body is rejected, not silently ignored.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { removeWorkspaceMembership } from "@/lib/firestore/workspaceMemberships";
import { writeWorkspaceMembershipEvent } from "@/lib/workspaces/workspaceMembershipEvents";
import { teamProjectAuthorizationDeniedResponse, teamWorkspaceReadNotFoundResponse } from "@/lib/projects/teamProjectErrorResponse";
import {
  unexpectedFieldResponse,
  internalErrorResponse,
  membershipTargetNotFoundResponse,
  selfRemovalRejectedResponse,
  targetIsCanonicalOwnerResponse,
  membershipTargetRoleNotManageableResponse,
} from "@/lib/workspaces/teamWorkspaceErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/workspaces/[workspaceId]/members/[uid]/remove", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; uid: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, uid: targetUid } = params;

  let rawBody: unknown = {};
  const bodyText = await req.text();
  if (bodyText.length > 0) {
    try {
      rawBody = JSON.parse(bodyText);
    } catch {
      const { status, body } = unexpectedFieldResponse();
      return NextResponse.json(body, { status });
    }
  }
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody) || Object.keys(rawBody).length > 0) {
    const { status, body } = unexpectedFieldResponse();
    return NextResponse.json(body, { status });
  }

  const result = await removeWorkspaceMembership({ uid, workspaceId, targetUid });

  switch (result.status) {
    case "removed": {
      await writeWorkspaceMembershipEvent({ eventType: "workspace_member_removed", actorUid: uid, targetUid, workspaceId, previousRole: result.previousRole });
      return NextResponse.json({ ok: true, removed: true });
    }
    case "already_removed":
      return NextResponse.json({ ok: true, removed: true, alreadyRemoved: true });
    case "team_workspaces_disabled": {
      const { status, body } = teamWorkspaceReadNotFoundResponse();
      return NextResponse.json(body, { status });
    }
    case "unauthorized": {
      const { status, body } = teamProjectAuthorizationDeniedResponse(result.reason);
      return NextResponse.json(body, { status });
    }
    case "target_not_found":
    case "target_malformed": {
      const { status, body } = membershipTargetNotFoundResponse();
      return NextResponse.json(body, { status });
    }
    case "self_removal_rejected": {
      const { status, body } = selfRemovalRejectedResponse();
      return NextResponse.json(body, { status });
    }
    case "target_is_canonical_owner": {
      const { status, body } = targetIsCanonicalOwnerResponse();
      return NextResponse.json(body, { status });
    }
    case "target_role_not_manageable": {
      const { status, body } = membershipTargetRoleNotManageableResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "state_corruption":
    case "remove_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
