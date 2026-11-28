/**
 * Team Videos — `GET /workspace/team/{workspaceId}/videos`.
 *
 * TEAM-VERIFICATION-PARITY-R5-I2 — the canonical Workspace-wide Video
 * discovery surface, and the parent every Unfiled Video detail address points
 * back to. R5-I1 shipped the list and detail read contracts (and their two
 * Production indexes); this page is what finally makes them reachable.
 *
 * LAYER 1 gate: identity → Team Workspace access (`lookup_failed` throws, every
 * other denial is a concealed 404) → Team Workspace type → `research.read`, the
 * same capability the R5-I1 list endpoints require. There is no Project on this
 * address, so no Project lookup.
 *
 * Only the single `audit.read` presentation hint crosses to the client; the
 * capability set itself never does, and no authorization decision is delegated
 * to the browser. I2 is read-only, so no create hint is passed at all.
 *
 * ZCA L-4: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie or
 * workspace data; it names the page kind and passes only URL params (and identity-free values). The
 * gate above now runs, unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access;
 * every denial the same 404) and `TeamWorkspacePage` (the required capabilities → the same 404).
 */

import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";

export const dynamic = "force-dynamic";

export default function TeamWorkspaceVideosPage({ params }: { params: { workspaceId: string } }) {
  return (
    <TeamWorkspacePage kind="videos" workspaceId={params.workspaceId} />
  );
}
