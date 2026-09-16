/**
 * Team Research Parity, Phase R1 —
 * `GET /api/workspaces/{workspaceId}/runs/{runId}`: the authorized Team
 * research DETAIL read.
 *
 * Returns, for a Team-bound run contained by the addressed Workspace, the
 * SAME canonical research payload `GET /api/user/runs/[runId]` returns
 * (built by the shared `buildRunReadPayload()` — adaptive envelope,
 * legacy-adaptive envelope, persisted synthesis cache, governance, human
 * review, reviewer redaction), plus Team-scope presentation fields under
 * `team`: containment ids, the Project label, the primary assignee, the
 * run's own dates, snapshot provenance, and a read-only review summary.
 *
 * Authorization is the established Team run family, in the sibling order
 * (`.../runs/{runId}/assignee`): identity → run-id syntax → optional
 * `?projectId=` syntax → `resolveTeamRunWorkspaceAccess()` →
 * `research.read` → Firestore availability → run existence →
 * `validateTeamRunRowShape()` Workspace containment → optional Project
 * containment. Every denial that is not an infrastructure failure is the
 * concealed 404 (`teamRunAccessDeniedResponse` / `runNotFoundConcealedResponse`);
 * a granted member lacking `research.read` gets the family's 403. The
 * user route's LOCAL 403/404 mapping is deliberately NOT copied here.
 *
 * Never authorizes by assignment, run creator, or role label: `viewerRole`
 * (`team_member` | `team_reviewer`) is derived by the shared
 * `deriveTeamRunViewerRole()` AFTER access is granted and only refines
 * redaction. Read-only: no writes, no synthesis regeneration, no model
 * execution, no Project ACL (Project = containment + label; an archived
 * Project stays readable), no rollout flag beyond the Team admission the
 * access resolver already applies.
 */

import { NextRequest, NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";
import { validateProjectIdSyntax } from "@/lib/projects/projectId";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse, teamRunLookupUnavailableResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { runNotFoundConcealedResponse } from "@/lib/projects/projectErrorResponse";
import { adminDb } from "@/lib/firebase/admin";
import { validateTeamRunRowShape } from "@/lib/workspaces/teamRunRowValidation";
import { getProject } from "@/lib/firestore/projects";
import { resolveRunAssigneesForPage } from "@/lib/workspaces/teamRunAssigneeEnrichment";
import type { TeamRunAssigneeDto } from "@/lib/workspaces/teamRunSummary";
import { getAdaptiveHumanReviewAssignment } from "@/lib/firestore/runs";
import { deriveTeamRunViewerRole } from "@/lib/workspaces/deriveTeamRunViewerRole";
import { buildRunReadPayload, type RunReadPayload } from "@/lib/runs/runReadPayload";
import { resolveRunReviewRouting } from "@/lib/runs/resolveRunReviewRouting";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { PERSONAL_RESEARCH_SNAPSHOT_ORIGIN_TYPE } from "@/lib/workspaces/personalResearchSnapshotOrigin";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG = "[api/workspaces/runs/detail GET]";

/** Project label only — never the Project's assignment or authorship metadata. */
export type TeamRunDetailProjectDto = { id: string; name: string; status: string };

/** Snapshot provenance: kind and the source's own dates. NEVER the source run id (a Personal address). */
export type TeamRunDetailOriginDto = { kind: "personal_research"; sourceCreatedAt: string; sourceCompletedAt: string | null };

/** Read-only review summary from the persisted governance record — no reviewer identity, no comment text. */
export type TeamRunDetailReviewDto = {
  humanReviewStatus: string;
  conditions: string[] | null;
  decidedVia: string | null;
  decisionReceipt: { conclusion: string; sourceBacked: boolean; humanReviewNeeded: boolean } | null;
};

export type TeamRunDetailResponse = RunReadPayload & {
  team: {
    workspaceId: string;
    projectId: string | null;
    project: TeamRunDetailProjectDto | null;
    assignee: TeamRunAssigneeDto | null;
    createdAt: string | null;
    completedAt: string | null;
    origin: TeamRunDetailOriginDto | null;
    review: TeamRunDetailReviewDto | null;
  };
};

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/runs/[runId]", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function toIsoOrNull(value: unknown): string | null {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}

function presentOrigin(value: unknown): TeamRunDetailOriginDto | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.type !== PERSONAL_RESEARCH_SNAPSHOT_ORIGIN_TYPE) return null;
  if (!(o.sourceCreatedAt instanceof Timestamp)) return null;
  return {
    kind: PERSONAL_RESEARCH_SNAPSHOT_ORIGIN_TYPE,
    sourceCreatedAt: o.sourceCreatedAt.toDate().toISOString(),
    sourceCompletedAt: toIsoOrNull(o.sourceCompletedAt),
  };
}

