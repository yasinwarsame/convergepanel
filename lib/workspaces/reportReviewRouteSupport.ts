/**
 * Order B — shared HTTP gate and mapping for the Report Review routes (submit, context, resubmit, decision, export). Concealment policy matches the existing
 * review routes: every reason that would reveal whether a run exists, belongs to another Workspace, or whether the
 * feature is admitted collapses to the same concealed 404. A member lacking capability gets 403 (the Workspace is
 * already visible to them; nothing about the run is revealed). Eligibility, conflicts and gates are 409 with an exact
 * code, reached only after the caller is authorized for this run.
 */

import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";
import { resolveApprovalWorkflowAdmission } from "./approvalWorkflowRollout";
import { teamRunLookupUnavailableResponse, teamRunWorkspaceNotFoundConcealedResponse } from "./teamRunAccessResponse";
import { logger } from "@/lib/logger";
import { internalErrorResponse } from "./teamWorkspaceErrorResponse";
import type { ReportReviewMutationFailure } from "./reportReviewMutations";
import { isReportReviewEnabledForWorkspace } from "./reportReviewActivation";
import { resolveWorkspaceAccess } from "./resolveWorkspaceAccess";
import { REPORT_REVIEW_INELIGIBLE_EXPLANATIONS } from "@/lib/governance/reportReviewCopy";

export function reportReviewErrorBody(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function lookupUnavailable(): NextResponse {
  const { status, body } = teamRunLookupUnavailableResponse();
  return NextResponse.json(body, { status });
}

export function concealed(): NextResponse {
  const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
  return NextResponse.json(body, { status });
}

/**
 * `workspaceId` is the route's Workspace: report review must be activated for exactly that Workspace (Order B allow-list),
 * checked before anything else about the request is evaluated. Normal authorization then still applies in full.
 */
export async function reportReviewCaller(req: NextRequest, route: string, workspaceId: string, method: "GET" | "POST" = "POST"): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route, method, failureCategory: identity.reason });
    if (identity.reason === "missing_credentials") return reportReviewErrorBody(401, "unauthorized", "Please sign in.");
    return reportReviewErrorBody(401, "auth_error", "Authentication failed.");
  }
  // Report review is review machinery: it also requires Approval Workflow admission (concealed when not admitted).
  // Dark: concealed before anything else about the request (body shape included) is evaluated.
  if (!isReportReviewEnabledForWorkspace(workspaceId)) return concealed();
  const admission = resolveApprovalWorkflowAdmission({ uid: identity.uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (!admission.admitted) return concealed();
  // Order B review MINOR-1: an active member of THIS Team Workspace only, before the body is read. Otherwise a non-member
  // could tell the activated Workspace apart (malformed body → 400 there, concealed 404 everywhere else). Every
  // operation still re-authorizes its exact capability inside its own transaction; this check only conceals.
  // Infrastructure failure is NEVER collapsed into "not found" (teamRunAccessResponse.ts policy): it is a logged,
  // retryable 503. Accepted trade-off: only during a Firestore outage, the activated Workspace answers 503 where an
  // unlisted one answers 404 (the allow-list is checked without I/O) — far weaker than the steady-state oracle closed above.
  let access: Awaited<ReturnType<typeof resolveWorkspaceAccess>>;
  try {
    access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId });
  } catch (err) {
    logger.warn("[workspaces/reportReviewRouteSupport] workspace access lookup threw", { route, workspaceId, error: err instanceof Error ? err.message : String(err) });
    return lookupUnavailable();
  }
  if (!access.granted && access.reason === "lookup_failed") {
    logger.warn("[workspaces/reportReviewRouteSupport] workspace access lookup failed", { route, workspaceId });
    return lookupUnavailable();
  }
  if (!access.granted || access.workspaceType !== "team") return concealed();
  return identity.uid;
}

/** Fixed reason sentences (design §6, D-B8) for an authorized caller whose run cannot be submitted. */
// B3: single source shared with the page (lib/governance/reportReviewCopy.ts); the sentences are unchanged.
export const REPORT_REVIEW_INELIGIBLE_MESSAGES = REPORT_REVIEW_INELIGIBLE_EXPLANATIONS;

export function reportReviewFailureResponse(failure: ReportReviewMutationFailure): NextResponse {
  switch (failure.reason) {
    case "disabled":
    case "team_workspaces_disabled":
    case "run_not_found":
    case "workspace_not_found":
    case "workspace_malformed":
    case "membership_not_found":
    case "membership_removed":
    case "membership_malformed":
    case "owner_integrity_violation":
      return concealed();
    case "insufficient_capability":
      return reportReviewErrorBody(403, "insufficient_capability", "Only members who can organize research can submit it for approval.");
    case "invalid_purpose":
      return reportReviewErrorBody(400, "invalid_purpose", "Choose a purpose: Internal review, Client delivery, Publication review or Other. The note can be at most 280 characters.");
    case "ineligible":
      return reportReviewErrorBody(409, `ineligible_${failure.ineligible}`, REPORT_REVIEW_INELIGIBLE_MESSAGES[failure.ineligible]);
    case "active_panel":
      return reportReviewErrorBody(409, "active_panel", "This research has an open review panel.");
    case "not_decided":
      return reportReviewErrorBody(409, "not_decided", "The current review cycle has no decision yet, so it can't be resubmitted.");
    case "cycle_conflict":
      return reportReviewErrorBody(409, "cycle_conflict", "This review changed since you last viewed it. Refresh and try again.");
    case "content_unfingerprintable":
      return reportReviewErrorBody(409, "content_unfingerprintable", "This research can't be submitted for approval: its saved content could not be recorded exactly for review.");
    case "panel_unreadable":
    case "record_malformed":
    case "firestore_unavailable":
    case "write_failed":
    default: {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}

export async function readJsonObject(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.json();
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
