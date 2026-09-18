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
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import TeamResearchDetailShell from "@/components/workspace/projects/TeamResearchDetailShell";

export const dynamic = "force-dynamic";

export default async function TeamUnfiledResearchDetailPage({ params }: { params: { workspaceId: string; runId: string } }) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId: params.workspaceId });
  if (!access.granted && access.reason === "lookup_failed") {
    throw new Error("Something went wrong while loading this page. Please try again.");
  }
  if (!access.granted || access.workspaceType !== "team") {
    notFound();
  }
  if (!access.capabilities.includes("research.read")) {
    notFound();
  }

  return (
    <TeamResearchDetailShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      runId={params.runId}
      project={null}
      showAudit={access.capabilities.includes("audit.read")}
      // R4-I4 — presentation hint for the per-finding "Verify this claim"
      // action. Viewing research still requires only `research.read`; this
      // never gates the page. The POST re-resolves and re-authorizes the
      // source run's own Project before executing anything.
      canVerifyClaim={access.capabilities.includes("research.create")}
    />
  );
}
