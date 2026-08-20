/**
 * Team Workspace Core Foundation, Phase 8B —
 * `POST /api/workspaces/[workspaceId]/transfer-ownership`, the only route
 * that calls `transferTeamWorkspaceOwnership()`, at the frozen Phase 8A
 * Team API namespace (`/api/workspaces/{workspaceId}/...`). The
 * authenticated caller is always the `callerUid` the service function
 * validates as the canonical current Owner — never a body-supplied value.
 *
 * ================= OCC CONTRACT (route layer) =================
 * All three `expected*UpdateTime` tokens are parsed here via the SAME
 * shared `validateUpdateTimeToken()` this codebase already uses for
 * Project mutations (`lib/projects/updateTimeToken.ts`) — never a
 * reimplemented parser. The parsed `Timestamp` values are passed straight
 * through to `transferTeamWorkspaceOwnership()` as its
 * `expectedWorkspaceUpdateTime` / `expectedOldOwnerMembershipUpdateTime` /
 * `expectedNewOwnerMembershipUpdateTime` arguments — this route never
 * reads any document itself and never substitutes a freshly-read
 * `updateTime` for what the client supplied. See that function's own doc
 * comment for the full authoritative-precondition contract.
 * =================================================================
 *
 * Gated by `TEAM_WORKSPACES_ENABLED`/`TEAM_WORKSPACES_CANARY_UIDS`
 * (`lib/workspaces/teamWorkspacesRollout.ts`) — checked inside
 * `transferTeamWorkspaceOwnership()` itself, against the caller's uid,
 * before any Firestore access.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { parseTransferOwnershipBody } from "@/lib/workspaces/teamWorkspaceMutationBody";
import { validateUpdateTimeToken } from "@/lib/projects/updateTimeToken";
import { transferTeamWorkspaceOwnership } from "@/lib/firestore/workspaceMemberships";
import {
  teamWorkspacesDisabledResponse,
  invalidRequestBodyResponse,
  unexpectedFieldResponse,
  invalidUpdateTimeResponse,
  notCanonicalOwnerResponse,
  teamWorkspaceNotFoundResponse,
  selfTransferRejectedResponse,
  newOwnerNotEligibleResponse,
  staleUpdateTimeConflictResponse,
  internalErrorResponse,
} from "@/lib/workspaces/teamWorkspaceErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: "POST /api/workspaces/[workspaceId]/transfer-ownership", method: "POST", failureCategory: identity.reason });
    if (identity.reason === "missing_credentials") {
      return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
    }
    return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
  }
  const callerUid = identity.uid;

  const workspaceId = params.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    const { status, body } = teamWorkspaceNotFoundResponse();
    return NextResponse.json(body, { status });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const parsedBody = parseTransferOwnershipBody(rawBody);
  if (!parsedBody.ok) {
    const { status, body } = parsedBody.reason === "unknown_field" ? unexpectedFieldResponse() : invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  if (typeof parsedBody.newOwnerUid !== "string" || parsedBody.newOwnerUid.trim().length === 0) {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const workspaceToken = validateUpdateTimeToken(parsedBody.expectedWorkspaceUpdateTime);
  const oldOwnerToken = validateUpdateTimeToken(parsedBody.expectedOldOwnerMembershipUpdateTime);
  const newOwnerToken = validateUpdateTimeToken(parsedBody.expectedNewOwnerMembershipUpdateTime);
  if (!workspaceToken.ok || !oldOwnerToken.ok || !newOwnerToken.ok) {
    const { status, body } = invalidUpdateTimeResponse();
    return NextResponse.json(body, { status });
  }

  const result = await transferTeamWorkspaceOwnership({
    workspaceId,
    callerUid,
    newOwnerUid: parsedBody.newOwnerUid,
    expectedWorkspaceUpdateTime: workspaceToken.timestamp,
    expectedOldOwnerMembershipUpdateTime: oldOwnerToken.timestamp,
    expectedNewOwnerMembershipUpdateTime: newOwnerToken.timestamp,
  });

  switch (result.status) {
    case "transferred":
      return NextResponse.json({
        ok: true,
        workspace: result.workspace,
        oldOwnerMembership: result.oldOwnerMembership,
        newOwnerMembership: result.newOwnerMembership,
      });
    case "team_workspaces_disabled": {
      const { status, body } = teamWorkspacesDisabledResponse();
      return NextResponse.json(body, { status });
    }
    case "workspace_not_found":
    case "caller_not_owner": {
      // Collapsed identically: a caller who isn't the canonical Owner
      // must never learn whether that's because the Workspace doesn't
      // exist, they aren't a member, their membership was removed, or
      // their role isn't Owner.
      const { status, body } = notCanonicalOwnerResponse();
      return NextResponse.json(body, { status });
    }
    case "self_transfer_rejected": {
      const { status, body } = selfTransferRejectedResponse();
      return NextResponse.json(body, { status });
    }
    case "new_owner_membership_not_found":
    case "new_owner_not_eligible": {
      const { status, body } = newOwnerNotEligibleResponse();
      return NextResponse.json(body, { status });
    }
    case "workspace_stale":
    case "old_owner_membership_stale":
    case "new_owner_membership_stale":
    case "stale_precondition": {
      const { status, body } = staleUpdateTimeConflictResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "transaction_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
