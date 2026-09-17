/**
 * New Team Claim — Unfiled — `GET /workspace/team/{workspaceId}/claims/new`.
 *
 * TEAM-VERIFICATION-PARITY-R4-I3 — the creation address for an Unfiled Team
 * Claim. The route IS the scope: this page can only ever produce a Claim with
 * no Project, and the composer it renders has no Project picker.
 *
 * LAYER 1 gate: identity → Team Workspace access (`lookup_failed` throws, every
 * other denial is a concealed 404) → Team Workspace type → `research.create`.
 *
 * `research.create` is the capability the POST's own Gate 1 and Gate 2 both
 * require, so this page admits exactly the members the server would. It
 * deliberately does NOT require `research.organize` — that is only needed to
 * file a Claim into a Project, which this address never does — and it does not
 * add a second read-side check merely because the result will later be read:
 * every role holding `research.create` already holds `research.read`.
 *
 * Authorization is never derived from a creator, an artifact owner or a role
 * string, and the capability set itself never crosses to the client.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import TeamClaimComposerShell from "@/components/workspace/claims/TeamClaimComposerShell";

export const dynamic = "force-dynamic";

export default async function TeamUnfiledClaimCreatePage({ params }: { params: { workspaceId: string } }) {
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
  if (!access.capabilities.includes("research.create")) {
    notFound();
  }

  return (
    <TeamClaimComposerShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      showAudit={access.capabilities.includes("audit.read")}
      project={null}
    />
  );
}
