/**
 * Run/Project Association, Phase 6D.4A — `PATCH /api/user/runs/{runId}/project`.
 * Assign, move, or unassign a run's Project association. No POST/PUT/
 * DELETE/GET on this route — PATCH only.
 *
 * Rollout: requires BOTH `resolveProjectRunAssociationWriteMode()` AND
 * `resolveProjectsMode()` to be enabled for this uid. These are two
 * genuinely independent flags governing two different concerns
 * (`lib/env.ts`'s own doc comments say so explicitly) — the going-forward
 * `projectId: null` writer at run-creation time is already globally on,
 * but that alone must never expose THIS mutation capability. Only a uid
 * with Project backend eligibility (`PROJECTS_ENABLED`/`PROJECTS_CANARY_UIDS`)
 * may reach any run/Project read below, let alone a mutation. Checked
 * before any body parsing or Firestore access — a caller outside either
 * eligibility set gets the same dark response as Project CRUD's own
 * `projects_disabled`, revealing nothing about canary membership.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { PROJECTS_ENABLED, PROJECTS_CANARY_UIDS, PROJECT_RUN_ASSOCIATION_WRITES_ENABLED, PROJECT_RUN_ASSOCIATION_WRITE_CANARY_UIDS } from "@/lib/env";
import { resolveProjectsMode } from "@/lib/projects/projectsRollout";
import { resolveProjectRunAssociationWriteMode } from "@/lib/projects/projectRunAssociationWriteCanary";
import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";
import { parseRunProjectAssociationBody, validateNullableProjectIdValue } from "@/lib/projects/runProjectAssociationBody";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { associateRunWithProject } from "@/lib/projects/associateRunWithProject";
import { writeProjectEvent } from "@/lib/projects/projectEvents";
import { logger } from "@/lib/logger";
import {
  projectsDisabledResponse,
  invalidRequestBodyResponse,
  unexpectedFieldResponse,
  runNotFoundConcealedResponse,
  runProjectAssociationConflictResponse,
  runProjectAssociationUnchangedResponse,
  runProjectAssociationTargetNotFoundResponse,
  projectArchivedTargetResponse,
  internalErrorResponse,
} from "@/lib/projects/projectErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "PATCH /api/user/runs/[runId]/project", method: "PATCH", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function PATCH(req: NextRequest, { params }: { params: { runId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  // Dual rollout gate — order matches Phase 6D.4A's frozen spec: the
  // going-forward writer gate first, then the Project backend eligibility
  // gate. Both share the same dark response so neither leaks which gate a
  // caller failed.
  const writerMode = resolveProjectRunAssociationWriteMode({
    uid,
    globalWritesEnabled: PROJECT_RUN_ASSOCIATION_WRITES_ENABLED,
    canaryUidsRaw: PROJECT_RUN_ASSOCIATION_WRITE_CANARY_UIDS,
  });
  if (!writerMode.enabled) {
    const { status, body } = projectsDisabledResponse();
    return NextResponse.json(body, { status });
  }
  const projectsMode = resolveProjectsMode({ uid, globalEnabled: PROJECTS_ENABLED, canaryUidsRaw: PROJECTS_CANARY_UIDS });
  if (!projectsMode.enabled) {
    const { status, body } = projectsDisabledResponse();
    return NextResponse.json(body, { status });
  }

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

  const rateLimitResult = await checkRateLimit({ maxRequests: 20, windowSeconds: 60, identifier: `run-project-assign:${uid}` });
  if (!rateLimitResult.allowed) {
    return NextResponse.json({ ok: false, errorCode: "rate_limited", message: "Too many requests. Please try again shortly." }, { status: 429 });
  }

  const result = await associateRunWithProject({
    uid,
    runId: runIdResult.runId,
    targetProjectId: targetResult.value,
    expectedProjectId: expectedResult.value,
  });

  switch (result.status) {
    case "associated": {
      // Secondary, best-effort, awaited — only ever called AFTER the
      // canonical transaction has already committed. `projectId` on the
      // event is required non-null by `ProjectEventBase`; exactly one of
      // fromProjectId/toProjectId can be null for a real (non-no-op)
      // association change, so the other is always a valid value here.
      const eventProjectId = result.toProjectId ?? result.fromProjectId;
      if (eventProjectId !== null) {
        await writeProjectEvent({
          eventType: "project_run_association_changed",
          actorUid: uid,
          workspaceId: result.workspaceId,
          projectId: eventProjectId,
          runId: result.runId,
          fromProjectId: result.fromProjectId,
          toProjectId: result.toProjectId,
        });
      } else {
        logger.error("[api/user/runs/[runId]/project] Unreachable: both fromProjectId and toProjectId null for a committed association change", { runId: result.runId });
      }
      return NextResponse.json({ ok: true, runId: result.runId, projectId: result.toProjectId });
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
    case "run_state_invalid":
    case "workspace_invalid":
    case "workspaces_disabled":
    case "firestore_unavailable":
    case "transaction_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
