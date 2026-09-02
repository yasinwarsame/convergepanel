/**
 * Team Workspace Invitations, Phase 8D.2 —
 * `POST /api/workspaces/{workspaceId}/invitations` (create) and
 * `GET /api/workspaces/{workspaceId}/invitations` (list, current/
 * actionable only). Thin HTTP orchestration over the Phase 8D.1 core
 * (`lib/firestore/workspaceInvitations.ts`) — this route never re-derives
 * rollout, Workspace/membership authorization, role authority, email
 * normalization, guard state, or token generation; all of that remains
 * exclusively inside the core.
 *
 * POST order (frozen): identity -> shared invitation-email rate limit
 * (BEFORE body parsing) -> body read/exact-key validation ->
 * `createWorkspaceInvitation()` -> map non-created domain result -> (only
 * once the invitation has ALREADY durably committed) resolve
 * presentation context -> `sendWorkspaceInvitationEmail()` ->
 * `recordWorkspaceInvitationDeliveryResult()` -> stable API response. The
 * raw token the core returns is consumed here ONLY to hand to the email
 * boundary — it is never included in this route's own JSON response.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { teamWorkspacesDisabledResponse, invalidRequestBodyResponse, unexpectedFieldResponse, internalErrorResponse, workspaceMemberCapacityReachedResponse, seatLimitReachedResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { teamProjectAuthorizationDeniedResponse, teamWorkspaceReadNotFoundResponse } from "@/lib/projects/teamProjectErrorResponse";
import { createWorkspaceInvitation, listWorkspaceInvitations, type CreateWorkspaceInvitationResult } from "@/lib/firestore/workspaceInvitations";
import { getWorkspace } from "@/lib/firestore/workspaces";
import { sendWorkspaceInvitationEmail } from "@/lib/email/workspaceInvitations";
import { recordWorkspaceInvitationDeliveryResult } from "@/lib/firestore/workspaceInvitationDelivery";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CREATE_ALLOWED_KEYS = new Set(["email", "role"]);
const FALLBACK_WORKSPACE_NAME = "your ConvergePanel workspace";

async function getUid(req: NextRequest, method: "GET" | "POST"): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: `${method} /api/workspaces/[workspaceId]/invitations`, method, failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

/** Maps every non-"created" `createWorkspaceInvitation()` result to its public HTTP response. */
/**
 * `team_workspaces_disabled` maps to the SAME concealed
 * `team_workspace_not_found` shape `resolveWorkspaceAccess()`-family
 * denials already use (`teamWorkspaceReadNotFoundResponse()`), never to a
 * distinguishable 503 — Phase 10B.2's target-denial concealment closure.
 * This is a deliberate response-shape change from the pre-10B.2
 * behavior (which returned 503 here) for any caller not currently
 * admitted by any mechanism, since the whole point is that such a caller
 * must never be able to tell "not admitted at all" apart from "this
 * specific Workspace isn't canary-admitted" — see Phase 10A.2/10A.4.
 */
