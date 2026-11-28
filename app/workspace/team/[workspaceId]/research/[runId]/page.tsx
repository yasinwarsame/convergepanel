/**
 * Team Research Detail — Unfiled —
 * `GET /workspace/team/{workspaceId}/research/{runId}`.
 *
 * TEAM-RESEARCH-PARITY-R3 — the durable detail address for canonical Unfiled
 * Team research (a Team run whose `projectId` is `null`). Before R3 such a run
 * had no detail address at all.
 *
 * LAYER 1 gate: identity → Team Workspace access (`lookup_failed` throws, every
 * other denial is a concealed 404) → Team Workspace type → `research.read`.
 * There is no Project on this address, so no Project lookup.
 *
 * `TeamResearchDetailShell` then reads `GET /api/workspaces/{W}/runs/{runId}`
 * WITHOUT `projectId` and renders the result body only when the authorized
 * response says `team.projectId === null`. That check is ROUTE CONTAINMENT,
 * not authorization: a Project-bound run is never painted on this address; its
 * canonical address stays the Project route.
 *
 * ZCA L-4: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie or
 * workspace data; it names the page kind and passes only URL params (and identity-free values). The
 * gate above now runs, unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access;
 * every denial the same 404) and `TeamWorkspacePage` (the required capabilities → the same 404).
 */

import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";

export const dynamic = "force-dynamic";

export default function TeamUnfiledResearchDetailPage({ params }: { params: { workspaceId: string; runId: string } }) {
  return (
    <TeamWorkspacePage kind="researchDetail" workspaceId={params.workspaceId} runId={params.runId} />
  );
}
