/**
 * Phase 7E-B — `GET /workspace/projects/{projectId}`, server-gated. The
 * canonical assigned-research surface for one Project. Extends the exact
 * gate `/workspace/projects/page.tsx` already establishes (identity ->
 * combined UI+backend eligibility -> canonical Personal Workspace
 * prerequisite) with one additional step: `resolveProjectForOwner()`.
 *
 * Every existing concealment outcome (unauthenticated, ineligible,
 * missing/invalid Workspace, invalid/missing/foreign Project, workspace
 * mismatch) returns the IDENTICAL `notFound()` — same rationale as the
 * top-level page's own doc comment: no signal distinguishing "doesn't
 * exist" from "not yours" from "not eligible."
 *
 * Deliberate deviation from the top-level page's own precedent for
 * exactly one outcome: `resolveProjectForOwner()`'s `lookup_failed`
 * (a genuine, transient Firestore/infrastructure failure) is NOT
 * collapsed into `notFound()` here. Unlike the top-level page — which has
 * no specific resource the caller was trying to reach, so concealing an
 * infrastructure hiccup behind "not found" is harmless — this page has an
 * authorized caller reaching for a specific Project they may legitimately
 * expect to exist. Silently telling them "this project doesn't exist"
 * during a transient outage would be a real defect, not a security
 * property. A thrown Error is caught by the app's existing global
 * `app/error.tsx` boundary — no new error framework is introduced.
 *
 * No new Project-detail GET API — `resolveProjectForOwner()`'s returned
 * `ProjectV1` already supplies everything the header needs (`id`, `name`,
 * `status`); this was a deliberate Phase 6B decision this page simply
 * consumes, not a new capability.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveProjectsUiEligibility } from "@/lib/projects/projectsUiEligibility";
import { resolvePersonalWorkspaceForOwner } from "@/lib/workspaces/resolvePersonalWorkspaceForOwner";
import { resolveProjectForOwner } from "@/lib/projects/resolveProjectForOwner";
import { PROJECTS_UI_ENABLED, PROJECTS_UI_CANARY_UIDS, PROJECTS_ENABLED, PROJECTS_CANARY_UIDS } from "@/lib/env";
import ProjectDetailShell from "@/components/projects/ProjectDetailShell";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({ params }: { params: { projectId: string } }) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const eligible = resolveProjectsUiEligibility({
    uid: identity.uid,
    uiGlobalEnabled: PROJECTS_UI_ENABLED,
    uiCanaryUidsRaw: PROJECTS_UI_CANARY_UIDS,
    backendGlobalEnabled: PROJECTS_ENABLED,
    backendCanaryUidsRaw: PROJECTS_CANARY_UIDS,
  });
  if (!eligible) {
    notFound();
  }

  const workspaceResult = await resolvePersonalWorkspaceForOwner(identity.uid);
  if (workspaceResult.status !== "found") {
    notFound();
  }

  // Phase 7E-B addition — the one new gate step. `params.projectId` is a
  // client-supplied route segment, never trusted directly; resolution and
  // ownership are fully re-verified server-side here, the same as every
  // other Project route.
  const projectResult = await resolveProjectForOwner(identity.uid, params.projectId);
  if (projectResult.status === "lookup_failed") {
    // Distinct from every concealment case below — see module doc comment.
    throw new Error("Failed to load this Project. Please try again.");
  }
  if (projectResult.status !== "found") {
    notFound();
  }

  return (
    <ProjectDetailShell
      project={{ id: projectResult.project.id, name: projectResult.project.name, status: projectResult.project.status }}
    />
  );
}
