/**
 * Team Claims — `GET /workspace/team/{workspaceId}/claims`.
 *
 * TEAM-VERIFICATION-PARITY-R4-I2 — the canonical Workspace-wide Claim
 * discovery surface, and the parent every Unfiled Claim detail address now
 * points back to. R3 shipped the list contracts and R4-I1 shipped the detail
 * destinations; this page is what finally makes them reachable.
 *
 * LAYER 1 gate: identity → Team Workspace access (`lookup_failed` throws, every
 * other denial is a concealed 404) → Team Workspace type → `research.read`, the
 * same capability the R3 list endpoints require. There is no Project on this
 * address, so no Project lookup.
 *
 * Only the single `audit.read` presentation hint crosses to the client; the
 * capability set itself never does, and no authorization decision is delegated
 * to the browser.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import TeamWorkspaceClaimsShell from "@/components/workspace/claims/TeamWorkspaceClaimsShell";

export const dynamic = "force-dynamic";

export default async function TeamWorkspaceClaimsPage({ params }: { params: { workspaceId: string } }) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId: params.workspaceId });
  if (!access.granted && access.reason === "lookup_failed") {
    // A transient infra failure must never be indistinguishable from a genuine
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
    <TeamWorkspaceClaimsShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      showAudit={access.capabilities.includes("audit.read")}
      // R4-I3 — narrow presentation hint for the "New Claim" entry point. The
      // POST re-derives `research.create` at both gates; this only decides
      // whether a link that would otherwise 404 is offered.
      canCreateClaim={access.capabilities.includes("research.create")}
    />
  );
}