function mapCreateDenial(result: Exclude<CreateWorkspaceInvitationResult, { status: "created" }>): { status: number; body: unknown } {
  switch (result.status) {
    case "team_workspaces_disabled":
      return teamWorkspaceReadNotFoundResponse();
    case "unauthorized":
      return teamProjectAuthorizationDeniedResponse(result.reason);
    case "role_target_forbidden":
      return { status: 403, body: { ok: false, errorCode: "role_target_forbidden", message: "You do not have permission to invite at this role." } };
    case "invalid_email":
      return { status: 400, body: { ok: false, errorCode: "invalid_email", message: "A valid email address is required." } };
    case "invalid_role":
      return { status: 400, body: { ok: false, errorCode: "invalid_role", message: "A valid role is required." } };
    case "duplicate_live_invitation":
      return { status: 409, body: { ok: false, errorCode: "duplicate_live_invitation", message: "A live invitation already exists for this email address." } };
    case "workspace_member_capacity_reached":
      return workspaceMemberCapacityReachedResponse();
    case "seat_limit_reached":
      return seatLimitReachedResponse();
    case "firestore_unavailable":
    case "state_corruption":
    case "create_failed":
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

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const uidOrRes = await getUid(req, "POST");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const workspaceId = params.workspaceId;

  // Rate limit BEFORE body parsing — shared with resend so create+resend
  // draw from one abuse budget for invitation-email-producing actions.
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
    if (!CREATE_ALLOWED_KEYS.has(key)) {
      const { status, body } = unexpectedFieldResponse();
      return NextResponse.json(body, { status });
    }
  }

  const createResult = await createWorkspaceInvitation({ uid, workspaceId, email: payload.email, role: payload.role });
  if (createResult.status !== "created") {
    const { status, body } = mapCreateDenial(createResult);
    return NextResponse.json(body, { status });
  }

  // The invitation has ALREADY durably committed at this point — every
  // step below is best-effort presentation/delivery, never a reason to
  // report creation itself as failed.
  const workspaceName = await resolveWorkspaceDisplayName(workspaceId);

  const sendResult = await sendWorkspaceInvitationEmail({
    invitationId: createResult.invitationId,
    deliveryVersion: createResult.deliveryVersion,
    rawToken: createResult.rawToken,
    to: createResult.normalizedEmail,
    workspaceName,
    inviterName: null,
    role: createResult.role,
    expiresAt: createResult.expiresAt.toDate(),
  });

  const delivered = sendResult.status === "sent";
  const metadataResult = await recordWorkspaceInvitationDeliveryResult({
    uid,
    invitationId: createResult.invitationId,
    deliveryVersion: createResult.deliveryVersion,
    status: delivered ? "sent" : "failed",
    providerMessageId: delivered ? sendResult.providerMessageId : null,
  });
  if (metadataResult.status !== "recorded" && metadataResult.status !== "stale_delivery_result") {
    logger.warn("[workspaces/invitations POST] Delivery metadata recording did not succeed", { invitationId: createResult.invitationId, deliveryVersion: createResult.deliveryVersion, metadataStatus: metadataResult.status });
  }

  return NextResponse.json(
    {
      ok: true,
      invitation: {
        id: createResult.invitationId,
        normalizedEmail: createResult.normalizedEmail,
        role: createResult.role,
        expiresAt: createResult.expiresAt.toDate().toISOString(),
        deliveryVersion: createResult.deliveryVersion,
      },
      delivered,
      ...(delivered ? {} : { deliveryError: sendResult.status }),
    },
    { status: 201 }
  );
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const uidOrRes = await getUid(req, "GET");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const workspaceId = params.workspaceId;

  const result = await listWorkspaceInvitations({ uid, workspaceId });
  switch (result.status) {
    case "listed":
      return NextResponse.json({ ok: true, invitations: result.invitations });
    case "team_workspaces_disabled":
    case "workspace_not_found":
    case "workspace_malformed":
    case "membership_not_found":
    case "membership_removed":
    case "membership_malformed":
    case "owner_integrity_violation": {
      // Phase 10B.2: `team_workspaces_disabled` (whether from this
      // route's own target-admission gate or from the still-uid-only
      // `resolveWorkspaceAccess()` call inside `listWorkspaceInvitations()`
      // — see that function's own Phase 10B.2 note) now collapses into the
      // SAME concealed shape as every other denial reason, closing the
      // target-Workspace-canary oracle.
      const { status, body } = teamWorkspaceReadNotFoundResponse();
      return NextResponse.json(body, { status });
    }
    case "insufficient_capability": {
      const { status, body } = teamProjectAuthorizationDeniedResponse("insufficient_capability");
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "lookup_failed": {
      // Both represent transient infrastructure unavailability at the
      // resolveWorkspaceAccess()-family read boundary — kept on the
      // repository's PRE-EXISTING 503 mapping, deliberately UNCHANGED by
      // Phase 10B.2's concealment work: a true infrastructure outage is
      // not evidence about admission/existence, and this route's own
      // prior precedent already distinguished it from a data-corruption
      // 500. Only `team_workspaces_disabled` (a genuine admission denial)
      // moved to the concealed 404 family above — this class did not.
      const { status, body } = teamWorkspacesDisabledResponse();
      return NextResponse.json(body, { status });
    }
    case "state_corruption": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
