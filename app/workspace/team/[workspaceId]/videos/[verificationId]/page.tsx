/**
 * Team Video Detail — Unfiled —
 * `GET /workspace/team/{workspaceId}/videos/{verificationId}`.
 *
 * TEAM-VERIFICATION-PARITY-R5-I2 — the durable detail address for a canonical
 * Unfiled Team Video verification (a Team Video whose `projectId` is `null`).
 *
 * LAYER 1 gate: identity → Team Workspace access (`lookup_failed` throws, every
 * other denial is a concealed 404) → Team Workspace type → `research.read`.
 * There is no Project on this address, so no Project lookup.
 *
 * The Video itself is never read here. `TeamVideoDetailShell` reads
 * `GET /api/workspaces/{W}/video-verifications/{verificationId}` WITHOUT
 * `projectId` and renders the result only when the authorized response says
 * `team.projectId === null`. That check is ROUTE CONTAINMENT, not
 * authorization: a Project-filed Video is never painted on this address; its
 * canonical address stays the Project route.
 *
 * ZCA L-4: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie or
 * workspace data; it names the page kind and passes only URL params (and identity-free values). The
 * gate above now runs, unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access;
 * every denial the same 404) and `TeamWorkspacePage` (the required capabilities → the same 404).
 */

import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";

export const dynamic = "force-dynamic";

export default function TeamUnfiledVideoDetailPage({ params }: { params: { workspaceId: string; verificationId: string } }) {
  return (
    <TeamWorkspacePage kind="videoDetail" workspaceId={params.workspaceId} verificationId={params.verificationId} />
  );
}
