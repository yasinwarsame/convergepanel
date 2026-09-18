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
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import TeamVideoDetailShell from "@/components/workspace/videos/TeamVideoDetailShell";

export const dynamic = "force-dynamic";

export default async function TeamUnfiledVideoDetailPage({ params }: { params: { workspaceId: string; verificationId: string } }) {
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
    <TeamVideoDetailShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      verificationId={params.verificationId}
      project={null}
      // Presentation hint from the same server-resolved capability set — not a
      // second authorization decision. The full capability array never reaches
      // the client.
      showAudit={access.capabilities.includes("audit.read")}
    />
  );
}
