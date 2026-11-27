/**
 * Team Project Backend, Phase 8C-A — `PATCH /api/workspaces/{workspaceId}/projects/{projectId}`
 * (rename only). ZCA L-5 adds the `GET` below (D-4 endpoint E-b) for the neutral Team Project
 * page shells; the original note that follows predates it:
 * (rename only). No `GET` handler at this path, mirroring the Personal
 * route's identical Phase 6C decision — Project detail UI is not part of
 * this slice (Section 3).
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { parseRenameProjectBody } from "@/lib/projects/projectMutationBody";
import { validateProjectName } from "@/lib/projects/projectName";
import { validateUpdateTimeToken } from "@/lib/projects/updateTimeToken";
import { updateTeamProjectFields } from "@/lib/firestore/teamProjects";
import { enrichTeamProjectDtos } from "@/lib/workspaces/teamProjectAssigneeEnrichment";
import { writeTeamProjectEventSafely as writeSafely } from "@/lib/projects/writeTeamProjectEventSafely";
import { invalidRequestBodyResponse, unexpectedFieldResponse, invalidUpdateTimeResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { invalidProjectNameResponse, staleUpdateTimeConflictResponse } from "@/lib/projects/projectErrorResponse";
import { teamProjectAuthorizationDeniedResponse, teamProjectNotFoundConcealedResponse, teamProjectInvalidStatusTransitionResponse } from "@/lib/projects/teamProjectErrorResponse";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { getProject } from "@/lib/firestore/projects";
import { normalizeStoredAssigneeUids } from "@/lib/workspaces/assignmentNormalization";
import { resolveAssigneePresentations } from "@/lib/workspaces/assigneePresentation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "PATCH /api/workspaces/[workspaceId]/projects/[projectId]", method: "PATCH", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function PATCH(req: NextRequest, { params }: { params: { workspaceId: string; projectId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, projectId } = params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const parsedBody = parseRenameProjectBody(rawBody);
  if (!parsedBody.ok) {
    const { status, body } = parsedBody.reason === "unknown_field" ? unexpectedFieldResponse() : invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const nameResult = validateProjectName(parsedBody.name);
  if (!nameResult.ok) {
    const { status, body } = invalidProjectNameResponse();
    return NextResponse.json(body, { status });
  }

  const tokenResult = validateUpdateTimeToken(parsedBody.expectedUpdateTime);
  if (!tokenResult.ok) {
    const { status, body } = invalidUpdateTimeResponse();
    return NextResponse.json(body, { status });
  }

  const updateResult = await updateTeamProjectFields({
    uid,
    workspaceId,
    projectId,
    mutation: { kind: "rename", name: nameResult.name },
    expectedUpdateTime: tokenResult.timestamp,
  });

  switch (updateResult.status) {
    case "updated":
      await writeSafely({ eventType: "project_renamed", actorUid: uid, workspaceId, projectId });
      return NextResponse.json({ ok: true, project: (await enrichTeamProjectDtos(workspaceId, [{ project: updateResult.project, documentUpdateTime: updateResult.documentUpdateTime }]))[0] });
    case "updated_projection_unavailable": {
      // Canonical transaction ALREADY committed — the rename genuinely
      // applied. Only the best-effort post-commit projection read
      // failed. 200 (the mutation succeeded), never implying retry is
      // needed or safe; `updateTime: null` signals the client must fetch
      // a fresh token elsewhere before its next mutation.
      await writeSafely({ eventType: "project_renamed", actorUid: uid, workspaceId, projectId });
      return NextResponse.json({
        ok: true,
        project: (await enrichTeamProjectDtos(workspaceId, [{ project: updateResult.project, documentUpdateTime: null }]))[0],
        projectionUnavailable: true,
        message: "The rename was applied, but we couldn't confirm the latest state. Refresh to load the current version before making further changes.",
      });
    }
    case "team_workspaces_disabled": {
      // Phase 10C.1A: concealed identically to "unauthorized" below.
      const { status, body } = teamProjectAuthorizationDeniedResponse("team_workspaces_disabled");
      return NextResponse.json(body, { status });
    }
    case "unauthorized": {
      const { status, body } = teamProjectAuthorizationDeniedResponse(updateResult.reason);
      return NextResponse.json(body, { status });
    }
    case "project_not_found": {
      const { status, body } = teamProjectNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    case "invalid_transition": {
      // Structurally unreachable for rename (no status precondition) —
      // handled anyway, fail-closed, rather than left as an unchecked case.
      const { status, body } = teamProjectInvalidStatusTransitionResponse();
      return NextResponse.json(body, { status });
    }
    case "precondition_failed": {
      const { status, body } = staleUpdateTimeConflictResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "update_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}

/**
 * ZCA L-5 (D-4 endpoint E-b) — `GET /api/workspaces/[workspaceId]/projects/[projectId]`.
 *
 * The bearer-authorized Project read behind the neutral Team Project page shells. It reproduces the
 * pages' former server gate, IN THE SAME ORDER, so a Project is never looked up for a caller who
 * could not open any Project page:
 *   identity → Workspace access (team; every denial the same 404; a transient failure 503) → a
 *   Project-page view capability (projects.read, research.read or research.create — the union of the
 *   seven pages' guards; none → the same 404) → `getProject` (transient → 503; not found / malformed
 *   / another Workspace's Project → the same 404).
 * The client then applies the page's own guard and, for creation pages, the active-status rule.
 * `?include=assignees` adds the read-only assignee chips the Project detail page rendered, and only
 * for a caller holding projects.read (that page's guard). Responses are private, no-store.
 */
