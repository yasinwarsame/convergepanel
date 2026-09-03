/**
 * Team Projects UI, Phase 12A.2 — `GET /workspace/team/{workspaceId}/projects/{projectId}`.
 * Server-gated identically to the other Workspace pages, PLUS a direct,
 * server-side `getProject()` read to resolve the Project's own name/status
 * — the same `server-only` function `GET /api/workspaces/{workspaceId}/projects/{projectId}/runs`
 * already uses internally (PHASE 12A.2's own source inventory confirmed
 * no GET-single-project-by-id HTTP route exists; none is added here —
 * this Server Component reuses the existing internal read function
 * directly, exactly like `resolveWorkspaceAccess()` itself does its own
 * Firestore reads inline rather than calling a REST endpoint).
 *
 * Cross-Workspace containment is enforced explicitly and unconditionally:
 * `project.workspaceId !== params.workspaceId` is treated identically to
 * "Project not found" — never revealing that a Project with this id
 * exists in a different Workspace, mirroring the project-scoped runs
 * route's own concealment policy.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { getProject } from "@/lib/firestore/projects";
import TeamProjectDetailShell from "@/components/workspace/projects/TeamProjectDetailShell";

export const dynamic = "force-dynamic";

export default async function TeamProjectDetailPage({ params }: { params: { workspaceId: string; projectId: string } }) {
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

  const result = await getProject(params.projectId);
  if (result.status === "firestore_unavailable" || result.status === "read_failed") {
    // Same transient-vs-genuine distinction as the Workspace access check
    // above — a `.get()` failure is not evidence the Project doesn't exist.
    throw new Error("Something went wrong while loading this page. Please try again.");
  }
  if (result.status !== "found") {
    notFound();
  }
  // Cross-Workspace containment — concealed identically to "doesn't exist".
  if (result.project.workspaceId !== params.workspaceId) {
    notFound();
  }

  return (
    <TeamProjectDetailShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      canReadAudit={access.capabilities.includes("audit.read")}
      canStartResearch={access.capabilities.includes("research.create") && access.capabilities.includes("research.organize")}
      project={{ id: result.project.id, name: result.project.name, status: result.project.status }}
    />
  );
}
