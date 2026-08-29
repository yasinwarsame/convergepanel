/**
 * Approval Workflow, Phase 9B.5.2 —
 * `POST /api/workspaces/{workspaceId}/runs/{runId}/review-override`.
 * Explicit Owner Override — distinct from ordinary review decision, panel
 * finalization, and manager resubmission. Deliberately NO Approval
 * Workflow admission check: naturally self-limiting (an override against a
 * run with no existing panel fails `panel_absent` regardless of Approval
 * Workflow state, so this can never become a general hidden bypass for an
 * unrelated run — see `overrideWorkspaceReviewPanel`'s own doc comment).
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { teamRunWorkspaceNotFoundConcealedResponse, teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { overrideWorkspaceReviewPanel, type OverrideWorkspaceReviewPanelFailureReason } from "@/lib/workspaces/workspaceReviewPanelMutations";
import { parseSubmitAdaptiveReviewOverrideRequest } from "@/lib/governance/adaptivePanelOverride";
import type { TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function mapValidationFailure(reason: string): NextResponse {
  switch (reason) {
    case "malformed_body":
      return errorResponse(400, "validation_error", "Invalid request body.");
    case "missing_expected_panel_revision":
    case "invalid_expected_panel_revision":
      return errorResponse(400, "validation_error", "expectedPanelRevision must be a positive integer.");
    case "missing_expected_governance_updated_at":
    case "invalid_expected_governance_updated_at":
      return errorResponse(400, "validation_error", "expectedGovernanceUpdatedAt must be a valid timestamp.");
    case "invalid_status":
      return errorResponse(400, "validation_error", "status must be one of approved, approved_with_conditions, changes_requested, rejected.");
    case "missing_justification":
      return errorResponse(400, "validation_error", "A justification is required to override a review panel.");
    case "invalid_justification":
      return errorResponse(400, "validation_error", "justification must be a string.");
    case "justification_too_long":
      return errorResponse(400, "validation_error", "justification must be 4000 characters or fewer.");
    case "conditions_required":
      return errorResponse(400, "validation_error", "At least one condition is required for approved_with_conditions.");
    case "conditions_not_allowed":
      return errorResponse(400, "validation_error", "conditions are only allowed for approved_with_conditions.");
    case "too_many_conditions":
      return errorResponse(400, "validation_error", "Too many conditions.");
    case "condition_too_long":
      return errorResponse(400, "validation_error", "One or more conditions are too long.");
    case "invalid_conditions":
      return errorResponse(400, "validation_error", "conditions must be an array of strings.");
    default:
      return errorResponse(400, "validation_error", "Invalid request body.");
  }
}

function authDenialResponse(reason: TeamMutationAuthorizationDenialReason): NextResponse {
  if (reason === "insufficient_capability") {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }
  const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
  return NextResponse.json(body, { status });
}

function overrideErrorResponse(reason: OverrideWorkspaceReviewPanelFailureReason): NextResponse {
  // Phase 10C.1A: "team_workspaces_disabled" falls through to the same
  // concealed authDenialResponse() mapping as every other non-infrastructure
  // denial reason below, closing the rollout-admission oracle.
  if (reason === "firestore_unavailable" || reason === "write_failed") {
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "run_not_found" || reason === "panel_absent") {
    const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "panel_cancelled") return errorResponse(409, "panel_cancelled", "This review panel has been cancelled.");
  if (reason === "panel_unreadable") return errorResponse(409, "panel_unreadable", "This run's review panel could not be read.");
  if (reason === "governance_stale") return errorResponse(409, "governance_stale", "This run has changed since you last viewed it. Please refresh and try again.");
  if (reason === "not_pending") return errorResponse(409, "not_pending", "This review is no longer pending.");
  if (reason === "panel_stale") return errorResponse(409, "panel_stale", "This panel changed since you last viewed it. Please refresh and try again.");
  if (reason === "panel_already_finalized") return errorResponse(409, "panel_already_finalized", "This panel has already been finalized and cannot be overridden again.");
  if (reason === "inconsistent_finalization_state") return errorResponse(409, "inconsistent_finalization_state", "This run's review state is inconsistent and could not be verified.");
  if (reason === "review_content_unavailable") {
    return errorResponse(409, "review_content_unavailable", "This run's review content is not currently available. An override cannot be submitted until it is.");
  }
  return authDenialResponse(reason as TeamMutationAuthorizationDenialReason);
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: "/api/workspaces/[workspaceId]/runs/[runId]/review-override", method: "POST", failureCategory: identity.reason });
    if (identity.reason === "missing_credentials") return errorResponse(401, "unauthorized", "Please sign in.");
    return errorResponse(401, "auth_error", "Authentication failed.");
  }
  const uid = identity.uid;
  const { workspaceId, runId } = params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON.");
  }
  const parsed = parseSubmitAdaptiveReviewOverrideRequest(rawBody);
  if (!parsed.ok) return mapValidationFailure(parsed.reason);
  const { expectedPanelRevision, expectedGovernanceUpdatedAt, status, justification, conditions } = parsed.value;

  const result = await overrideWorkspaceReviewPanel({ uid, workspaceId, runId, expectedPanelRevision, expectedGovernanceUpdatedAt, status, justification, conditions });
  if (!result.ok) return overrideErrorResponse(result.reason);
  return NextResponse.json({ ok: true, override: { status: result.status, finalizedAt: result.finalizedAt } });
}
