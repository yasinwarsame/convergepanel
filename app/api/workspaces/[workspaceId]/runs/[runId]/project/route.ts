/**
 * Team Run→Project Association, Phase 8C-C —
 * `PATCH /api/workspaces/{workspaceId}/runs/{runId}/project`. Assign,
 * move, or unassign a Team-bound run's Project association. No POST/PUT/
 * DELETE/GET on this route — PATCH only.
 *
 * Thin route: identity → runId syntax → body parsing → rate limit →
 * `associateTeamRunWithProject()` → (on real state change only) best-
 * effort event → response mapping. Deliberately performs NO
 * non-transactional Workspace/membership/capability read of its own —
 * `associateTeamRunWithProject()` owns its own Team rollout gate and the
 * entire authorization decision happens exactly once, inside its single
 * Firestore transaction (see that module's own doc comment for why a
 * request-time precheck would add I/O without adding security). Request
 * body parsing reuses `parseRunProjectAssociationBody()`/
 * `validateNullableProjectIdValue()` verbatim from the Personal route —
 * both are workspace-agnostic, so a Team-specific body parser would be
 * pure duplication.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";
import { parseRunProjectAssociationBody, validateNullableProjectIdValue } from "@/lib/projects/runProjectAssociationBody";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { associateTeamRunWithProject } from "@/lib/projects/associateTeamRunWithProject";
import { writeTeamProjectEventSafely } from "@/lib/projects/writeTeamProjectEventSafely";
import { logger } from "@/lib/logger";
import { invalidRequestBodyResponse, unexpectedFieldResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { teamProjectAuthorizationDeniedResponse } from "@/lib/projects/teamProjectErrorResponse";
import {
  runNotFoundConcealedResponse,
  runProjectAssociationConflictResponse,
  runProjectAssociationUnchangedResponse,
  runProjectAssociationTargetNotFoundResponse,
  projectArchivedTargetResponse,
} from "@/lib/projects/projectErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "PATCH /api/workspaces/[workspaceId]/runs/[runId]/project", method: "PATCH", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function PATCH(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId } = params;

  const runIdResult = validateRunIdSyntax(params.runId);
  if (!runIdResult.ok) {
    // Same concealed response a well-formed-but-foreign run id gets —
    // never a distinguishable 400, which would itself be an oracle.
    const { status, body } = runNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const parsedBody = parseRunProjectAssociationBody(rawBody);
  if (!parsedBody.ok) {
    const { status, body } = parsedBody.reason === "unknown_field" ? unexpectedFieldResponse() : invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const targetResult = validateNullableProjectIdValue(parsedBody.projectId);
  if (!targetResult.ok) {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }
  const expectedResult = validateNullableProjectIdValue(parsedBody.expectedProjectId);
  if (!expectedResult.ok) {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  // UID-scoped, not Workspace-scoped — moving across Workspace ids must
  // never let a caller bypass the user-level mutation limit.
  const rateLimitResult = await checkRateLimit({ maxRequests: 20, windowSeconds: 60, identifier: `team-run-project-assign:${uid}` });
  if (!rateLimitResult.allowed) {
    return NextResponse.json({ ok: false, errorCode: "rate_limited", message: "Too many requests. Please try again shortly." }, { status: 429 });
  }

  const result = await associateTeamRunWithProject({
    uid,
    workspaceId,
    runId: runIdResult.runId,
    targetProjectId: targetResult.value,
    expectedProjectId: expectedResult.value,
  });

  switch (result.status) {
    case "associated": {
      // Secondary, best-effort, awaited — only ever called AFTER the
      // canonical transaction has already committed, and never from
      // inside the retryable transaction callback. `projectId` on the
      // event is required non-null by `ProjectEventBase`; exactly one of
      // fromProjectId/toProjectId can be null for a real (non-no-op)
      // association change, so the other is always a valid value here.
      const eventProjectId = result.toProjectId ?? result.fromProjectId;
      if (eventProjectId !== null) {
        await writeTeamProjectEventSafely({
          eventType: "project_run_association_changed",
          actorUid: uid,
          workspaceId: result.workspaceId,
          projectId: eventProjectId,
          runId: result.runId,
          fromProjectId: result.fromProjectId,
          toProjectId: result.toProjectId,
        });
      } else {
        logger.error("[api/workspaces/[workspaceId]/runs/[runId]/project] Unreachable: both fromProjectId and toProjectId null for a committed association change", {
          workspaceId: result.workspaceId,
          runId: result.runId,
        });
      }
      return NextResponse.json({ ok: true, runId: result.runId, workspaceId: result.workspaceId, projectId: result.toProjectId });
    }
    case "team_workspaces_disabled": {
      // Phase 10C.1A: concealed identically to "unauthorized" below.
      const { status, body } = teamProjectAuthorizationDeniedResponse("team_workspaces_disabled");
      return NextResponse.json(body, { status });
    }
    case "unauthorized": {
      const { status, body } = teamProjectAuthorizationDeniedResponse(result.reason);
      return NextResponse.json(body, { status });
    }
    case "run_not_found": {
      const { status, body } = runNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    case "conflict": {
      const { status, body } = runProjectAssociationConflictResponse();
      return NextResponse.json(body, { status });
    }
    case "unchanged": {
      const { status, body } = runProjectAssociationUnchangedResponse();
      return NextResponse.json(body, { status });
    }
    case "target_not_found": {
      const { status, body } = runProjectAssociationTargetNotFoundResponse();
      return NextResponse.json(body, { status });
    }
    case "target_archived": {
      const { status, body } = projectArchivedTargetResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "transaction_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
