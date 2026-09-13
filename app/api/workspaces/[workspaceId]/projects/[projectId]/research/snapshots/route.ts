/**
 * ADD-TO-TEAM-PROJECT —
 * `POST /api/workspaces/{workspaceId}/projects/{projectId}/research/snapshots`.
 * Copies the caller's OWN Personal research run into this Team Project as a
 * new Team-owned run. POST only.
 *
 * Thin route: identity → rate limit → body parsing →
 * `createTeamRunSnapshotFromPersonal()` → (on a real creation only) best-
 * effort secondary event → response mapping. Performs NO non-transactional
 * Workspace/membership/capability/source read of its own — the primitive
 * owns the Team rollout gate and the entire authorization decision happens
 * exactly once, inside its single Firestore transaction.
 *
 * The destination is the PATH (`workspaceId`, `projectId`), never the body.
 * The body carries exactly one typed source identity
 * (`{ source: { sourceType: "personal_research", runId } }`); run content
 * of any kind in the body is rejected as an unexpected field. The server
 * reconstructs the snapshot exclusively from the persisted source.
 *
 * ZERO QUOTA. This route never calls the inference quota writer and never
 * executes a model: nothing here spends.
 * The rate limit is a UID-scoped abuse ceiling, not a billing unit.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { parseResearchSnapshotBody } from "@/lib/workspaces/researchSnapshotBody";
import { createTeamRunSnapshotFromPersonal } from "@/lib/firestore/teamRunSnapshots";
import { writeTeamProjectEventSafely } from "@/lib/projects/writeTeamProjectEventSafely";
import { invalidRequestBodyResponse, unexpectedFieldResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { teamProjectAuthorizationDeniedResponse, teamProjectNotFoundConcealedResponse } from "@/lib/projects/teamProjectErrorResponse";
import { projectArchivedTargetResponse } from "@/lib/projects/projectErrorResponse";
import { TEAM_RESEARCH_SNAPSHOT_RATE_LIMIT, buildTeamResearchSnapshotDto, snapshotTooLargeResponse, sourceResearchNotFoundConcealedResponse } from "@/lib/workspaces/teamResearchSnapshotResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/workspaces/[workspaceId]/projects/[projectId]/research/snapshots", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; projectId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, projectId } = params;

  // UID-scoped, not Workspace-scoped — moving across Workspace ids must
  // never let a caller bypass the user-level ceiling. Checked before body
  // parsing so an unparseable flood is still counted.
  const rateLimitResult = await checkRateLimit({
    maxRequests: TEAM_RESEARCH_SNAPSHOT_RATE_LIMIT.maxRequests,
    windowSeconds: TEAM_RESEARCH_SNAPSHOT_RATE_LIMIT.windowSeconds,
    identifier: `team-personal-research-snapshot:${uid}`,
  });
  if (!rateLimitResult.allowed) {
    return NextResponse.json({ ok: false, errorCode: "rate_limited", message: "Too many requests. Please try again shortly." }, { status: 429 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const parsed = parseResearchSnapshotBody(rawBody);
  if (!parsed.ok) {
    if (parsed.reason === "unknown_field") {
      const { status, body } = unexpectedFieldResponse();
      return NextResponse.json(body, { status });
    }
    if (parsed.reason === "invalid_run_id") {
      // Same concealed response a well-formed-but-foreign source gets —
      // never a distinguishable 400, which would itself be an oracle.
      const { status, body } = sourceResearchNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    const { status, body } = invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const result = await createTeamRunSnapshotFromPersonal({ uid, workspaceId, projectId, sourceRunId: parsed.sourceRunId });

  switch (result.status) {
    case "created": {
      // Secondary, best-effort, awaited — only ever AFTER the canonical
      // transaction (run + lock + Workspace Audit event) has committed, and
      // never from inside the retryable callback. Its failure never makes
      // the committed snapshot look rolled back. The authoritative audit
      // row is the `workspaceMembershipEvents` document written in-transaction.
      await writeTeamProjectEventSafely({
        eventType: "project_run_association_changed",
        actorUid: uid,
        workspaceId: result.workspaceId,
        projectId: result.projectId,
        runId: result.runId,
        fromProjectId: null,
        toProjectId: result.projectId,
      });
      return NextResponse.json(buildTeamResearchSnapshotDto({ status: "created", runId: result.runId, workspaceId: result.workspaceId, projectId: result.projectId }), { status: 201 });
    }
    case "already_exists": {
      // Idempotent repeat: no second run, no second lock, no second audit
      // event, and no secondary event either.
      return NextResponse.json(buildTeamResearchSnapshotDto({ status: "already_exists", runId: result.runId, workspaceId: result.workspaceId, projectId: result.projectId }), { status: 200 });
    }
    case "team_workspaces_disabled": {
      // Concealed identically to "unauthorized" — never a rollout-cohort oracle.
      const { status, body } = teamProjectAuthorizationDeniedResponse("team_workspaces_disabled");
      return NextResponse.json(body, { status });
    }
    case "unauthorized": {
      const { status, body } = teamProjectAuthorizationDeniedResponse(result.reason);
      return NextResponse.json(body, { status });
    }
    case "project_not_found": {
      const { status, body } = teamProjectNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    case "project_archived": {
      const { status, body } = projectArchivedTargetResponse();
      return NextResponse.json(body, { status });
    }
    case "source_not_found": {
      const { status, body } = sourceResearchNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    case "snapshot_too_large": {
      const { status, body } = snapshotTooLargeResponse();
      return NextResponse.json(body, { status });
    }
    case "integrity_failure":
    case "firestore_unavailable":
    case "transaction_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
