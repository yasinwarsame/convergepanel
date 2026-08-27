/**
 * Team Workspace Invitations, Phase 8D.2 —
 * `POST /api/workspaces/{workspaceId}/invitations/{invitationId}/resend`.
 * Thin HTTP orchestration over `resendWorkspaceInvitation()` — this route
 * never re-derives rollout, authorization, role authority, guard
 * currentness, or OCC; all of that stays in the Phase 8D.1 core.
 *
 * Order: identity -> shared invitation-email rate limit -> body
 * read/exact-key validation -> `resendWorkspaceInvitation()` -> map
 * non-resent result -> presentation context -> send using the NEW raw
 * token/deliveryVersion the core just returned -> record delivery result
 * using that SAME new version -> response. The old (pre-resend) version
 * is never used for the send or the delivery-metadata write.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { invalidRequestBodyResponse, unexpectedFieldResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { teamProjectAuthorizationDeniedResponse, teamWorkspaceReadNotFoundResponse } from "@/lib/projects/teamProjectErrorResponse";
import { resendWorkspaceInvitation, type ResendWorkspaceInvitationResult } from "@/lib/firestore/workspaceInvitations";
import { getWorkspace } from "@/lib/firestore/workspaces";
import { sendWorkspaceInvitationEmail } from "@/lib/email/workspaceInvitations";
import { recordWorkspaceInvitationDeliveryResult } from "@/lib/firestore/workspaceInvitationDelivery";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESEND_ALLOWED_KEYS = new Set(["expectedDeliveryVersion"]);
const FALLBACK_WORKSPACE_NAME = "your ConvergePanel workspace";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/workspaces/[workspaceId]/invitations/[invitationId]/resend", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

/** `team_workspaces_disabled` maps to the concealed 404 team_workspace_not_found family — Phase 10B.2's target-denial concealment closure (see the create-route's identical comment). */
function mapResendDenial(result: Exclude<ResendWorkspaceInvitationResult, { status: "resent" }>): { status: number; body: unknown } {
  switch (result.status) {
    case "team_workspaces_disabled":
      return teamWorkspaceReadNotFoundResponse();
    case "invalid_delivery_version":
      return { status: 400, body: { ok: false, errorCode: "invalid_delivery_version", message: "A valid expectedDeliveryVersion is required." } };
    case "unauthorized":
      return teamProjectAuthorizationDeniedResponse(result.reason);
    case "role_target_forbidden":
      return { status: 403, body: { ok: false, errorCode: "role_target_forbidden", message: "You do not have permission to manage this invitation." } };
    case "invitation_not_found":
      return { status: 404, body: { ok: false, errorCode: "invitation_not_found", message: "This invitation could not be found." } };
    case "invalid_state":
      return { status: 409, body: { ok: false, errorCode: "invalid_state", message: "This invitation is no longer pending." } };
    case "stale_superseded":
      return { status: 409, body: { ok: false, errorCode: "stale_superseded", message: "This invitation has been superseded by a newer one." } };
    case "invitation_version_conflict":
      return { status: 409, body: { ok: false, errorCode: "invitation_version_conflict", message: "This invitation changed since you last loaded it. Please refresh and try again." } };
    case "firestore_unavailable":
    case "state_corruption":
    case "resend_failed":
      return internalErrorResponse();
  }
}

async function resolveWorkspaceDisplayName(workspaceId: string): Promise<string> {
  const lookup = await getWorkspace(workspaceId);
  if (lookup.status === "found" && typeof lookup.workspace.name === "string" && lookup.workspace.name.trim().length > 0) {
    return lookup.workspace.name;
  }
  return FALLBACK_WORKSPACE_NAME;
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; invitationId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, invitationId } = params;

  const rateLimitResult = await checkRateLimit({ maxRequests: 10, windowSeconds: 60, identifier: `team-workspace-invitation-email:${uid}` });
  if (!rateLimitResult.allowed) {
    return NextResponse.json({ ok: false, errorCode: "rate_limit_exceeded", message: "Too many invitation requests. Please wait before trying again." }, { status: 429 });
  }

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
    if (!RESEND_ALLOWED_KEYS.has(key)) {
      const { status, body } = unexpectedFieldResponse();
      return NextResponse.json(body, { status });
    }
  }

  const resendResult = await resendWorkspaceInvitation({ uid, workspaceId, invitationId, expectedDeliveryVersion: payload.expectedDeliveryVersion });
  if (resendResult.status !== "resent") {
    const { status, body } = mapResendDenial(resendResult);
    return NextResponse.json(body, { status });
  }

  const workspaceName = await resolveWorkspaceDisplayName(workspaceId);

  const sendResult = await sendWorkspaceInvitationEmail({
    invitationId: resendResult.invitationId,
    deliveryVersion: resendResult.deliveryVersion,
    rawToken: resendResult.rawToken,
    to: resendResult.normalizedEmail,
    workspaceName,
    inviterName: null,
    role: resendResult.role,
    expiresAt: resendResult.expiresAt.toDate(),
  });

  const delivered = sendResult.status === "sent";
  const metadataResult = await recordWorkspaceInvitationDeliveryResult({
    uid,
    invitationId: resendResult.invitationId,
    deliveryVersion: resendResult.deliveryVersion,
    status: delivered ? "sent" : "failed",
    providerMessageId: delivered ? sendResult.providerMessageId : null,
  });
  if (metadataResult.status !== "recorded" && metadataResult.status !== "stale_delivery_result") {
    logger.warn("[workspaces/invitations/resend POST] Delivery metadata recording did not succeed", { invitationId: resendResult.invitationId, deliveryVersion: resendResult.deliveryVersion, metadataStatus: metadataResult.status });
  }

  return NextResponse.json({
    ok: true,
    invitation: {
      id: resendResult.invitationId,
      normalizedEmail: resendResult.normalizedEmail,
      role: resendResult.role,
      expiresAt: resendResult.expiresAt.toDate().toISOString(),
      deliveryVersion: resendResult.deliveryVersion,
    },
    delivered,
    ...(delivered ? {} : { deliveryError: sendResult.status }),
  });
}
