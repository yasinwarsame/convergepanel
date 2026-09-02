/**
 * Team Workspace Activation Flow, Phase 12A.1 — `GET /workspace/team/{workspaceId}`,
 * the canonical Workspace home page. Server-gated identically to the
 * Members/Audit pages: eligibility settled via `resolveWorkspaceAccess()`
 * BEFORE any UI renders, never a client-side flash-then-hide. This
 * page's own gate is UX only — every API the client shell calls
 * independently re-authorizes every request.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import WorkspaceOverviewShell from "@/components/workspace/WorkspaceOverviewShell";

export const dynamic = "force-dynamic";

export default async function WorkspaceOverviewPage({ params }: { params: { workspaceId: string } }) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId: params.workspaceId });
  if (!access.granted || access.workspaceType !== "team") {
    notFound();
  }

  return (
    <WorkspaceOverviewShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      canInvite={access.capabilities.includes("members.invite")}
      canManageInvitations={access.capabilities.includes("members.manage")}
      canCreateProject={access.capabilities.includes("projects.create")}
      canReadAudit={access.capabilities.includes("audit.read")}
    />
  );
}
