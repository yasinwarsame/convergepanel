/**
 * Team Video Detail —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/videos/{verificationId}`.
 *
 * TEAM-VERIFICATION-PARITY-R5-I2 — LAYER 1: server route gate + Team chrome
 * context for a Project-filed Team Video verification.
 *
 * Server-gated identically to the sibling Team Claim detail page (same
 * `resolveServerComponentIdentity()` + `resolveWorkspaceAccess()` +
 * `getProject()` + explicit cross-Workspace containment check), plus the
 * capability this page actually needs: `research.read` — the same capability
 * the R5-I1 Video read endpoints require, not `projects.read`, which covers
 * only Project metadata.
 *
 * The Video itself is never read here. `TeamVideoDetailShell` loads it through
 * the canonical R5-I1 endpoint
 * `GET /api/workspaces/{W}/video-verifications/{verificationId}?projectId={P}` —
 * where Video-level Workspace + Project containment is enforced and a mismatch
 * is concealed as absent — and renders it with the shared, presentation-pure
 * `VideoVerificationResultView`.
 *
 * This page never interprets the verification payload, never reads Firestore
 * for the Video, and never calls a Personal verification endpoint.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { getProject } from "@/lib/firestore/projects";
import TeamVideoDetailShell from "@/components/workspace/videos/TeamVideoDetailShell";

export const dynamic = "force-dynamic";

export default async function TeamProjectVideoDetailPage({
  params,
}: {
  params: { workspaceId: string; projectId: string; verificationId: string };
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
  if (!access.capabilities.includes("research.read")) {
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

  return (
    <TeamVideoDetailShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      verificationId={params.verificationId}
      project={{ id: projectResult.project.id, name: projectResult.project.name }}
      showAudit={access.capabilities.includes("audit.read")}
    />
  );
}
