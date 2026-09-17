/**
 * TEAM-VERIFICATION-PARITY-R3 —
 * `GET /api/workspaces/{workspaceId}/verifications/{verificationId}`: the
 * canonical Team-native durable Claim verification DETAIL read.
 *
 * Order: identity -> verification id and optional `?projectId` syntax (a
 * malformed value is concealed, never a distinguishable 400) -> Team Workspace
 * access -> `research.read` -> Firestore availability -> document read ->
 * `validateTeamClaimVerificationRowShape()` against the ADDRESSED Workspace ->
 * optional exact Project containment -> Project label + Team-safe source link
 * -> canonical stored mapper -> response.
 *
 * - Never authorizes by the creator, `userId`, assignment or reviewer. A
 *   Personal Claim row, a foreign-Workspace row, a malformed row, a missing
 *   document, a wrong Project address and a malformed id all return the SAME
 *   concealed not-found. There is no Personal fallback.
 * - `?projectId` is an extra containment assertion only; without it any Team
 *   Claim contained by the addressed Workspace is readable. Archived Projects
 *   stay readable. A missing or malformed Project degrades the label to
 *   `null`; a Project belonging to another Workspace is an integrity anomaly
 *   and conceals the artifact; a Project read failure is a 503.
 * - `sourceResearch` comes only from `resolveTeamSourceResearchLink()` with the
 *   verification's own Workspace; any failure collapses to `null` and never
 *   fails this already-authorized read.
 * - No live governance call, no reviewer identity, no creator uid. Read-only:
 *   no write, execution, quota, token accounting or governance evaluation.
 *
 * The Personal-namespaced `GET /api/user/verifications/[verificationId]`
 * keeps its existing Team-aware branch unchanged; this route is the canonical
 * Team address.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse, teamRunLookupUnavailableResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { teamClaimVerificationNotFoundConcealedResponse } from "@/lib/workspaces/teamClaimVerificationResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { validateTeamClaimVerificationRowShape } from "@/lib/workspaces/teamClaimVerificationRowValidation";
import { teamClaimTimestampIso, type TeamClaimVerificationProjectDto } from "@/lib/workspaces/teamClaimVerificationSummary";
import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";
import { validateProjectIdSyntax } from "@/lib/projects/projectId";
import { getProject } from "@/lib/firestore/projects";
import { adminDb } from "@/lib/firebase/admin";
import { resolveTeamSourceResearchLink } from "@/lib/verification/resolveTeamSourceResearchLink";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import type { ClaimVerificationClientPayload } from "@/lib/verification/claimVerificationClientPayload";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG = "[api/workspaces/verifications/detail GET]";

export type TeamClaimVerificationDetailResponse = {
  ok: true;
  payload: ClaimVerificationClientPayload;
  team: {
    workspaceId: string;
    projectId: string | null;
    project: TeamClaimVerificationProjectDto | null;
    createdAt: string;
  };
};

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/verifications/[verificationId]", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function concealed() {
  const { status, body } = teamClaimVerificationNotFoundConcealedResponse();
  return NextResponse.json(body, { status });
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; verificationId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId } = params;

  const idResult = validateRunIdSyntax(params.verificationId);
  if (!idResult.ok) return concealed();
  const verificationId = idResult.runId;

  const rawExpectedProjectId = req.nextUrl.searchParams.get("projectId");
  let expectedProjectId: string | null = null;
  if (rawExpectedProjectId !== null) {
    const projectIdResult = validateProjectIdSyntax(rawExpectedProjectId);
    if (!projectIdResult.ok) return concealed();
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
    const snap = await adminDb.collection("verifications").doc(verificationId).get();
    if (!snap.exists) return concealed();
    data = snap.data() as Record<string, unknown>;
  } catch (err) {
    logger.warn(`${LOG} verification read failed`, { workspaceId, verificationId, error: err instanceof Error ? err.message : String(err) });
    const { status, body } = teamRunLookupUnavailableResponse();
    return NextResponse.json(body, { status });
  }

  // Workspace containment from the artifact's OWN persisted binding against
  // the ADDRESSED Workspace. A Personal row has no workspaceId and fails here.
  const validated = validateTeamClaimVerificationRowShape(data, workspaceId);
  if (!validated.ok) return concealed();
  if (expectedProjectId !== null && validated.projectId !== expectedProjectId) return concealed();

  const [projectResult, sourceResearch] = await Promise.all([
    validated.projectId !== null ? getProject(validated.projectId) : Promise.resolve(null),
    resolveTeamSourceResearchLink({ origin: data.origin, callerUid: uid, expectedWorkspaceId: workspaceId }).catch(() => null),
  ]);

  let project: TeamClaimVerificationProjectDto | null = null;
  if (projectResult !== null) {
    if (projectResult.status === "firestore_unavailable" || projectResult.status === "read_failed") {
      logger.warn(`${LOG} project read failed`, { workspaceId, verificationId, errorCategory: projectResult.status });
      const { status, body } = teamRunLookupUnavailableResponse();
      return NextResponse.json(body, { status });
    }
    if (projectResult.status === "found") {
      if (projectResult.project.workspaceId !== workspaceId) {
        logger.warn(`${LOG} verification filed in a Project of another Workspace (integrity anomaly)`, { workspaceId, verificationId });
        return concealed();
      }
      project = { id: projectResult.project.id, name: projectResult.project.name, status: projectResult.project.status };
    } else {
      logger.warn(`${LOG} filed verification's Project unresolved; label omitted`, { workspaceId, verificationId, errorCategory: projectResult.status });
    }
  }

  let payload: ClaimVerificationClientPayload;
  try {
    payload = mapStoredVerificationToClientPayload(data as unknown as ClaimVerificationFirestoreDoc, verificationId, { sourceResearch });
  } catch (e: unknown) {
    logger.error(`${LOG} Team Claim map failed`, { workspaceId, verificationId, error: e instanceof Error ? e.message : String(e) });
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }

  const response: TeamClaimVerificationDetailResponse = {
    ok: true,
    payload,
    team: {
      workspaceId,
      projectId: validated.projectId,
      project,
      createdAt: teamClaimTimestampIso(data.timestamp),
    },
  };
  return NextResponse.json(response);
}
