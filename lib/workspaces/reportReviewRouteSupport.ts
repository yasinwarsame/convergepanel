/**
 * Order B, Stage B1 — shared HTTP mapping for the two Report Review routes. Concealment policy matches the existing
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
import { teamRunWorkspaceNotFoundConcealedResponse } from "./teamRunAccessResponse";
import { internalErrorResponse } from "./teamWorkspaceErrorResponse";
import type { ReportReviewMutationFailure } from "./reportReviewMutations";
import { REPORT_REVIEW_ENABLED } from "./reportReviewRollout";
import { REPORT_REVIEW_INELIGIBLE_EXPLANATIONS } from "@/lib/governance/reportReviewCopy";

export function reportReviewErrorBody(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export function concealed(): NextResponse {
  const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
  return NextResponse.json(body, { status });
}

export async function reportReviewCaller(req: NextRequest, route: string, method: "GET" | "POST" = "POST"): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route, method, failureCategory: identity.reason });
    if (identity.reason === "missing_credentials") return reportReviewErrorBody(401, "unauthorized", "Please sign in.");
    return reportReviewErrorBody(401, "auth_error", "Authentication failed.");
  }
  // Report review is review machinery: it also requires Approval Workflow admission (concealed when not admitted).
  // Dark: concealed before anything else about the request (body shape included) is evaluated.
  if (!REPORT_REVIEW_ENABLED) return concealed();
  const admission = resolveApprovalWorkflowAdmission({ uid: identity.uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (!admission.admitted) return concealed();
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
