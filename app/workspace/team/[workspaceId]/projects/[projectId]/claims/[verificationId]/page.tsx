/**
 * Team Claim Detail —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/claims/{verificationId}`.
 *
 * TEAM-VERIFICATION-PARITY-R4-I1 — LAYER 1: server route gate + Team chrome
 * context for a Project-filed Team Claim verification.
 *
 * Server-gated identically to the sibling Team research detail page (same
 * `resolveServerComponentIdentity()` + `resolveWorkspaceAccess()` +
 * `getProject()` + explicit cross-Workspace containment check), plus the
 * capability this page actually needs: `research.read` — the same capability
 * the R3 Claim read endpoints require, not `projects.read`, which covers only
 * Project metadata.
 *
 * The Claim itself is never read here. `TeamClaimDetailShell` loads it through
 * the canonical R3 endpoint
 * `GET /api/workspaces/{W}/verifications/{verificationId}?projectId={P}` —
 * where Claim-level Workspace + Project containment is enforced and a mismatch
 * is concealed as absent — and renders it with the shared R2
 * `ClaimVerificationResultView`.
 *
 * This page never interprets the verification payload, never reads Firestore
 * for the Claim, and never calls a Personal verification endpoint.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { getProject } from "@/lib/firestore/projects";
import TeamClaimDetailShell from "@/components/workspace/projects/TeamClaimDetailShell";

export const dynamic = "force-dynamic";

export default async function TeamProjectClaimDetailPage({
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
    <TeamClaimDetailShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      verificationId={params.verificationId}
      project={{ id: projectResult.project.id, name: projectResult.project.name }}
      showAudit={access.capabilities.includes("audit.read")}
    />
  );
}
