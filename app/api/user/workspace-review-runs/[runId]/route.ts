/**
 * ZCA L-3 (D-4 endpoint E-d) — `GET /api/user/workspace-review-runs/[runId]`.
 *
 * The bearer-authorized read behind the neutral shell of `/workspace/reviews/[runId]`. It performs
 * EXACTLY the decision the Server Component used to make on the cookie's identity:
 *   identity → Approval Workflow admission (pure; per uid) → `getWorkspaceRunDetail()`, which
 *   resolves the run's own canonical workspace, revalidates Team Workspace access + `research.read`
 *   and makes the normal-vs-drain admission decision itself.
 *
 * Concealment is preserved: every non-ok result (`not_found` AND `read_failed`) answers the same
 * 404, exactly as the page's `notFound()` did, so the response never reveals whether a run exists.
 * A verifier outage answers 503 `auth_unavailable` (never an allow, never a sign-out); every other
 * identity failure answers 401. Responses are `private, no-store`.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { getWorkspaceRunDetail } from "@/lib/workspaces/workspaceRunDetail";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET /api/user/workspace-review-runs/[runId]";
const NO_STORE = { "Cache-Control": "private, no-store" };

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest, { params }: { params: { runId: string } }) {
  const identity = await resolveRequestIdentity(request);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: ROUTE, method: "GET", failureCategory: identity.reason });
    if (identity.reason === "auth_unavailable") {
      return json({ ok: false, errorCode: "auth_unavailable", message: "Authentication is temporarily unavailable." }, 503);
    }
    return json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, 401);
  }

  const runId = typeof params?.runId === "string" ? params.runId : "";
  if (runId === "") return json({ ok: false, errorCode: "not_found" }, 404);

  const admission = resolveApprovalWorkflowAdmission({
    uid: identity.uid,
    globalEnabled: APPROVAL_WORKFLOW_ENABLED,
    canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS,
  });
  const result = await getWorkspaceRunDetail({ runId, uid: identity.uid, approvalAdmitted: admission.admitted });
  if (result.status !== "ok") return json({ ok: false, errorCode: "not_found" }, 404);
  return json({ ok: true, detail: result.detail }, 200);
}
