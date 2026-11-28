/**
 * Team Research Detail —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/research/{runId}`.
 *
 * TEAM-RESEARCH-PARITY-R3 — LAYER 1: server route gate + Team chrome context.
 *
 * Server-gated identically to the sibling Team Project detail page (same
 * `resolveServerComponentIdentity()` + `resolveWorkspaceAccess()` +
 * `getProject()` + explicit cross-Workspace containment check), plus the
 * capability this page actually needs: `research.read` (reading research
 * content, not `projects.read`, which only covers Project metadata).
 *
 * The persisted research itself is no longer read here. Phase 12A.4 read the
 * run directly with `getTeamWorkspaceRun()` and rendered the limited
 * `TeamResearchResultView`; R3 hands the authorized, Workspace-contained
 * context to `TeamResearchDetailShell`, which loads the run through the
 * canonical R1 endpoint `GET /api/workspaces/{W}/runs/{runId}?projectId={P}` —
 * where run-level Workspace + Project containment is enforced and concealed —
 * and renders the same canonical ordinary / adaptive / legacy-adaptive /
 * persisted-synthesis body the Personal durable report uses.
 *
 * This page never interprets the research payload and never calls the Personal
 * run endpoint.
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

export default function TeamResearchDetailPage({ params }: { params: { workspaceId: string; projectId: string; runId: string } }) {
  return <TeamWorkspacePage kind="projectResearchDetail" workspaceId={params.workspaceId} projectId={params.projectId} runId={params.runId} />;
}
