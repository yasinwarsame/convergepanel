/**
 * Team Workspace Self-Service Onboarding — `GET /workspace/team/{workspaceId}/members`,
 * server-gated. Eligibility is settled BEFORE any Members UI renders —
 * never a client-side flash-then-hide, matching `/workspace/reviews`'s
 * own established gating pattern. Uses the same authoritative
 * `resolveWorkspaceAccess()` gate the member-list API itself uses — this
 * page's own gate is UX only; the API independently re-authorizes every
 * request.
 *
 * ZCA L-4: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie or
 * workspace data; it names the page kind and passes only URL params (and identity-free values). The
 * gate above now runs, unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access;
 * every denial the same 404) and `TeamWorkspacePage` (the required capabilities → the same 404).
 */

import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";

export const dynamic = "force-dynamic";

export default function WorkspaceMembersPage({ params }: { params: { workspaceId: string } }) {
  return (
    <TeamWorkspacePage kind="members" workspaceId={params.workspaceId} />
  );
}
