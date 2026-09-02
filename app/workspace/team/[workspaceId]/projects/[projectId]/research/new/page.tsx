/**
 * Team Project Research Composer, Phase 12A.3 —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/research/new`.
 * Server-gated identically to the Team Project detail page (same
 * `resolveWorkspaceAccess()` + direct `getProject()` + explicit
 * cross-Workspace containment check — PHASE 12A.2's already-reviewed
 * pattern, reused verbatim, not redefined), PLUS the two capabilities the
 * underlying `createTeamWorkspaceRun()` transaction itself actually
 * requires for a Project-bound run (`research.create` always,
 * `research.organize` additionally whenever `projectId` is non-null — see
 * `lib/firestore/teamWorkspaceRuns.ts`), PLUS a Project-status check: an
 * archived Project cannot accept new runs (the same backend rejects it
 * with `project_archived`), so this route never renders an enabled
 * composer for one.
 *
 * A caller lacking either research capability, or targeting an archived
 * Project, gets the same concealed `notFound()` as a caller lacking
 * `projects.read` entirely — this is a dedicated create-only surface with
 * no meaningful read-only view to fall back to, so there is no distinct
 * "you don't have permission" state to design; the Project detail page's
 * own "Start Research" button is what conditionally links here in the
 * first place (Section H containment discipline, matched exactly).
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { getProject } from "@/lib/firestore/projects";
import TeamResearchComposerShell from "@/components/workspace/projects/TeamResearchComposerShell";

export const dynamic = "force-dynamic";

export default async function TeamProjectResearchComposerPage({ params }: { params: { workspaceId: string; projectId: string } }) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId: params.workspaceId });
  if (!access.granted || access.workspaceType !== "team") {
    notFound();
  }
  if (!access.capabilities.includes("projects.read")) {
    notFound();
  }
  // The capabilities `createTeamWorkspaceRun()` itself requires for a
  // Project-bound run — never rendering an actionable composer a caller's
  // own submission would just be rejected for.
  if (!access.capabilities.includes("research.create") || !access.capabilities.includes("research.organize")) {
    notFound();
  }

  const result = await getProject(params.projectId);
  if (result.status !== "found") {
    notFound();
  }
  // Cross-Workspace containment — concealed identically to "doesn't exist",
  // matching the Project detail page's own established policy exactly.
  if (result.project.workspaceId !== params.workspaceId) {
    notFound();
  }
  // An archived Project can never accept a new run — the backend itself
  // would reject this with `project_archived`; never render an enabled
  // composer for a Project that can only fail on submit.
  if (result.project.status !== "active") {
    notFound();
  }

  return (
    <TeamResearchComposerShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      canReadAudit={access.capabilities.includes("audit.read")}
      project={{ id: result.project.id, name: result.project.name }}
    />
  );
}
