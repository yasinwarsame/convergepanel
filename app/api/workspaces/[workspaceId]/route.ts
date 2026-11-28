/**
 * ZCA L-4 (D-4 endpoint E-a) — `GET /api/workspaces/[workspaceId]`.
 *
 * The bearer-authorized access read behind every neutral Team Workspace shell. It performs the
 * decision each team page's Server Component used to make on the cookie's identity —
 * `resolveWorkspaceAccess({ uid, workspaceId })` — and returns only what those pages rendered from it:
 * the workspace's id and name, the caller's role and capabilities, and two identity-derived flags.
 *
 * Concealment (unchanged from the pages): every denial — not a member, removed, malformed, a Personal
 * workspace, Team Workspaces not admitted, not found — answers the SAME 404. A transient lookup
 * failure answers 503 (the pages threw to the error boundary; never indistinguishable from "not
 * yours"). A missing capability is decided by the client, which renders the same not-found page, so
 * a member lacking a capability and a non-member see the same thing. Responses are private, no-store.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { isReportReviewEnabledForWorkspace } from "@/lib/workspaces/reportReviewActivation";
import { projectAssignmentUiEnabledFor } from "@/lib/workspaces/projectAssignmentUiAdmission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET /api/workspaces/[workspaceId]";
const NO_STORE = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });
const NOT_FOUND = () => json({ ok: false, errorCode: "not_found" }, 404);

export async function GET(request: NextRequest, { params }: { params: { workspaceId: string } }) {
  const identity = await resolveRequestIdentity(request);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: ROUTE, method: "GET", failureCategory: identity.reason });
    if (identity.reason === "auth_unavailable") {
      return json({ ok: false, errorCode: "auth_unavailable", message: "Authentication is temporarily unavailable." }, 503);
    }
    return json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, 401);
  }
  const workspaceId = typeof params?.workspaceId === "string" ? params.workspaceId : "";
  if (workspaceId === "") return NOT_FOUND();

  const access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId });
  if (!access.granted && access.reason === "lookup_failed") {
    return json({ ok: false, errorCode: "unavailable", message: "Something went wrong. Please try again." }, 503);
  }
  if (!access.granted || access.workspaceType !== "team") return NOT_FOUND();

  return json(
    {
      ok: true,
      workspace: { id: access.workspace.id, name: access.workspace.name },
      role: access.membership.role,
      capabilities: [...access.capabilities],
      reportReviewEnabled: isReportReviewEnabledForWorkspace(access.workspace.id),
      projectAssignmentUiEnabled: projectAssignmentUiEnabledFor(identity.uid),
    },
    200,
  );
}
