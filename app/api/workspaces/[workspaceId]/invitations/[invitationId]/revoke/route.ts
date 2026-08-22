/**
 * Team Workspace Invitations, Phase 8D.2 —
 * `POST /api/workspaces/{workspaceId}/invitations/{invitationId}/revoke`.
 * Thin HTTP orchestration over `revokeWorkspaceInvitation()`. Revoke never
 * sends email and never touches the delivery-metadata surface — no rate
 * limit is applied here (the shared invitation-email rate limit exists
 * specifically to bound outbound email volume, which this operation never
 * produces).
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { teamWorkspacesDisabledResponse, invalidRequestBodyResponse, unexpectedFieldResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { teamProjectAuthorizationDeniedResponse } from "@/lib/projects/teamProjectErrorResponse";
import { revokeWorkspaceInvitation, type RevokeWorkspaceInvitationResult } from "@/lib/firestore/workspaceInvitations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REVOKE_ALLOWED_KEYS = new Set(["expectedDeliveryVersion"]);

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/workspaces/[workspaceId]/invitations/[invitationId]/revoke", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function mapRevokeDenial(result: Exclude<RevokeWorkspaceInvitationResult, { status: "revoked" }>): { status: number; body: unknown } {
  switch (result.status) {
    case "team_workspaces_disabled":
      return teamWorkspacesDisabledResponse();
    case "invalid_delivery_version":
      return { status: 400, body: { ok: false, errorCode: "invalid_delivery_version", message: "A valid expectedDeliveryVersion is required." } };
    case "unauthorized":
      return teamProjectAuthorizationDeniedResponse(result.reason);
    case "role_target_forbidden":
      return { status: 403, body: { ok: false, errorCode: "role_target_forbidden", message: "You do not have permission to manage this invitation." } };
    case "invitation_not_found":
      return { status: 404, body: { ok: false, errorCode: "invitation_not_found", message: "This invitation could not be found." } };
    case "stale_superseded":
      return { status: 409, body: { ok: false, errorCode: "stale_superseded", message: "This invitation has been superseded by a newer one." } };
    case "invitation_version_conflict":
      return { status: 409, body: { ok: false, errorCode: "invitation_version_conflict", message: "This invitation changed since you last loaded it. Please refresh and try again." } };
    case "invalid_state_for_revoke":
      return { status: 409, body: { ok: false, errorCode: "invalid_state_for_revoke", message: "This invitation can no longer be revoked." } };
    case "firestore_unavailable":
    case "state_corruption":
    case "revoke_failed":
      return internalErrorResponse();
  }
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; invitationId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, invitationId } = params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }
  const payload = rawBody as Record<string, unknown>;
  for (const key of Object.keys(payload)) {
    if (!REVOKE_ALLOWED_KEYS.has(key)) {
      const { status, body } = unexpectedFieldResponse();
      return NextResponse.json(body, { status });
    }
  }

  const revokeResult = await revokeWorkspaceInvitation({ uid, workspaceId, invitationId, expectedDeliveryVersion: payload.expectedDeliveryVersion });
  if (revokeResult.status !== "revoked") {
    const { status, body } = mapRevokeDenial(revokeResult);
    return NextResponse.json(body, { status });
  }

  return NextResponse.json({ ok: true, invitationId: revokeResult.invitationId, status: "revoked" });
}
