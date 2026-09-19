/**
 * New Team Video — Project-bound —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/videos/new`.
 *
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the creation address for a Video filed in
 * exactly this Project. The route IS the scope: the composer receives the
 * SERVER-RESOLVED Project record and has no picker, so the browser's Project id
 * is never the source of the binding — it is only the address whose Project this
 * gate independently resolves and validates.
 *
 * LAYER 1 gate: identity → Team Workspace access (`lookup_failed` throws, every
 * other denial is a concealed 404) → Team Workspace type → `research.create`
 * (create at all) → `research.organize` (file into a Project — the exact extra
 * capability the POST's Gate 1 and Gate 2 require for a Project-filed create)
 * → `getProject()` (infra failure throws) → Project exists → cross-Workspace
 * containment → Project is `active`.
 *
 * An ARCHIVED Project is a concealed 404 here, not a disabled form: the POST
 * would reject the write, so rendering a composer that cannot succeed — after
 * the browser has already spent time extracting frames — would be a dead end.
 * The Videos already filed in an archived Project remain readable through
 * R5-I2's read-only surfaces.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { getProject } from "@/lib/firestore/projects";
import TeamVideoComposerShell from "@/components/workspace/videos/TeamVideoComposerShell";

export const dynamic = "force-dynamic";

export default async function TeamProjectVideoCreatePage({
  params,
}: {
  params: { workspaceId: string; projectId: string };
}) {
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
  if (!access.capabilities.includes("research.organize")) {
    notFound();
  }

  const projectResult = await getProject(params.projectId);
  if (projectResult.status === "firestore_unavailable" || projectResult.status === "read_failed") {
    throw new Error("Something went wrong while loading this page. Please try again.");
  }
  if (projectResult.status !== "found") {
    notFound();
  }
  // Cross-Workspace containment — concealed identically to "doesn't exist".
  if (projectResult.project.workspaceId !== params.workspaceId) {
    notFound();
  }
  // An archived Project cannot accept a new Video; conceal rather than offer a
  // composer whose submission the server would reject.
  if (projectResult.project.status !== "active") {
    notFound();
  }

  return (
    <TeamVideoComposerShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      showAudit={access.capabilities.includes("audit.read")}
      project={{ id: projectResult.project.id, name: projectResult.project.name }}
    />
  );
}
