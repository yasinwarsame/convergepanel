/**
 * Approval Workflow, Phase 9B.5.2 —
 * `POST /api/workspaces/{workspaceId}/runs/{runId}/review-panel/vote`.
 * Deliberately NO Approval Workflow admission check — casting a vote on an
 * already-open panel is a drain operation, mirroring the legacy vote
 * route's own permanent design (never gated on the multi-reviewer opt-in).
 * Team Workspace admission and `reviews.submit`/`research.read` capability
 * remain mandatory in every case, checked inside the mutation service's own
 * transaction.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { teamRunWorkspaceNotFoundConcealedResponse, teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { teamWorkspacesDisabledResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { submitWorkspaceReviewPanelVote, type SubmitWorkspaceReviewPanelVoteFailureReason } from "@/lib/workspaces/workspaceReviewPanelMutations";
import { parseSubmitAdaptiveReviewVoteRequest } from "@/lib/governance/adaptiveHumanReviewVote";
import type { TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function mapValidationFailure(reason: string): NextResponse {
  return errorResponse(400, "validation_error", `Invalid vote request: ${reason}`);
}

function authDenialResponse(reason: TeamMutationAuthorizationDenialReason): NextResponse {
  if (reason === "insufficient_capability") {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }
  const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
  return NextResponse.json(body, { status });
}

function voteErrorResponse(reason: SubmitWorkspaceReviewPanelVoteFailureReason): NextResponse {
  if (reason === "team_workspaces_disabled") {
    const { status, body } = teamWorkspacesDisabledResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "firestore_unavailable" || reason === "write_failed") {
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "run_not_found" || reason === "panel_absent") {
    const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }
  if (reason === "not_reviewer" || reason === "self_review") {
    // Collapsed to the SAME response — never distinguishable, mirroring
    // the legacy vote route's own "reviewer_not_assigned" concealment
    // discipline (never disclose whether a caller was previously assigned,
    // is a non-member, or is the run's own creator).
    return errorResponse(403, "not_reviewer", "You are not currently eligible to vote on this run's review panel.");
  }
  if (reason === "panel_not_open") return errorResponse(409, "panel_not_open", "This review panel is no longer open — votes are not accepted.");
  if (reason === "panel_unreadable") return errorResponse(409, "panel_unreadable", "This run's review panel could not be read.");
  if (reason === "panel_stale") return errorResponse(409, "panel_stale", "This panel has changed since you last viewed it. Please refresh and try again.");
  if (reason === "not_pending") return errorResponse(409, "not_pending", "This review is no longer pending — votes can only be cast while a review is pending.");
  if (reason === "vote_conflict") return errorResponse(409, "vote_conflict", "You have already submitted a different vote for this panel revision.");
  if (reason === "vote_malformed") {
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }
  return authDenialResponse(reason as TeamMutationAuthorizationDenialReason);
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: "/api/workspaces/[workspaceId]/runs/[runId]/review-panel/vote", method: "POST", failureCategory: identity.reason });
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
  const parsed = parseSubmitAdaptiveReviewVoteRequest(rawBody);
  if (!parsed.ok) return mapValidationFailure(parsed.reason);
  const { panelRevision, status, comment, conditions } = parsed.value;

  const result = await submitWorkspaceReviewPanelVote({ uid, workspaceId, runId, panelRevision, status, comment, conditions });
  if (!result.ok) return voteErrorResponse(result.reason);
  return NextResponse.json({ ok: true, submissionStatus: result.submissionStatus, vote: result.vote });
}
