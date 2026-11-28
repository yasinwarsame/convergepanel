/**
 * Team Workspace Activation Flow, Phase 12A.1 — `GET /workspace/team/{workspaceId}`,
 * the canonical Workspace home page. Server-gated identically to the
 * Members/Audit pages: eligibility settled via `resolveWorkspaceAccess()`
 * BEFORE any UI renders, never a client-side flash-then-hide. This
 * page's own gate is UX only — every API the client shell calls
 * independently re-authorizes every request.
 *
 * ZCA L-4: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie or
 * workspace data; it names the page kind and passes only URL params (and identity-free values). The
 * gate above now runs, unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access;
 * every denial the same 404) and `TeamWorkspacePage` (the required capabilities → the same 404).
 */

import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";

export const dynamic = "force-dynamic";

export default function WorkspaceOverviewPage({ params }: { params: { workspaceId: string } }) {
  return (
    <TeamWorkspacePage kind="overview" workspaceId={params.workspaceId} />
  );
}
