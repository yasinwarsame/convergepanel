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

/**
 * Phase 10B.2: `team_workspaces_disabled` is no longer a possible result
 * of `acceptWorkspaceInvitation()` at all — target-Workspace admission is
 * now evaluated INSIDE the transaction, after invitation validity and
 * email match, and its denial maps directly to `invitation_invalid_or_expired`
 * (handled below) rather than a distinguishable status. TypeScript's
 * exhaustiveness checking on `AcceptWorkspaceInvitationResult` is what
 * enforces this switch has no stray case for a status that can't occur.
 */
function mapAcceptDenial(result: Exclude<AcceptWorkspaceInvitationResult, { status: "accepted" }>): { status: number; body: unknown } {
  switch (result.status) {
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
    case "auth_lookup_failed":
      // The core already distinguishes this from a deterministic account
      // state (missing/unverified email is its own
      // `email_verification_required` status) — this is specifically a
      // failure to obtain authoritative Firebase Auth state (the account
      // record itself, or a transient Admin SDK failure), i.e.
      // infrastructure, not a fact about the caller's account. Mapped to a
      // generic, safe 503 — never the Firebase error code/message/stack.
      return { status: 503, body: { ok: false, errorCode: "service_unavailable", message: "Something went wrong. Please try again." } };
    case "firestore_unavailable":
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
