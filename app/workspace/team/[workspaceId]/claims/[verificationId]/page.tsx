/**
 * Team Claim Detail — Unfiled —
 * `GET /workspace/team/{workspaceId}/claims/{verificationId}`.
 *
 * TEAM-VERIFICATION-PARITY-R4-I1 — the durable detail address for a canonical
 * Unfiled Team Claim verification (a Team Claim whose `projectId` is `null`).
 * Before I1 no Team Claim had a detail address at all: R0–R3 shipped the
 * containment, the shared presentation boundary and the read contracts, but
 * nothing in the UI consumed them.
 *
 * LAYER 1 gate: identity → Team Workspace access (`lookup_failed` throws, every
 * other denial is a concealed 404) → Team Workspace type → `research.read`.
 * There is no Project on this address, so no Project lookup.
 *
 * `TeamClaimDetailShell` then reads
 * `GET /api/workspaces/{W}/verifications/{verificationId}` WITHOUT `projectId`
 * and renders the result body only when the authorized response says
 * `team.projectId === null`. That check is ROUTE CONTAINMENT, not
 * authorization: a Project-filed Claim is never painted on this address; its
 * canonical address stays the Project route.
 *
 * ZCA L-4: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie or
 * workspace data; it names the page kind and passes only URL params (and identity-free values). The
 * gate above now runs, unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access;
 * every denial the same 404) and `TeamWorkspacePage` (the required capabilities → the same 404).
 */

import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";

export const dynamic = "force-dynamic";

export default function TeamUnfiledClaimDetailPage({ params }: { params: { workspaceId: string; verificationId: string } }) {
  return (
    <TeamWorkspacePage kind="claimDetail" workspaceId={params.workspaceId} verificationId={params.verificationId} />
  );
}
