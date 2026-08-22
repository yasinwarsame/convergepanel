/**
 * Team Workspace Invitations, Phase 8D.2 —
 * `POST /api/workspace-invitations/{invitationId}/accept`. Deliberately
 * NOT nested under `/api/workspaces/{workspaceId}/...` — the caller does
 * not know (and must not be required to supply) which Workspace the
 * invitation belongs to; `invitationId` + `token` alone resolve it, inside
 * `acceptWorkspaceInvitation()`.
 *
 * This route accepts only `{ token }` in the body — no `workspaceId`,
 * `email`, `role`, `uid`, or `membershipId`. Identity comes exclusively
 * from `resolveRequestIdentity()`. The Phase 8D.1 core remains
 * authoritative for Team rollout, Firebase Auth email verification, token
 * verification, guard currentness, Workspace/owner integrity, and
 * membership creation/reactivation — none of that is duplicated here.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { invalidRequestBodyResponse, unexpectedFieldResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { teamWorkspacesDisabledResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { acceptWorkspaceInvitation, type AcceptWorkspaceInvitationResult } from "@/lib/firestore/workspaceInvitations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCEPT_ALLOWED_KEYS = new Set(["token"]);

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/workspace-invitations/[invitationId]/accept", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function mapAcceptDenial(result: Exclude<AcceptWorkspaceInvitationResult, { status: "accepted" }>): { status: number; body: unknown } {
  switch (result.status) {
    case "team_workspaces_disabled":
      return teamWorkspacesDisabledResponse();
    case "invalid_input": {
      const { status, body } = invalidRequestBodyResponse();
      return { status, body };
    }
    case "email_verification_required":
      return { status: 403, body: { ok: false, errorCode: "email_verification_required", message: "Please verify your account's email address before accepting this invitation." } };
    case "invitation_email_mismatch":
      return { status: 403, body: { ok: false, errorCode: "invitation_email_mismatch", message: "This invitation is for a different email address than your account." } };
    case "invitation_invalid_or_expired":
      return { status: 404, body: { ok: false, errorCode: "invitation_invalid_or_expired", message: "This invitation is invalid, expired, or no longer available." } };
    case "firestore_unavailable":
    case "auth_lookup_failed":
    case "state_corruption":
    case "accept_failed":
      return internalErrorResponse();
  }
}

export async function POST(req: NextRequest, { params }: { params: { invitationId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { invitationId } = params;

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
    if (!ACCEPT_ALLOWED_KEYS.has(key)) {
      const { status, body } = unexpectedFieldResponse();
      return NextResponse.json(body, { status });
    }
  }
  if (typeof payload.token !== "string" || payload.token.length === 0) {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const acceptResult = await acceptWorkspaceInvitation({ uid, invitationId, rawToken: payload.token });
  if (acceptResult.status !== "accepted") {
    const { status, body } = mapAcceptDenial(acceptResult);
    return NextResponse.json(body, { status });
  }

  return NextResponse.json({
    ok: true,
    workspaceId: acceptResult.workspaceId,
    alreadyMember: acceptResult.alreadyMember,
    effectiveRole: acceptResult.effectiveRole,
  });
}
