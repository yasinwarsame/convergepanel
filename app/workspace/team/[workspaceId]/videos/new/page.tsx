/**
 * New Team Video — Unfiled — `GET /workspace/team/{workspaceId}/videos/new`.
 *
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the creation address for an Unfiled Team
 * Video. The route IS the scope: this page can only ever produce a Video with
 * no Project, and the composer it renders has no Project picker.
 *
 * LAYER 1 gate: identity → Team Workspace access (`lookup_failed` throws, every
 * other denial is a concealed 404) → Team Workspace type → `research.create`.
 *
 * `research.create` is the capability the POST's own Gate 1 and Gate 2 both
 * require, so this page admits exactly the members the server would. It
 * deliberately does NOT require `research.organize` — that is only needed to
 * file a Video into a Project, which this address never does — and it does not
 * add a second read-side check merely because the result will later be read:
 * every role holding `research.create` already holds `research.read`.
 *
 * Authorization is never derived from a creator, an artifact owner or a role
 * string, and the capability set itself never crosses to the client. UI
 * visibility is not the boundary: the POST re-authorizes independently.
 *
 * ZCA L-4: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie or
 * workspace data; it names the page kind and passes only URL params (and identity-free values). The
 * gate above now runs, unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access;
 * every denial the same 404) and `TeamWorkspacePage` (the required capabilities → the same 404).
 */

import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";

export const dynamic = "force-dynamic";

export default function TeamUnfiledVideoCreatePage({ params }: { params: { workspaceId: string } }) {
  return (
    <TeamWorkspacePage kind="videoNew" workspaceId={params.workspaceId} />
  );
}
