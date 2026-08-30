/**
 * Team Workspace Self-Service Onboarding — `GET /api/workspaces/{workspaceId}/members`.
 * Read-only, mirrors the existing GET handler convention in
 * `app/api/workspaces/[workspaceId]/projects/route.ts`: uses the
 * unmodified `resolveWorkspaceAccess()` as the sole authoritative gate
 * (no transaction-time re-authorization needed for a read), then the
 * centralized capability map — never a hardcoded role comparison.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { teamProjectAuthorizationDeniedResponse, teamWorkspaceReadNotFoundResponse } from "@/lib/projects/teamProjectErrorResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { listWorkspaceMembers } from "@/lib/workspaces/listWorkspaceMembers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/members", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const workspaceId = params.workspaceId;

  const access = await resolveWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    // Same concealment discipline as every other Team read route: a
    // rollout-non-admission, non-membership, and every other denial
    // reason collapse to the identical "not found" shape — a caller
    // never learns which specific gate failed.
    const { status, body } = teamWorkspaceReadNotFoundResponse();
    return NextResponse.json(body, { status });
  }
  if (access.workspaceType !== "team") {
    const { status, body } = teamWorkspaceReadNotFoundResponse();
    return NextResponse.json(body, { status });
  }
  if (!access.capabilities.includes("members.read")) {
    const { status, body } = teamProjectAuthorizationDeniedResponse("insufficient_capability");
    return NextResponse.json(body, { status });
  }

  const result = await listWorkspaceMembers({ workspace: access.workspace });
  switch (result.status) {
    case "listed":
      return NextResponse.json({ ok: true, members: result.members });
    case "firestore_unavailable":
    case "query_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
