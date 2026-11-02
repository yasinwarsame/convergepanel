/**
 * Order B, Stage B1 — POST /api/workspaces/{W}/runs/{R}/report-review/resubmit
 * D-B6: after a decided cycle, archive it write-once and start a new cycle. Body exactly `{ purpose, expectedCycle }`.
 * Dark: REPORT_REVIEW_ENABLED (compile-time false, lib/workspaces/reportReviewRollout.ts) and Approval Workflow admission; otherwise the concealed 404.
 */
import { NextRequest, NextResponse } from "next/server";
import { resubmitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { REPORT_REVIEW_DISCLAIMER } from "@/lib/governance/reportReview";
import { readJsonObject, reportReviewCaller, reportReviewErrorBody, reportReviewFailureResponse } from "@/lib/workspaces/reportReviewRouteSupport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await reportReviewCaller(req, "/api/workspaces/[workspaceId]/runs/[runId]/report-review/resubmit");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const body = await readJsonObject(req);
  if (!body || !Object.keys(body).every((k) => k === "purpose" || k === "expectedCycle")) return reportReviewErrorBody(400, "bad_request", "Body must be exactly { purpose, expectedCycle }.");

  const expectedCycle = body.expectedCycle;
  if (typeof expectedCycle !== "number" || !Number.isInteger(expectedCycle) || expectedCycle < 1) return reportReviewErrorBody(400, "bad_request", "expectedCycle must be a positive whole number.");

  const result = await resubmitReportReview({ uid: uidOrRes, workspaceId: params.workspaceId, runId: params.runId, purpose: body.purpose, expectedCycle });
  if (!result.ok) return reportReviewFailureResponse(result);
  return NextResponse.json({ ok: true, reportReview: result.record, archivedCycle: result.archivedCycle, disclaimer: REPORT_REVIEW_DISCLAIMER });
}
