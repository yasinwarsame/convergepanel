/**
 * Approval Workflow, Phase 9B.5.1 —
 * `GET/PUT/DELETE /api/workspaces/{workspaceId}/runs/{runId}/review-assignment`.
 * Workspace-qualified single-reviewer assignment management. Adaptive Deep
 * Research only; legacy Team assignment route (`/api/teams/adaptive-runs/
 * [runId]/assignment`) is completely untouched by this file.
 *
 * Two independent, both-required admission gates before ANY Firestore
 * access, mirroring the Phase 9B.4 queue route exactly: Approval Workflow
 * admission (pure, zero I/O), then Team Workspace access. GET additionally
 * requires `research.read` AND `reviews.read` at the route layer (a plain
 * read, no write follows, so a non-transactional `resolveTeamRunWorkspaceAccess()`
 * check is sufficient — mirrors the queue route's own division of labor).
 * PUT/DELETE deliberately do NOT duplicate that capability check at the
 * route layer — `reviews.manage` is checked exactly once, inside the
 * mutation service's own transaction (`authorizeTeamWorkspaceMutationInTransaction()`),
 * so there is never a second, independent authorization window between a
 * route-level pre-check and the write (§8 of the Phase 9B.5.1 spec).
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunWorkspaceNotFoundConcealedResponse, teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import {
  getWorkspaceReviewAssignment,
  putWorkspaceReviewAssignment,
  deleteWorkspaceReviewAssignment,
  type PutWorkspaceReviewAssignmentFailureReason,
  type DeleteWorkspaceReviewAssignmentFailureReason,
} from "@/lib/workspaces/workspaceReviewMutations";
import { isCanonicalDueAt } from "@/lib/governance/adaptiveHumanReviewAssignment";
import type { TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

async function getUid(req: NextRequest, method: string): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "/api/workspaces/[workspaceId]/runs/[runId]/review-assignment", method, failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") return errorResponse(401, "unauthorized", "Please sign in.");
  return errorResponse(401, "auth_error", "Authentication failed.");
}

/** Gate 1 (Approval Workflow) then required for every method — never bypassed, never substituting for Team Workspace access. */
function checkApprovalAdmission(uid: string): NextResponse | null {
  const admission = resolveApprovalWorkflowAdmission({ uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (admission.admitted) return null;
  const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
  return NextResponse.json(body, { status });
}

/** Concealed mapping for `TeamMutationAuthorizationDenialReason` — the SAME vocabulary `resolveTeamRunWorkspaceAccess()`'s own denial reasons use, mapped identically (§7/§62 of the spec: no distinguishable oracle between "wrong workspace," "not a member," etc.). */
function authDenialResponse(reason: TeamMutationAuthorizationDenialReason): NextResponse {
  if (reason === "insufficient_capability") {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }
  const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
  return NextResponse.json(body, { status });
}

function mutationErrorResponse(reason: PutWorkspaceReviewAssignmentFailureReason | DeleteWorkspaceReviewAssignmentFailureReason): NextResponse {
  // Phase 10C.1A: "team_workspaces_disabled" falls through to the same
  // concealed authDenialResponse() mapping as every other non-infrastructure
  // denial reason below, closing the rollout-admission oracle.
  if (reason === "firestore_unavailable" || reason === "write_failed") {
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "run_not_found") {
    const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "active_panel") {
    return errorResponse(409, "active_panel", "This run is under active multi-reviewer panel review. Direct assignment changes are not available.");
  }
  if (reason === "panel_unreadable") {
    return errorResponse(409, "panel_unreadable", "This run's review panel could not be read.");
  }
  if (reason === "stale_revision") {
    return errorResponse(409, "stale_revision", "This assignment changed since you last viewed it. Please refresh and try again.");
  }
  if (reason === "invalid_due_at") {
    return errorResponse(400, "invalid_due_at", "dueAt must be a canonical UTC ISO-8601 timestamp (e.g. 2026-08-23T19:30:00.000Z) or null.");
  }
  if (reason === "due_at_required_on_reassignment") {
    return errorResponse(400, "due_at_required_on_reassignment", "Reassigning to a different reviewer requires an explicit dueAt (a canonical timestamp, or null).");
  }
  if (typeof reason === "object" && reason.kind === "target_not_eligible") {
    return errorResponse(400, "target_not_eligible", "The proposed reviewer is not eligible to be assigned.");
  }
  return authDenialResponse(reason as TeamMutationAuthorizationDenialReason);
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req, "GET");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, runId } = params;

  const admissionDenial = checkApprovalAdmission(uid);
  if (admissionDenial) return admissionDenial;

  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamRunAccessDeniedResponse(access.reason);
    return NextResponse.json(body, { status });
  }
  if (!access.capabilities.includes("research.read") || !access.capabilities.includes("reviews.read")) {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }

  const result = await getWorkspaceReviewAssignment({ workspaceId, runId });
  switch (result.status) {
    case "ok":
      return NextResponse.json({ ok: true, assignment: result.assignment, assignmentRevision: result.assignmentRevision });
    case "run_not_found": {
      const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
      return NextResponse.json(body, { status });
    }
    case "firestore_unavailable":
    case "read_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}

interface PutBody {
  assignedReviewerUserId?: unknown;
  expectedRevision?: unknown;
  dueAt?: unknown;
}

export async function PUT(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req, "PUT");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, runId } = params;

  const admissionDenial = checkApprovalAdmission(uid);
  if (admissionDenial) return admissionDenial;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON.");
  }
  const body = (rawBody ?? {}) as PutBody;

  if (typeof body.assignedReviewerUserId !== "string" || body.assignedReviewerUserId.trim().length === 0) {
    return errorResponse(400, "validation_error", "assignedReviewerUserId is required.");
  }
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    return errorResponse(400, "validation_error", "expectedRevision must be a non-negative integer.");
  }

  let dueAt: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(body, "dueAt")) {
    if (body.dueAt === null) {
      dueAt = null;
    } else if (typeof body.dueAt === "string") {
      if (!isCanonicalDueAt(body.dueAt)) {
        return errorResponse(400, "invalid_due_at", "dueAt must be a canonical UTC ISO-8601 timestamp (e.g. 2026-08-23T19:30:00.000Z) or null.");
      }
      dueAt = body.dueAt;
    } else {
      return errorResponse(400, "invalid_due_at", "dueAt must be a canonical UTC ISO-8601 timestamp, null, or omitted.");
    }
  } else {
    dueAt = undefined;
  }

  const result = await putWorkspaceReviewAssignment({ uid, workspaceId, runId, assignedReviewerUserId: body.assignedReviewerUserId, expectedRevision: body.expectedRevision, dueAt });
  if (!result.ok) return mutationErrorResponse(result.reason);
  return NextResponse.json({ ok: true, assignment: result.assignment });
}

interface DeleteBody {
  expectedRevision?: unknown;
}

export async function DELETE(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req, "DELETE");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, runId } = params;

  const admissionDenial = checkApprovalAdmission(uid);
  if (admissionDenial) return admissionDenial;

  let expectedRevision = 0;
  try {
    const rawBody = await req.json();
    const body = (rawBody ?? {}) as DeleteBody;
    if (body.expectedRevision !== undefined) {
      if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
        return errorResponse(400, "validation_error", "expectedRevision must be a non-negative integer.");
      }
      expectedRevision = body.expectedRevision;
    }
  } catch {
    // A body-less DELETE is valid — expectedRevision defaults to 0, matching the legacy assignment route's own convention.
  }

  const result = await deleteWorkspaceReviewAssignment({ uid, workspaceId, runId, expectedRevision });
  if (!result.ok) return mutationErrorResponse(result.reason);
  return NextResponse.json({ ok: true });
}
