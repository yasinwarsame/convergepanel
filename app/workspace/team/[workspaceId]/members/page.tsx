/**
 * Team Workspace Self-Service Onboarding — `GET /workspace/team/{workspaceId}/members`,
 * server-gated. Eligibility is settled BEFORE any Members UI renders —
 * never a client-side flash-then-hide, matching `/workspace/reviews`'s
 * own established gating pattern. Uses the same authoritative
 * `resolveWorkspaceAccess()` gate the member-list API itself uses — this
 * page's own gate is UX only; the API independently re-authorizes every
 * request.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import WorkspaceMembersShell from "@/components/workspace/WorkspaceMembersShell";

export const dynamic = "force-dynamic";

export default async function WorkspaceMembersPage({ params }: { params: { workspaceId: string } }) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId: params.workspaceId });
  if (!access.granted || access.workspaceType !== "team") {
    notFound();
  }
  if (!access.capabilities.includes("members.read")) {
    notFound();
  }

  return (
    <WorkspaceMembersShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      callerRole={access.membership.role}
      canInvite={access.capabilities.includes("members.invite")}
      canManageInvitations={access.capabilities.includes("members.manage")}
      canReadAudit={access.capabilities.includes("audit.read")}
    />
  );
}
