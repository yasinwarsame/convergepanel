/**
 * Order B, Stage B2 — POST /api/workspaces/{W}/runs/{R}/report-review/decision
 * Body exactly `{ decision: { status, comment?, conditions? }, expectedCycle, expectedUpdatedAt }`.
 * Dark unless report review is activated for this Workspace (isReportReviewEnabledForWorkspace: switch + single-workspace allow-list), plus Approval Workflow admission and Workspace membership; otherwise the concealed 404.
 * Every "not authorized" sub-reason collapses to the same external 403 as the governed decision route.
 */
import { NextRequest, NextResponse } from "next/server";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { REPORT_REVIEW_DISCLAIMER } from "@/lib/governance/reportReview";
import { teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { concealed, readJsonObject, reportReviewCaller, reportReviewErrorBody } from "@/lib/workspaces/reportReviewRouteSupport";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await reportReviewCaller(req, "/api/workspaces/[workspaceId]/runs/[runId]/report-review/decision", params.workspaceId);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const body = await readJsonObject(req);
  if (!body || !Object.keys(body).every((k) => k === "decision" || k === "expectedCycle" || k === "expectedUpdatedAt")) {
    return reportReviewErrorBody(400, "bad_request", "Body must be exactly { decision, expectedCycle, expectedUpdatedAt }.");
  }
  const { expectedCycle, expectedUpdatedAt } = body;
  if (typeof expectedCycle !== "number" || !Number.isInteger(expectedCycle) || expectedCycle < 1) return reportReviewErrorBody(400, "bad_request", "expectedCycle must be a positive whole number.");
  if (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt.length === 0) return reportReviewErrorBody(400, "bad_request", "expectedUpdatedAt is required.");

  const r = await decideReportReview({ uid: uidOrRes, workspaceId: params.workspaceId, runId: params.runId, decision: body.decision, expectedCycle, expectedUpdatedAt });
  if (r.ok) return NextResponse.json({ ok: true, replayed: r.replayed, reportReview: r.record, disclaimer: REPORT_REVIEW_DISCLAIMER });
  switch (r.reason) {
    case "invalid_decision":
      return reportReviewErrorBody(400, "invalid_decision", "Choose approved, approved with conditions, changes requested or rejected. Comments are limited to 2,000 characters; up to 10 conditions of 500 characters.");
    case "conditions_required":
      return reportReviewErrorBody(400, "conditions_required", "Approving with conditions requires at least one condition.");
    case "cycle_conflict":
    case "stale_expected_updated_at":
    case "decision_conflict":
      return reportReviewErrorBody(409, r.reason, "This review changed since you last viewed it. Refresh and try again.");
    case "active_panel":
      return reportReviewErrorBody(409, "active_panel", "This research has an open review panel.");
    case "not_authorized":
    case "insufficient_capability": {
      const { status, body: b } = teamRunInsufficientCapabilityResponse();
      return NextResponse.json(b, { status });
    }
    case "panel_unreadable":
    case "record_malformed":
    case "integrity_violation":
    case "firestore_unavailable":
    case "write_failed": {
      const { status, body: b } = internalErrorResponse();
      return NextResponse.json(b, { status });
    }
    default:
      return concealed();
  }
}
