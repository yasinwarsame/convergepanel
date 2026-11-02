/**
 * Order B, Stage B1 — POST /api/workspaces/{W}/runs/{R}/report-review
 * Explicit submission of non-governed Team research for human approval (D-B2). Body exactly `{ purpose: { code, note? } }`.
 * Dark: REPORT_REVIEW_ENABLED (compile-time false, lib/workspaces/reportReviewRollout.ts) and Approval Workflow admission; otherwise the concealed 404.
 * See lib/workspaces/reportReviewMutations.ts for the transaction and docs/workspaces/approval-b-report-review-design.md.
 */
import { NextRequest, NextResponse } from "next/server";
import { submitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { REPORT_REVIEW_DISCLAIMER } from "@/lib/governance/reportReview";
import { readJsonObject, reportReviewCaller, reportReviewErrorBody, reportReviewFailureResponse } from "@/lib/workspaces/reportReviewRouteSupport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await reportReviewCaller(req, "/api/workspaces/[workspaceId]/runs/[runId]/report-review");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const body = await readJsonObject(req);
  if (!body || !Object.keys(body).every((k) => k === "purpose")) return reportReviewErrorBody(400, "bad_request", "Body must be exactly { purpose }.");

  const result = await submitReportReview({ uid: uidOrRes, workspaceId: params.workspaceId, runId: params.runId, purpose: body.purpose });
  if (!result.ok) return reportReviewFailureResponse(result);
  return NextResponse.json({ ok: true, created: result.created, reportReview: result.record, disclaimer: REPORT_REVIEW_DISCLAIMER }, { status: result.created ? 201 : 200 });
}