const GET_ROUTE = "GET /api/workspaces/[workspaceId]/projects/[projectId]";
const GET_HEADERS = { "Cache-Control": "private, no-store" };
const getJson = (body: unknown, status: number) => NextResponse.json(body, { status, headers: GET_HEADERS });
const GET_NOT_FOUND = () => getJson({ ok: false, errorCode: "not_found" }, 404);
const GET_UNAVAILABLE = () => getJson({ ok: false, errorCode: "unavailable", message: "Something went wrong. Please try again." }, 503);
const PROJECT_VIEW_CAPABILITIES = ["projects.read", "research.read", "research.create"] as const;

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; projectId: string } }) {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: GET_ROUTE, method: "GET", failureCategory: identity.reason });
    if (identity.reason === "auth_unavailable") {
      return getJson({ ok: false, errorCode: "auth_unavailable", message: "Authentication is temporarily unavailable." }, 503);
    }
    return getJson({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, 401);
  }
  const workspaceId = typeof params?.workspaceId === "string" ? params.workspaceId : "";
  const projectId = typeof params?.projectId === "string" ? params.projectId : "";
  if (workspaceId === "" || projectId === "") return GET_NOT_FOUND();

  const access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId });
  if (!access.granted && access.reason === "lookup_failed") return GET_UNAVAILABLE();
  if (!access.granted || access.workspaceType !== "team") return GET_NOT_FOUND();
  if (!PROJECT_VIEW_CAPABILITIES.some((c) => access.capabilities.includes(c))) return GET_NOT_FOUND();

  const result = await getProject(projectId);
  if (result.status === "firestore_unavailable" || result.status === "read_failed") return GET_UNAVAILABLE();
  if (result.status !== "found") return GET_NOT_FOUND();
  if (result.project.workspaceId !== workspaceId) return GET_NOT_FOUND();

  const project: { id: string; name: string; status: "active" | "archived"; assignees?: Array<{ uid: string; displayName: string; state: string }> } = {
    id: result.project.id,
    name: result.project.name,
    status: result.project.status,
  };
  if (req.nextUrl.searchParams.get("include") === "assignees" && access.capabilities.includes("projects.read")) {
    const assigneeUids = normalizeStoredAssigneeUids(result.project.assigneeUids).uids;
    const presentations = assigneeUids.length > 0 ? await resolveAssigneePresentations(workspaceId, "project", assigneeUids) : new Map();
    project.assignees = assigneeUids.flatMap((uid) => {
      const p = presentations.get(uid);
      return p ? [{ uid: p.uid, displayName: p.displayName, state: p.state }] : [];
    });
  }
  return getJson({ ok: true, project }, 200);
}
