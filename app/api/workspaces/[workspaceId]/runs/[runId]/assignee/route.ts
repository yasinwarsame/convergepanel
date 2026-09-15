/**
 * Project/Research Assignment —
 * `GET|PATCH /api/workspaces/{workspaceId}/runs/{runId}/assignee`.
 *
 * PATCH sets or clears a Team run's primary assignee via
 * `setTeamRunAssignee()` (the frozen order: admission → `research.organize`
 * in-transaction → run binding → expected-state OCC against the normalized
 * current value → target validation EVEN on a same-value repeat → no-op
 * decision → one-field write + in-transaction audit event). The route
 * performs no authorization read of its own.
 *
 * GET is the READ-ONLY presentation companion the assignee picker uses:
 * the run's current assignee (normalized, name resolved through membership
 * evidence, `state` under the D2 run rule) and — for the D8 non-blocking
 * overlap warning — the uids currently acting as this run's reviewer(s),
 * read structurally by `readRunReviewerUidsForAssignmentWarning()`. That
 * read is deliberately independent of Approval Workflow admission and
 * never touches review routes, documents, eligibility, or state machine.
 *
 * GET is gated exactly like the editor it serves (PR #164 review C5):
 * Team run access, then Project Assignment admission (D10; non-admission
 * concealed with the established indistinguishable denial), then
 * `research.organize`. It deliberately does NOT require Approval Workflow
 * admission. Reviewer/Viewer roles (research.read only) cannot retrieve
 * `reviewerUids` through this endpoint; ordinary assignee data stays
 * available on the list/detail DTOs as frozen by D10.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";
import { parseRunAssigneeBody } from "@/lib/projects/assignmentBody";
import { setTeamRunAssignee } from "@/lib/projects/setTeamRunAssignee";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse, teamRunLookupUnavailableResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { adminDb } from "@/lib/firebase/admin";
import { validateTeamRunRowShape } from "@/lib/workspaces/teamRunRowValidation";
import { normalizeStoredAssigneeUid } from "@/lib/workspaces/assignmentNormalization";
import { resolveAssigneePresentations } from "@/lib/workspaces/assigneePresentation";
import { readRunReviewerUidsForAssignmentWarning } from "@/lib/workspaces/runAssignmentReviewOverlap";
import { logger } from "@/lib/logger";
import { PROJECT_ASSIGNMENT_ENABLED, PROJECT_ASSIGNMENT_CANARY_UIDS } from "@/lib/env";
import { resolveProjectAssignmentAdmission } from "@/lib/workspaces/projectAssignmentRollout";
import { invalidRequestBodyResponse, unexpectedFieldResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { teamProjectAuthorizationDeniedResponse } from "@/lib/projects/teamProjectErrorResponse";
import { runNotFoundConcealedResponse } from "@/lib/projects/projectErrorResponse";
import { assigneeNotEligibleResponse, assigneeConflictResponse } from "@/lib/projects/assignmentErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest, method: "GET" | "PATCH"): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: `${method} /api/workspaces/[workspaceId]/runs/[runId]/assignee`, method, failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req, "GET");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId } = params;

  const runIdResult = validateRunIdSyntax(params.runId);
  if (!runIdResult.ok) {
    const { status, body } = runNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }

  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamRunAccessDeniedResponse(access.reason);
    return NextResponse.json(body, { status });
  }
  // D10 — Project Assignment admission, concealed identically to Team
  // non-admission / non-membership (never a rollout oracle). Checked BEFORE
  // the capability so a non-admitted caller learns nothing either way.
  const assignmentAdmission = resolveProjectAssignmentAdmission({ uid, globalEnabled: PROJECT_ASSIGNMENT_ENABLED, canaryUidsRaw: PROJECT_ASSIGNMENT_CANARY_UIDS });
  if (!assignmentAdmission.admitted) {
    const { status, body } = teamRunAccessDeniedResponse("team_workspaces_disabled");
    return NextResponse.json(body, { status });
  }
  // The editor's own capability (research.organize) — never merely research.read.
  if (!access.capabilities.includes("research.organize")) {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }
  if (!adminDb) {
    const { status, body } = teamRunLookupUnavailableResponse();
    return NextResponse.json(body, { status });
  }

  try {
    const snap = await adminDb.collection("runs").doc(runIdResult.runId).get();
    if (!snap.exists) {
      const { status, body } = runNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    const data = snap.data() as Record<string, unknown>;
    const validated = validateTeamRunRowShape(data, workspaceId);
    if (!validated.ok) {
      const { status, body } = runNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    const normalized = normalizeStoredAssigneeUid(data.assigneeUid);
    if (normalized.malformed) {
      logger.warn("[api/workspaces/runs/assignee GET] Malformed stored assigneeUid normalized to null (integrity anomaly)", { workspaceId, runId: runIdResult.runId });
    }
    const [presentations, reviewerUids] = await Promise.all([
      normalized.uid ? resolveAssigneePresentations(workspaceId, "run", [normalized.uid]) : Promise.resolve(new Map()),
      readRunReviewerUidsForAssignmentWarning(runIdResult.runId),
    ]);
    const assignee = normalized.uid ? (presentations.get(normalized.uid) ?? null) : null;
    return NextResponse.json({ ok: true, runId: runIdResult.runId, workspaceId, projectId: validated.projectId, assignee, reviewerUids });
  } catch (err) {
    logger.warn("[api/workspaces/runs/assignee GET] read failed", { workspaceId, error: err instanceof Error ? err.message : String(err) });
    const { status, body } = teamRunLookupUnavailableResponse();
    return NextResponse.json(body, { status });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req, "PATCH");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId } = params;

  const runIdResult = validateRunIdSyntax(params.runId);
  if (!runIdResult.ok) {
    // Same concealed response a well-formed-but-foreign run id gets — never a distinguishable 400.
    const { status, body } = runNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }

  // UID-scoped, never Workspace-scoped.
  const rateLimitResult = await checkRateLimit({ maxRequests: 20, windowSeconds: 60, identifier: `team-run-assignee:${uid}` });
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
  const parsed = parseRunAssigneeBody(rawBody);
  if (!parsed.ok) {
    const { status, body } = parsed.reason === "unknown_field" ? unexpectedFieldResponse() : invalidRequestBodyResponse();
    return NextResponse.json(body, { status });
  }

  const result = await setTeamRunAssignee({ uid, workspaceId, runId: runIdResult.runId, assigneeUid: parsed.assigneeUid, expectedAssigneeUid: parsed.expectedAssigneeUid });

  switch (result.status) {
    case "assigned":
      return NextResponse.json({ ok: true, changed: true, runId: result.runId, workspaceId: result.workspaceId, assigneeUid: result.assigneeUid });
    case "unchanged":
      return NextResponse.json({ ok: true, changed: false, runId: result.runId, workspaceId: result.workspaceId, assigneeUid: result.assigneeUid });
    case "team_workspaces_disabled":
    case "project_assignment_disabled": {
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
      const { status, body } = assigneeConflictResponse();
      return NextResponse.json(body, { status });
    }
    case "assignee_not_eligible": {
      const { status, body } = assigneeNotEligibleResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "transaction_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
