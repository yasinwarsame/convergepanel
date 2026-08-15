/**
 * Personal Workspace Provisioning, Phase 2 — the only route that calls
 * `ensurePersonalWorkspace()`. Self-provisioning only: the authenticated
 * uid is always both the caller and the sole target — there is no uid
 * parameter, no `ownerUserId` field, no `workspaceId` field, and no
 * `type` field accepted from the request body at all. The request body is
 * never read for any provisioning input; every canonical value is derived
 * server-side.
 *
 * As of Phase 3 (Workspace-Aware Writes for New Personal Adaptive Runs —
 * the new-user provisioning gap resolution), this IS called by
 * app/login/page.tsx and app/signup/page.tsx, fire-and-forget, best-effort,
 * mirroring the existing profile self-heal pattern in both files. This
 * endpoint's own behavior is unchanged: it still no-ops safely (503
 * `provisioning_disabled`) whenever `PERSONAL_WORKSPACE_PROVISIONING_ENABLED`
 * is off, which it currently is in production — so this remains dark until
 * that separate, still-unauthorized flag is turned on. Not called by
 * session refresh, middleware, the homepage, or any research/history route.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { ensurePersonalWorkspace } from "@/lib/workspaces/ensurePersonalWorkspace";
import { resolvePersonalWorkspaceForOwner } from "@/lib/workspaces/resolvePersonalWorkspaceForOwner";
import { personalWorkspaceErrorResponse } from "@/lib/workspaces/personalWorkspaceErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest, method: "GET" | "POST"): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: `${method} /api/user/workspace`, method, failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

/**
 * Phase 5B — GET /api/user/workspace, read-only retrieval, distinct from
 * the POST provisioning endpoint below. Never calls
 * `ensurePersonalWorkspace()` or any other write path — a missing or
 * malformed Personal Workspace is reported as a sanitized failure, never
 * silently repaired. `uid` comes exclusively from the authenticated
 * session; no `workspaceId`/`userId`/`ownerUserId` is ever accepted from
 * the request. Response DTO is deliberately minimal (`{name, type}`) —
 * unlike POST's response (which returns the full provisioned document,
 * unchanged, existing behavior), GET never exposes `id`, `ownerUserId`,
 * `schemaVersion`, or timestamps: every route that needs the Workspace
 * server-side resolves it itself from the session, so the browser has no
 * use for the raw identifier.
 */
export async function GET(req: NextRequest) {
  const uidOrRes = await getUid(req, "GET");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const result = await resolvePersonalWorkspaceForOwner(uid);

  if (result.status === "found") {
    return NextResponse.json({ ok: true, workspace: { name: result.workspace.name, type: "personal" as const } });
  }
  const { status, body } = personalWorkspaceErrorResponse(result.status);
  return NextResponse.json(body, { status });
}

/**
 * Maps `EnsurePersonalWorkspaceResult` to a client-safe response. Never
 * forwards a raw Firebase error, an internal Firestore path, a stack
 * trace, or a conflicting document's owner uid — `conflict`/`create_failed`
 * /`lookup_failed` all return the same generic, actionable message, distinguished
 * only by `errorCode` for programmatic handling.
 */
export async function POST(req: NextRequest) {
  const uidOrRes = await getUid(req, "POST");
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
