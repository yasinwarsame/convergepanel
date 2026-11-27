/**
 * ZCA L-6 — `GET /api/user/workspace-ui-gate?gate=…`: the per-uid rollout gates of the Personal workspace
 * pages, decided on the bearer instead of in their Server Components (D-4 §1.4: canary gates move to
 * the client loader). Each gate makes EXACTLY the decision its page made, with the same functions and
 * inputs; a closed gate answers 404 because the page answered `notFound()`.
 *
 *   personal_workspace  /workspace              resolvePersonalWorkspaceUiMode(uid).enabled
 *   team_workspaces     /workspace/team         resolveTeamWorkspacesMode(uid).enabled
 *   projects            /workspace/projects     resolveProjectsUiEligibility(uid) AND a Personal workspace
 *                                               found for the uid (any other lookup result → 404, as the page did)
 *   signed_in           /workspace/research/x   only an authenticated identity (the page's sole check)
 *
 * An unknown gate answers 404. A verifier outage answers 503; other identity failures 401.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolvePersonalWorkspaceUiMode } from "@/lib/workspaces/workspaceUiRollout";
import { resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";
import { resolveProjectsUiEligibility } from "@/lib/projects/projectsUiEligibility";
import { resolvePersonalWorkspaceForOwner } from "@/lib/workspaces/resolvePersonalWorkspaceForOwner";
import {
  PERSONAL_WORKSPACE_UI_ENABLED,
  PERSONAL_WORKSPACE_UI_CANARY_UIDS,
  TEAM_WORKSPACES_ENABLED,
  TEAM_WORKSPACES_CANARY_UIDS,
  PROJECTS_UI_ENABLED,
  PROJECTS_UI_CANARY_UIDS,
  PROJECTS_ENABLED,
  PROJECTS_CANARY_UIDS,
} from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET /api/user/workspace-ui-gate";
const NO_STORE = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });

const WORKSPACE_UI_GATES = ["personal_workspace", "team_workspaces", "projects", "signed_in"] as const;
type WorkspaceUiGate = (typeof WORKSPACE_UI_GATES)[number];

async function gateOpen(gate: WorkspaceUiGate, uid: string): Promise<boolean> {
  switch (gate) {
    case "personal_workspace":
      return resolvePersonalWorkspaceUiMode({ uid, globalEnabled: PERSONAL_WORKSPACE_UI_ENABLED, canaryUidsRaw: PERSONAL_WORKSPACE_UI_CANARY_UIDS }).enabled;
    case "team_workspaces":
      return resolveTeamWorkspacesMode({ uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS }).enabled;
    case "projects": {
      const eligible = resolveProjectsUiEligibility({
        uid,
        uiGlobalEnabled: PROJECTS_UI_ENABLED,
        uiCanaryUidsRaw: PROJECTS_UI_CANARY_UIDS,
        backendGlobalEnabled: PROJECTS_ENABLED,
        backendCanaryUidsRaw: PROJECTS_CANARY_UIDS,
      });
      if (!eligible) return false;
      return (await resolvePersonalWorkspaceForOwner(uid)).status === "found";
    }
    case "signed_in":
      return true;
  }
}

export async function GET(request: NextRequest) {
  const identity = await resolveRequestIdentity(request);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: ROUTE, method: "GET", failureCategory: identity.reason });
    if (identity.reason === "auth_unavailable") {
      return json({ ok: false, errorCode: "auth_unavailable", message: "Authentication is temporarily unavailable." }, 503);
    }
    return json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, 401);
  }
  const gate = request.nextUrl.searchParams.get("gate");
  if (!(WORKSPACE_UI_GATES as readonly string[]).includes(gate ?? "")) return json({ ok: false, errorCode: "not_found" }, 404);
  if (!(await gateOpen(gate as WorkspaceUiGate, identity.uid))) return json({ ok: false, errorCode: "not_found" }, 404);
  return json({ ok: true }, 200);
}
