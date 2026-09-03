/**
 * Team Member Management, Phase 12B — `POST /api/workspaces/{workspaceId}/members/{uid}/change-role`.
 * Thin HTTP orchestration over `changeTeamWorkspaceMemberRole()`
 * (`lib/firestore/workspaceMemberships.ts`) — this route never re-derives
 * authorization, owner-integrity, target/destination-role policy, or
 * idempotency; all of that remains exclusively inside that transaction.
 * Mirrors `.../members/[uid]/remove/route.ts`'s exact structure.
 *
 * The request body carries exactly one field, `role`, the REQUESTED
 * destination — never the actor's role, the target's current role, or any
 * other authority assertion. The client-supplied value is validated
 * against `ORDINARY_SETTABLE_ROLES` (never `"owner"`) before being passed
 * to the mutation function as a typed `MembershipTargetRole` — the
 * mutation function itself re-derives every authorization decision fresh
 * regardless of what this route already checked.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { changeTeamWorkspaceMemberRole } from "@/lib/firestore/workspaceMemberships";
import { ORDINARY_SETTABLE_ROLES } from "@/lib/workspaces/capabilities";
import type { MembershipTargetRole } from "@/lib/workspaces/membershipTargetAuthority";
import { teamProjectAuthorizationDeniedResponse, teamWorkspaceReadNotFoundResponse } from "@/lib/projects/teamProjectErrorResponse";
import {
  invalidRequestBodyResponse,
  internalErrorResponse,
  membershipTargetNotFoundResponse,
  membershipTargetNotActiveResponse,
  selfRoleChangeRejectedResponse,
  targetIsCanonicalOwnerResponse,
  membershipRoleChangeNotPermittedResponse,
} from "@/lib/workspaces/teamWorkspaceErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORDINARY_SETTABLE_ROLE_SET: ReadonlySet<string> = new Set(ORDINARY_SETTABLE_ROLES);

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/workspaces/[workspaceId]/members/[uid]/change-role", method: "POST", failureCategory: identity.reason });
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

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(await req.text());
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }
  const keys = Object.keys(rawBody as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "role") {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }
  const role = (rawBody as Record<string, unknown>).role;
  if (typeof role !== "string" || !ORDINARY_SETTABLE_ROLE_SET.has(role)) {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }
  const destinationRole = role as MembershipTargetRole;

  const result = await changeTeamWorkspaceMemberRole({ uid, workspaceId, targetUid, destinationRole });

  switch (result.status) {
    case "changed":
      return NextResponse.json({ ok: true, changed: true });
    case "role_unchanged":
      return NextResponse.json({ ok: true, changed: false });
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
    case "target_not_active": {
      const { status, body } = membershipTargetNotActiveResponse();
      return NextResponse.json(body, { status });
    }
    case "self_change_rejected": {
      const { status, body } = selfRoleChangeRejectedResponse();
      return NextResponse.json(body, { status });
    }
    case "target_is_canonical_owner": {
      const { status, body } = targetIsCanonicalOwnerResponse();
      return NextResponse.json(body, { status });
    }
    case "target_role_not_manageable":
    case "destination_role_not_permitted": {
      const { status, body } = membershipRoleChangeNotPermittedResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "change_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
