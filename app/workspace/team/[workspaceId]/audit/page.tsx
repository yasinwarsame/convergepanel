/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — `GET /workspace/team/{workspaceId}/audit`,
 * server-gated. Structural mirror of the Members page: eligibility settled
 * server-side via `resolveWorkspaceAccess()` + `audit.read` BEFORE any UI
 * renders, never a client-side flash-then-hide. This page's own gate is
 * UX only — the audit-events API independently re-authorizes every request.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import WorkspaceAuditLogShell from "@/components/workspace/WorkspaceAuditLogShell";

export const dynamic = "force-dynamic";

export default async function WorkspaceAuditLogPage({ params }: { params: { workspaceId: string } }) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId: params.workspaceId });
  if (!access.granted || access.workspaceType !== "team") {
    notFound();
  }
  if (!access.capabilities.includes("audit.read")) {
    notFound();
  }

  return <WorkspaceAuditLogShell workspaceId={params.workspaceId} workspaceName={access.workspace.name} />;
}
