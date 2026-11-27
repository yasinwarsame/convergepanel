/**
 * ZCA L-6 — `GET /api/user/workspace-reviews-target?workspace=<id>`: the decision the former
 * `/workspace/reviews` Server Component made on the cookie's identity, now on the bearer, in the same
 * order (see that page's doc comment for the multi-Workspace model):
 *
 *   identity → Approval Workflow admission (per uid; not admitted → 404)
 *     → Team Workspace cardinality (`resolveViewerTeamWorkspaceSelection`; none / lookup_failed → 404)
 *     → explicit `?workspace=` (any cardinality) or the single Workspace → `{ mode: "queue", … }` after
 *       `resolveTeamRunWorkspaceAccess` + research.read AND reviews.read (any denial → 404)
 *     → several Workspaces and no `?workspace=` → `{ mode: "chooser" }` (no Workspace is resolved).
 *
 * Every ineligible case answers the IDENTICAL 404, exactly like the page's `notFound()`. The queue answer
 * carries only what the page passed to `WorkspaceReviewQueueShell`. Private, no-store.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { resolveViewerTeamWorkspaceSelection } from "@/lib/workspaces/resolveViewerTeamWorkspaceSelection";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET /api/user/workspace-reviews-target";
const NO_STORE = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });
const NOT_FOUND = () => json({ ok: false, errorCode: "not_found" }, 404);

export async function GET(request: NextRequest) {
  const identity = await resolveRequestIdentity(request);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: ROUTE, method: "GET", failureCategory: identity.reason });
    if (identity.reason === "auth_unavailable") {
      return json({ ok: false, errorCode: "auth_unavailable", message: "Authentication is temporarily unavailable." }, 503);
    }
    return json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, 401);
  }
  const uid = identity.uid;
  if (!resolveApprovalWorkflowAdmission({ uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS }).admitted) return NOT_FOUND();

  const raw = request.nextUrl.searchParams.get("workspace");
  const explicitWorkspaceId = typeof raw === "string" && raw.length > 0 ? raw : null;
  const selection = await resolveViewerTeamWorkspaceSelection(uid);
  if (selection.kind === "none" || selection.kind === "lookup_failed") return NOT_FOUND();

  let targetWorkspaceId: string;
  if (explicitWorkspaceId) targetWorkspaceId = explicitWorkspaceId;
  else if (selection.kind === "single") targetWorkspaceId = selection.workspaceId;
  else return json({ ok: true, mode: "chooser" }, 200);

  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId: targetWorkspaceId });
  if (!access.granted) return NOT_FOUND();
  if (!access.capabilities.includes("research.read") || !access.capabilities.includes("reviews.read")) return NOT_FOUND();
  return json({ ok: true, mode: "queue", workspaceId: targetWorkspaceId, workspaceName: access.workspace.name, hasMultipleWorkspaces: selection.kind === "multiple" }, 200);
}
