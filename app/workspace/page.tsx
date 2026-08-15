/**
 * Phase 5C — GET /workspace, server-gated. Eligibility is settled BEFORE
 * any Workspace UI renders — never a client-side flash-then-hide. Every
 * ineligible case (unauthenticated, non-canary, global off) returns the
 * identical `notFound()` — the response gives a non-canary authenticated
 * user no signal distinguishing "logged in but not eligible" from "this
 * route doesn't exist."
 *
 * This gate has zero effect on `GET /api/user/workspace` or
 * `GET /api/user/workspace/runs` — both are independent Route Handlers
 * with their own control flow, unaffected by this page's existence.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolvePersonalWorkspaceUiMode } from "@/lib/workspaces/workspaceUiRollout";
import { PERSONAL_WORKSPACE_UI_ENABLED, PERSONAL_WORKSPACE_UI_CANARY_UIDS } from "@/lib/env";
import WorkspaceShell from "@/components/workspace/WorkspaceShell";

export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const mode = resolvePersonalWorkspaceUiMode({
    uid: identity.uid,
    globalEnabled: PERSONAL_WORKSPACE_UI_ENABLED,
    canaryUidsRaw: PERSONAL_WORKSPACE_UI_CANARY_UIDS,
  });
  if (!mode.enabled) {
    notFound();
  }

  return <WorkspaceShell />;
}
