/** Order B, Stage B2 — GET handler body for the report-review context (kept here so the route file only wires HTTP). */
import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getReportReviewContext } from "./reportReviewContext";
import { concealed, reportReviewCaller } from "./reportReviewRouteSupport";
import { internalErrorResponse } from "./teamWorkspaceErrorResponse";

export async function handleReportReviewContextGet(req: NextRequest, params: { workspaceId: string; runId: string }) {
  const uidOrRes = await reportReviewCaller(req, "/api/workspaces/[workspaceId]/runs/[runId]/report-review", "GET");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const r = await getReportReviewContext({ uid: uidOrRes, workspaceId: params.workspaceId, runId: params.runId });
  if (r.status === "ok") {
    const { status: _s, ...rest } = r;
    void _s;
    return NextResponse.json({ ok: true, state: "submitted", ...rest });
  }
  // B3: not yet submitted — whether it can be, and why not (the reader is already authorized to read this run).
  if (r.status === "not_submitted") {
    const { status: _s, ...rest } = r;
    void _s;
    return NextResponse.json({ ok: true, state: "not_submitted", ...rest });
  }
  if (r.status === "not_found") return concealed();
  const { status, body } = internalErrorResponse();
  return NextResponse.json(body, { status });
}
