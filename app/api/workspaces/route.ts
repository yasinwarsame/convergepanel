/**
 * Team Workspace Core Foundation, Phase 8B — `POST /api/workspaces`, the
 * minimal API surface needed to exercise `createTeamWorkspace()`, at the
 * frozen Phase 8A Team API namespace root (`/api/workspaces/{workspaceId}/...`
 * — this route creates the `{workspaceId}` those later paths address).
 *
 * Every identity-derived field is server-derived from the authenticated
 * uid alone (`resolveRequestIdentity()`, the same hardened resolver every
 * other authenticated route in this codebase uses) — the request body is
 * parsed ONLY for `name`; no `ownerUserId`, `createdByUserId`, `type`, or
 * `schemaVersion` field is ever accepted from a client.
 *
 * Gated by `TEAM_WORKSPACES_ENABLED`/`TEAM_WORKSPACES_CANARY_UIDS`
 * (`lib/workspaces/teamWorkspacesRollout.ts`) — checked inside
 * `createTeamWorkspace()` itself before any Firestore access, mirroring
 * `PROJECTS_ENABLED`/`PROJECTS_CANARY_UIDS`'s existing precedent.
 *
 * Phase 9C.1-R1C adds `GET /api/workspaces` — the general "list the Team
 * Workspaces I actively belong to" discovery/selection surface, added at
 * this same resource root rather than inventing a duplicate endpoint (the
 * corrective prompt's explicit preference). It exists to let the Reviews
 * UI present an explicit chooser when a uid has more than one active
 * Team Workspace (see `resolveViewerTeamWorkspaceSelection()` /
 * `listViewerTeamWorkspaces()`) — never a Workspace authorization
 * shortcut; every later read/mutation still authorizes the selected
 * Workspace independently.
 *
 * PHASE 11B.5-P0 — THE TWO METHODS ANSWER TO DIFFERENT GATES, ON PURPOSE:
 *
 *   GET  /api/workspaces — DISCOVER MY EXISTING ACTIVE TEAM MEMBERSHIPS.
 *                          Authenticated callers only. NOT conditioned on any
 *                          Team rollout flag.
 *   POST /api/workspaces — CREATE A TEAM WORKSPACE, SUBJECT TO SELF-SERVICE
 *                          ROLLOUT (enforced inside `createTeamWorkspace()`).
 *
 * GET previously branched on `resolveTeamWorkspacesMode()`: admitted callers
 * got their full paginated membership list, everyone else got a bounded
 * Workspace-canary lookup that collapsed to the same 503 as a wholly
 * non-admitted caller. That made the endpoint's output INCOMPLETE for a
 * legitimate member: every `/workspace/team/{id}/**` page authorizes on
 * `resolveWorkspaceAccess()` alone and consults no rollout flag, so an active
 * member of a Workspace outside the canary set could load that Workspace and
 * still be told by this endpoint that they belong to nothing.
 *
 * Discovery of a membership the caller ALREADY holds is not the same authority
 * as creating a new Workspace. Listing it broadens nothing: the rows come from
 * the same `uid == caller && status == "active"` predicate
 * `resolveWorkspaceAccess()` itself trusts, and carry only `workspaceId`/`name`.
 * A rollout flag is not an authorization boundary, and was never the thing
 * protecting this data.
 *
 * This also makes the Approval Queue self-consistent: `/workspace/reviews`
 * already decides Workspace CARDINALITY via
 * `resolveViewerTeamWorkspaceSelection()`, which scans every active membership
 * independent of Team self-service rollout — then hands naming to
 * `WorkspaceReviewsChooser`, which reads THIS endpoint. Before P0 those two
 * could disagree about how many Workspaces a caller has.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { parseCreateTeamWorkspaceBody } from "@/lib/workspaces/teamWorkspaceMutationBody";
import { validateTeamWorkspaceName } from "@/lib/workspaces/teamWorkspaceName";
import { createTeamWorkspace } from "@/lib/firestore/workspaceMemberships";
// `teamWorkspacesDisabledResponse` is still POST's own rollout refusal — only
// GET's use of it is removed here.
import { teamWorkspacesDisabledResponse, invalidRequestBodyResponse, unexpectedFieldResponse, invalidTeamWorkspaceNameResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { listViewerTeamWorkspaces, VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE, VIEWER_WORKSPACE_LIST_MAX_PAGE_SIZE } from "@/lib/workspaces/listViewerTeamWorkspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveUidOrErrorResponse(req: NextRequest, method: "GET" | "POST"): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: `${method} /api/workspaces`, method, failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const uidOrRes = await resolveUidOrErrorResponse(req, "GET");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  // Phase 11B.5-P0 — ONE path. `listViewerTeamWorkspaces()` is the sole
  // authority and already constrains discovery to membership rows satisfying
  // `uid == authenticated caller && status == "active"`, returning only
  // `workspaceId`/`name`. No rollout flag is consulted: see the route doc above.
  const { searchParams } = req.nextUrl;
  const limitRaw = parseInt(searchParams.get("limit") || String(VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE), 10);
  const limit = Math.min(VIEWER_WORKSPACE_LIST_MAX_PAGE_SIZE, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE));
  const cursor = searchParams.get("cursor");

  const result = await listViewerTeamWorkspaces({ uid, cursor, limit });
  if (result.status !== "ok") {
    // A real infrastructure failure is never flattened into an empty list: a
    // caller must not read "we could not look this up" as "you belong to
    // nothing", which is what would silently hide a Workspace.
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }

  // Zero active memberships is a 200 with an empty list, NOT a 503. It
  // discloses only the authenticated caller's own membership state, and
  // "I belong to no Team Workspace" is not a secret from its own subject.
  return NextResponse.json({ ok: true, items: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const uidOrRes = await resolveUidOrErrorResponse(req, "POST");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const parsedBody = parseCreateTeamWorkspaceBody(rawBody);
  if (!parsedBody.ok) {
    const { status, body } = parsedBody.reason === "unknown_field" ? unexpectedFieldResponse() : invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const nameResult = validateTeamWorkspaceName(parsedBody.name);
  if (!nameResult.ok) {
    const { status, body } = invalidTeamWorkspaceNameResponse();
    return NextResponse.json(body, { status });
  }

  const result = await createTeamWorkspace({ uid, name: nameResult.name });

  switch (result.status) {
    case "created":
      return NextResponse.json({ ok: true, workspace: result.workspace, membership: result.membership }, { status: 201 });
    case "team_workspaces_disabled": {
      const { status, body } = teamWorkspacesDisabledResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "create_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
