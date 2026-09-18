/**
 * TEAM-VERIFICATION-PARITY-R5-I1 —
 * `GET /api/workspaces/{workspaceId}/video-verifications/{verificationId}`:
 * the canonical Team-native durable Video verification DETAIL read.
 *
 * Order: identity -> verification id and optional `?projectId` syntax (a
 * malformed value is concealed, never a distinguishable 400) -> Team Workspace
 * access -> `research.read` -> Firestore availability -> document read ->
 * `validateTeamVideoVerificationRowShape()` against the ADDRESSED Workspace ->
 * optional exact Project containment -> Project label -> canonical stored
 * mapper -> response.
 *
 * - Never authorizes by the creator, `userId`, the uploader, the dedup
 *   requester, an assignment or a reviewer. A PERSONAL Video row, a
 *   foreign-Workspace row, a malformed row, a missing document, a wrong
 *   Project address and a malformed id all return the SAME concealed
 *   not-found. There is NO Personal fallback in this route.
 * - `?projectId` is an extra containment assertion only; without it any Team
 *   Video contained by the addressed Workspace is readable.
 * - Project semantics: `projectId === null` is genuinely Unfiled. A filed
 *   Video whose Project is missing or malformed KEEPS its non-null
 *   `projectId` and degrades only the label to `null` — the client renders
 *   that as "Project unavailable", never as "Unfiled", which is why this route
 *   must not rewrite `projectId` to `null`. A Project belonging to another
 *   Workspace is an integrity anomaly and conceals the artifact. A Project
 *   READ failure is a 503, never a silent `null`. Archived Projects stay
 *   readable and return their real `status`.
 * - The stored mapper is tolerant PRESENTATION logic and runs only AFTER
 *   binding validation, authorization and containment have all succeeded. It
 *   is never the security boundary.
 * - Read-only: no write, provider execution, quota, usage charge, video
 *   counter, token accounting, governance evaluation, review write, repair or
 *   backfill. No live Personal governance call.
 *
 * The verification id is validated with the repository's established
 * `validateRunIdSyntax()` before any Firestore lookup: Team Video ids are
 * `vid-${randomUUID()}`, which that helper accepts unchanged (non-empty,
 * trimmed, no control characters, no "/", within Firestore's document-id byte
 * limit), so no new permissive id parser is introduced here.
 *
 * The Personal-namespaced
 * `GET /api/user/verifications/[verificationId]?collection=videoVerifications`
 * keeps its existing Team-aware branch unchanged; this route is the canonical
 * Team address and the only one Team UI may use.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse, teamRunLookupUnavailableResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { teamVideoVerificationNotFoundConcealedResponse } from "@/lib/workspaces/teamVideoVerificationResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { validateTeamVideoVerificationRowShape } from "@/lib/workspaces/teamVideoVerificationRowValidation";
import { teamVideoTimestampIso, type TeamVideoVerificationProjectDto } from "@/lib/workspaces/teamVideoVerificationSummary";
import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";
import { validateProjectIdSyntax } from "@/lib/projects/projectId";
import { getProject } from "@/lib/firestore/projects";
import { adminDb } from "@/lib/firebase/admin";
import { mapStoredVideoVerificationToClientPayload } from "@/lib/user/mapStoredVideoVerificationToClientPayload";
import type { VideoVerificationClientPayload } from "@/lib/verification/videoVerificationClientPayload";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG = "[api/workspaces/video-verifications/detail GET]";

export type TeamVideoVerificationDetailResponse = {
  ok: true;
  payload: VideoVerificationClientPayload;
  team: {
    workspaceId: string;
    projectId: string | null;
    project: TeamVideoVerificationProjectDto | null;
    createdAt: string;
  };
};

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/video-verifications/[verificationId]", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function concealed() {
  const { status, body } = teamVideoVerificationNotFoundConcealedResponse();
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
    const snap = await adminDb.collection("videoVerifications").doc(verificationId).get();
    if (!snap.exists) return concealed();
    data = snap.data() as Record<string, unknown>;
  } catch (err) {
    logger.warn(`${LOG} video verification read failed`, { workspaceId, verificationId, error: err instanceof Error ? err.message : String(err) });
    const { status, body } = teamRunLookupUnavailableResponse();
    return NextResponse.json(body, { status });
  }

  // Workspace containment from the artifact's OWN persisted binding against
  // the ADDRESSED Workspace. A Personal Video row has no workspaceId and fails
  // here — it never falls back to creator ownership.
  const validated = validateTeamVideoVerificationRowShape(data, workspaceId);
  if (!validated.ok) return concealed();
  if (expectedProjectId !== null && validated.projectId !== expectedProjectId) return concealed();

  let project: TeamVideoVerificationProjectDto | null = null;
  if (validated.projectId !== null) {
    const projectResult = await getProject(validated.projectId);
    if (projectResult.status === "firestore_unavailable" || projectResult.status === "read_failed") {
      logger.warn(`${LOG} project read failed`, { workspaceId, verificationId, errorCategory: projectResult.status });
      const { status, body } = teamRunLookupUnavailableResponse();
      return NextResponse.json(body, { status });
    }
    if (projectResult.status === "found") {
      if (projectResult.project.workspaceId !== workspaceId) {
        logger.warn(`${LOG} video filed in a Project of another Workspace (integrity anomaly)`, { workspaceId, verificationId });
        return concealed();
      }
      project = { id: projectResult.project.id, name: projectResult.project.name, status: projectResult.project.status };
    } else {
      // Missing or malformed Project: the Video itself stays readable and
      // KEEPS its non-null projectId. "Project unavailable", not "Unfiled".
      logger.warn(`${LOG} filed video's Project unresolved; label omitted`, { workspaceId, verificationId, errorCategory: projectResult.status });
    }
  }

  const createdAt = teamVideoTimestampIso(data.timestamp);
  if (createdAt === null) {
    // The row validator already proved `timestamp` is a real Timestamp, so
    // this is an internal inconsistency, not a client-visible not-found.
    logger.error(`${LOG} validated Team Video row produced no usable timestamp`, { workspaceId, verificationId });
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }

  let payload: VideoVerificationClientPayload;
  try {
    payload = mapStoredVideoVerificationToClientPayload(verificationId, data);
  } catch (e: unknown) {
    logger.error(`${LOG} Team Video map failed`, { workspaceId, verificationId, error: e instanceof Error ? e.message : String(e) });
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }

  const response: TeamVideoVerificationDetailResponse = {
    ok: true,
    payload,
    team: {
      workspaceId,
      projectId: validated.projectId,
      project,
      createdAt,
    },
  };
  return NextResponse.json(response);
}
