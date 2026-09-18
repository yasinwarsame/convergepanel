/**
 * Team Research Detail —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/research/{runId}`.
 *
 * TEAM-RESEARCH-PARITY-R3 — LAYER 1: server route gate + Team chrome context.
 *
 * Server-gated identically to the sibling Team Project detail page (same
 * `resolveServerComponentIdentity()` + `resolveWorkspaceAccess()` +
 * `getProject()` + explicit cross-Workspace containment check), plus the
 * capability this page actually needs: `research.read` (reading research
 * content, not `projects.read`, which only covers Project metadata).
 *
 * The persisted research itself is no longer read here. Phase 12A.4 read the
 * run directly with `getTeamWorkspaceRun()` and rendered the limited
 * `TeamResearchResultView`; R3 hands the authorized, Workspace-contained
 * context to `TeamResearchDetailShell`, which loads the run through the
 * canonical R1 endpoint `GET /api/workspaces/{W}/runs/{runId}?projectId={P}` —
 * where run-level Workspace + Project containment is enforced and concealed —
 * and renders the same canonical ordinary / adaptive / legacy-adaptive /
 * persisted-synthesis body the Personal durable report uses.
 *
 * This page never interprets the research payload and never calls the Personal
 * run endpoint.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { getProject } from "@/lib/firestore/projects";
import TeamResearchDetailShell from "@/components/workspace/projects/TeamResearchDetailShell";

export const dynamic = "force-dynamic";

export default async function TeamResearchDetailPage({
  params,
}: {
  params: { workspaceId: string; projectId: string; runId: string };
}) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const access = await resolveWorkspaceAccess({ uid: identity.uid, workspaceId: params.workspaceId });
  if (!access.granted && access.reason === "lookup_failed") {
    // Distinct from every concealed-denial case below — a transient
    // Firestore/infra failure must never be indistinguishable from a
    // genuine "doesn't exist / not yours". Caught by the app's existing
    // global `app/error.tsx` boundary.
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
    <TeamResearchDetailShell
      workspaceId={params.workspaceId}
      workspaceName={access.workspace.name}
      runId={params.runId}
      project={{ id: projectResult.project.id, name: projectResult.project.name }}
      // Presentation hint from the same server-resolved capability set — not a
      // second authorization decision.
      showAudit={access.capabilities.includes("audit.read")}
      // R4-I4 — verifying a claim from a Project-filed run results in a
      // Project-filed Claim, which the POST's gates require `research.organize`
      // for. Presentation only; viewing still needs just `research.read`.
      canVerifyClaim={access.capabilities.includes("research.create") && access.capabilities.includes("research.organize")}
    />
  );
}
