/**
 * Team Projects UI, Phase 12A.2 — `GET /workspace/team/{workspaceId}/projects`,
 * server-gated identically to Overview/Members/Audit: eligibility settled
 * via `resolveWorkspaceAccess()` BEFORE any UI renders. Gated on
 * `projects.read` (every valid Team role holds this per the capability
 * matrix — Owner/Admin/Member/Reviewer/Viewer all do — so this is a
 * defensive, future-proofing check, not a role restriction in practice).
 * This page's own gate is UX only — the Projects list/create APIs
 * independently re-authorize every request.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import TeamProjectsShell from "@/components/workspace/projects/TeamProjectsShell";

export const dynamic = "force-dynamic";

export default async function TeamProjectsPage({ params }: { params: { workspaceId: string } }) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId: params.workspaceId });
  if (!access.granted && access.reason === "lookup_failed") {
    // Distinct from every concealed-denial case below — a transient
    // Firestore/infra failure must never be indistinguishable from a
    // genuine "doesn't exist / not yours". See
    // `app/workspace/projects/[projectId]/page.tsx`'s own doc comment for
    // the established precedent this mirrors. Caught by the app's
    // existing global `app/error.tsx` boundary.
    throw new Error("Something went wrong while loading this page. Please try again.");
  }
  if (!access.granted || access.workspaceType !== "team") {
    notFound();
  }
  if (!access.capabilities.includes("projects.read")) {
    notFound();
  }

  return (
    <TeamProjectsShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      canCreateProject={access.capabilities.includes("projects.create")}
      canManageProjects={access.capabilities.includes("projects.manage")}
      canReadAudit={access.capabilities.includes("audit.read")}
    />
  );
}
