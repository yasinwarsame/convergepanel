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
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import TeamWorkspaceVideosShell from "@/components/workspace/videos/TeamWorkspaceVideosShell";

export const dynamic = "force-dynamic";

export default async function TeamWorkspaceVideosPage({ params }: { params: { workspaceId: string } }) {
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
    <TeamWorkspaceVideosShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      showAudit={access.capabilities.includes("audit.read")}
      /* R5-I3-B — the Unfiled create address needs only `research.create`; filing into a Project is a different address with a stricter gate. Presentation only. */
      canCreateVideo={access.capabilities.includes("research.create")}
    />
  );
}
