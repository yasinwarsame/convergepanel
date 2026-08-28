/**
 * Approval Workflow, Phase 9B.5.1 —
 * `POST /api/workspaces/{workspaceId}/runs/{runId}/review-decision`.
 * Workspace-qualified ORDINARY (single-reviewer, non-panel) review
 * decision. Not Owner Override — no override marker exists on this path.
 * Legacy Team decision route (`/api/teams/adaptive-runs/[runId]/decision`)
 * is completely untouched by this file.
 *
 * Same two-gate admission model as the sibling review-assignment route.
 * Authorization for the write itself (active membership, `research.read`,
 * `reviews.submit`, canonical assignment naming the caller, self-review
 * guard) happens entirely inside `submitWorkspaceReviewDecision()`'s own
 * transaction via `isOrdinaryReviewerAuthorized()` (Phase 9B.1) — no
 * route-level capability pre-check, for the identical "no second
 * independent authorization window" reason as the assignment route.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { teamRunWorkspaceNotFoundConcealedResponse, teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { submitWorkspaceReviewDecision, type SubmitWorkspaceReviewDecisionFailureReason } from "@/lib/workspaces/workspaceReviewMutations";
import { parseAdaptiveReviewDecisionRequest } from "@/lib/governance/adaptiveHumanReviewRequest";
import type { TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "/api/workspaces/[workspaceId]/runs/[runId]/review-decision", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") return errorResponse(401, "unauthorized", "Please sign in.");
  return errorResponse(401, "auth_error", "Authentication failed.");
}

function authDenialResponse(reason: TeamMutationAuthorizationDenialReason): NextResponse {
  if (reason === "insufficient_capability") {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }
  const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
  return NextResponse.json(body, { status });
}

function decisionErrorResponse(reason: SubmitWorkspaceReviewDecisionFailureReason): NextResponse {
  // Phase 10C.1A: "team_workspaces_disabled" falls through to the same
  // concealed authDenialResponse() mapping as every other non-infrastructure
  // denial reason below, closing the rollout-admission oracle.
  if (reason === "firestore_unavailable" || reason === "write_failed" || reason === "unsupported_version" || reason === "governance_record_malformed") {
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "run_not_found" || reason === "governance_record_absent") {
    const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "active_panel") {
    return errorResponse(409, "active_panel", "This run is under active multi-reviewer panel review. Direct decision submission is not available.");
  }
  if (reason === "panel_unreadable") {
    return errorResponse(409, "panel_unreadable", "This run's review panel could not be read.");
  }
  if (reason === "stale_expected_updated_at") {
    return errorResponse(409, "stale_expected_updated_at", "This run has changed since you last viewed it. Please refresh and try again.");
  }
  if (reason === "not_reviewable") {
    return errorResponse(409, "not_reviewable", "This run already has a final review decision.");
  }
  if (typeof reason === "object" && reason.kind === "not_authorized") {
    // Every sub-reason (not_found/removed/cross_workspace/insufficient_capability/self_review/not_assigned)
    // collapses to the SAME external shape — never a distinguishable oracle
    // for whether the caller is merely unassigned vs. actually ineligible.
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }
  return authDenialResponse(reason as TeamMutationAuthorizationDenialReason);
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId, runId } = params;

  const admission = resolveApprovalWorkflowAdmission({ uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (!admission.admitted) {
    const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON.");
  }

  const parsed = parseAdaptiveReviewDecisionRequest(rawBody);
  if (!parsed.ok) {
    return errorResponse(400, "validation_error", `Invalid review request: ${parsed.reason}`);
  }
  const decision = parsed.value;

  const result = await submitWorkspaceReviewDecision({
    uid,
    workspaceId,
    runId,
    update: { status: decision.status, comment: decision.comment, conditions: decision.conditions },
    expectedUpdatedAt: decision.expectedUpdatedAt,
  });

  if (!result.ok) return decisionErrorResponse(result.reason);
  return NextResponse.json({ ok: true, review: { status: result.status, reviewedAt: result.reviewedAt } });
}
