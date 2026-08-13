/**
 * Personal Workspace Provisioning, Phase 2 — the only route that calls
 * `ensurePersonalWorkspace()`. Self-provisioning only: the authenticated
 * uid is always both the caller and the sole target — there is no uid
 * parameter, no `ownerUserId` field, no `workspaceId` field, and no
 * `type` field accepted from the request body at all. The request body is
 * never read for any provisioning input; every canonical value is derived
 * server-side.
 *
 * Not called by login, signup, session refresh, middleware, the homepage,
 * or any research/history route — provisioning remains explicitly-
 * callable-only in Phase 2 (docs/workspaces/architecture.md).
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { ensurePersonalWorkspace } from "@/lib/workspaces/ensurePersonalWorkspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/user/workspace", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

/**
 * Maps `EnsurePersonalWorkspaceResult` to a client-safe response. Never
 * forwards a raw Firebase error, an internal Firestore path, a stack
 * trace, or a conflicting document's owner uid — `conflict`/`create_failed`
 * /`lookup_failed` all return the same generic, actionable message, distinguished
 * only by `errorCode` for programmatic handling.
 */
export async function POST(req: NextRequest) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  // The request body is never read — every provisioning input is derived
  // server-side from the authenticated uid alone. No ownerUserId,
  // workspaceId, type, or schemaVersion field could ever be trusted from
  // the client, so none is even parsed.
  const result = await ensurePersonalWorkspace(uid);

  switch (result.status) {
    case "created":
      return NextResponse.json({ ok: true, status: "created", workspace: result.workspace }, { status: 201 });
    case "existing":
      return NextResponse.json({ ok: true, status: "existing", workspace: result.workspace }, { status: 200 });
    case "disabled":
      return NextResponse.json({ ok: false, errorCode: "provisioning_disabled", message: "Personal Workspace provisioning is not enabled." }, { status: 503 });
    case "invalid_uid":
      return NextResponse.json({ ok: false, errorCode: "invalid_uid", message: "Unable to provision a workspace for this account." }, { status: 400 });
    case "conflict":
      return NextResponse.json({ ok: false, errorCode: "workspace_conflict", message: "Unable to provision a Personal Workspace right now." }, { status: 409 });
    case "lookup_failed":
    case "create_failed":
      return NextResponse.json({ ok: false, errorCode: "internal_error", message: "Unable to provision a Personal Workspace right now. Please try again." }, { status: 500 });
  }
}
