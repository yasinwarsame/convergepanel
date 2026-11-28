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
 *
 * ZCA L-5: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie,
 * workspace or Project data; it names the page kind and passes only URL params. The gate above runs,
 * unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access), `TeamWorkspacePage`
 * (the required capabilities), `GET /api/workspaces/[workspaceId]/projects/[projectId]` (the Project,
 * looked up only after that gate; another Workspace's Project → the same 404) and, for creation pages,
 * the active-status rule — every denial the same 404.
 */

import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";

export const dynamic = "force-dynamic";

export default function TeamProjectResearchComposerPage({ params }: { params: { workspaceId: string; projectId: string } }) {
  return <TeamWorkspacePage kind="projectResearchNew" workspaceId={params.workspaceId} projectId={params.projectId} />;
}
