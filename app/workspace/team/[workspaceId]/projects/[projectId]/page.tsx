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

export default function TeamProjectDetailPage({ params }: { params: { workspaceId: string; projectId: string } }) {
  return <TeamWorkspacePage kind="projectDetail" workspaceId={params.workspaceId} projectId={params.projectId} />;
}