function presentReview(governanceRecord: unknown): TeamRunDetailReviewDto | null {
  const parsed = parseGovernanceRecord(governanceRecord);
  if (!parsed.ok) return null;
  const { humanReview, decisionReceipt } = parsed.record;
  return {
    humanReviewStatus: humanReview.status,
    conditions: humanReview.conditions ?? null,
    decidedVia: humanReview.decidedVia ?? null,
    decisionReceipt: decisionReceipt
      ? { conclusion: decisionReceipt.conclusion, sourceBacked: decisionReceipt.sourceBacked, humanReviewNeeded: decisionReceipt.humanReviewNeeded }
      : null,
  };
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId } = params;

  const runIdResult = validateRunIdSyntax(params.runId);
  if (!runIdResult.ok) {
    const { status, body } = runNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }
  const runId = runIdResult.runId;

  // Optional Project containment. A malformed value is concealed exactly
  // like a foreign one — never a distinguishable 400 — and is rejected
  // BEFORE any Workspace lookup so a syntax probe learns nothing.
  const rawExpectedProjectId = req.nextUrl.searchParams.get("projectId");
  let expectedProjectId: string | null = null;
  if (rawExpectedProjectId !== null) {
    const projectIdResult = validateProjectIdSyntax(rawExpectedProjectId);
    if (!projectIdResult.ok) {
      const { status, body } = runNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    expectedProjectId = projectIdResult.projectId;
  }

  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamRunAccessDeniedResponse(access.reason);
    return NextResponse.json(body, { status });
  }
  if (!access.capabilities.includes("research.read")) {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }
  if (!adminDb) {
    const { status, body } = teamRunLookupUnavailableResponse();
    return NextResponse.json(body, { status });
  }

  let data: Record<string, unknown>;
  try {
    const snap = await adminDb.collection("runs").doc(runId).get();
    if (!snap.exists) {
      const { status, body } = runNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    data = snap.data() as Record<string, unknown>;
  } catch (err) {
    logger.warn(`${LOG} run read failed`, { workspaceId, runId, error: err instanceof Error ? err.message : String(err) });
    const { status, body } = teamRunLookupUnavailableResponse();
    return NextResponse.json(body, { status });
  }

  // Workspace containment — the run's OWN persisted binding must name the
  // addressed Workspace; a Personal run, a foreign-Workspace run, or a
  // structurally broken row is concealed as absent.
  const validated = validateTeamRunRowShape(data, workspaceId);
  if (!validated.ok) {
    const { status, body } = runNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }
  // Project containment — when addressed through a Project, the run must be
  // filed in exactly that Project (an Unfiled run is not in any Project).
  if (expectedProjectId !== null && validated.projectId !== expectedProjectId) {
    const { status, body } = runNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }

  // Role refinement ONLY (access is already granted above). A lookup failure
  // yields the lesser `team_member` role, never a denial and never a grant.
  const assignmentResult = await getAdaptiveHumanReviewAssignment(runId);
  const viewerRole = deriveTeamRunViewerRole({ uid, capabilities: access.capabilities, assignmentResult, governanceRecord: data.governanceRecord });

  const requestId = req.headers.get("x-vercel-id") ?? req.headers.get("x-request-id") ?? undefined;
  const payload = await buildRunReadPayload({ runId, data, viewerRole, requestId, resolveReviewRouting: resolveRunReviewRouting });

  // Project label — containment + label only (no Project ACL). A missing or
  // malformed Project document degrades to `null` (the run stays readable);
  // a Project that belongs to ANOTHER Workspace is an integrity anomaly and
  // is concealed rather than leaked; an infrastructure failure is a 503.
  let project: TeamRunDetailProjectDto | null = null;
  const [projectResult, assignees] = await Promise.all([
    validated.projectId !== null ? getProject(validated.projectId) : Promise.resolve(null),
    resolveRunAssigneesForPage(workspaceId, [{ docId: runId, data }]),
  ]);
  if (projectResult !== null) {
    if (projectResult.status === "firestore_unavailable" || projectResult.status === "read_failed") {
      logger.warn(`${LOG} project read failed`, { workspaceId, runId, errorCategory: projectResult.status });
      const { status, body } = teamRunLookupUnavailableResponse();
      return NextResponse.json(body, { status });
    }
    if (projectResult.status === "found") {
      if (projectResult.project.workspaceId !== workspaceId) {
        logger.warn(`${LOG} run filed in a Project of another Workspace (integrity anomaly)`, { workspaceId, runId });
        const { status, body } = runNotFoundConcealedResponse();
        return NextResponse.json(body, { status });
      }
      project = { id: projectResult.project.id, name: projectResult.project.name, status: projectResult.project.status };
    } else {
      logger.warn(`${LOG} filed run's Project unresolved; label omitted`, { workspaceId, runId, errorCategory: projectResult.status });
    }
  }

  const response: TeamRunDetailResponse = {
    ...payload,
    team: {
      workspaceId,
      projectId: validated.projectId,
      project,
      assignee: assignees[0] ?? null,
      createdAt: toIsoOrNull(data.createdAt),
      completedAt: toIsoOrNull(data.completedAt),
      origin: presentOrigin(data.origin),
      review: presentReview(data.governanceRecord),
    },
  };
  return NextResponse.json(response);
}
