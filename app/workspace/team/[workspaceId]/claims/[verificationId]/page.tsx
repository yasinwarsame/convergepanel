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
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import TeamClaimDetailShell from "@/components/workspace/projects/TeamClaimDetailShell";

export const dynamic = "force-dynamic";

export default async function TeamUnfiledClaimDetailPage({ params }: { params: { workspaceId: string; verificationId: string } }) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId: params.workspaceId });
  if (!access.granted && access.reason === "lookup_failed") {
    // Distinct from every concealed-denial case below — a transient
    // Firestore/infra failure must never be indistinguishable from a genuine
    // "doesn't exist / not yours". Caught by the app's global `app/error.tsx`.
    throw new Error("Something went wrong while loading this page. Please try again.");
  }
  if (!access.granted || access.workspaceType !== "team") {
    notFound();
  }
  if (!access.capabilities.includes("research.read")) {
    notFound();
  }

  return (
    <TeamClaimDetailShell
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
