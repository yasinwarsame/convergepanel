/**
 * Team Projects UI, Phase 12A.2 — `GET /workspace/team/{workspaceId}/projects`,
 * server-gated identically to Overview/Members/Audit: eligibility settled
 * via `resolveWorkspaceAccess()` BEFORE any UI renders. Gated on
 * `projects.read` (every valid Team role holds this per the capability
 * matrix — Owner/Admin/Member/Reviewer/Viewer all do — so this is a
 * defensive, future-proofing check, not a role restriction in practice).
 * This page's own gate is UX only — the Projects list/create APIs
 * independently re-authorize every request.
 *
 * ZCA L-4: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie or
 * workspace data; it names the page kind and passes only URL params (and identity-free values). The
 * gate above now runs, unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access;
 * every denial the same 404) and `TeamWorkspacePage` (the required capabilities → the same 404).
 */

import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";

export const dynamic = "force-dynamic";

export default function TeamProjectsPage({ params }: { params: { workspaceId: string } }) {
  return (
    <TeamWorkspacePage kind="projects" workspaceId={params.workspaceId} />
  );
}
