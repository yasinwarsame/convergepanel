/**
 * Phase 7B — GET /workspace/projects, server-gated. Eligibility is
 * settled BEFORE any Projects UI renders — never a client-side
 * flash-then-hide. Every ineligible case (unauthenticated, UI-ineligible,
 * backend-ineligible) returns the identical `notFound()` — the response
 * gives an ineligible authenticated user no signal distinguishing
 * "logged in but not eligible" from "this route doesn't exist," and no
 * signal about which of the two independent rollout cohorts (UI vs.
 * backend) they missed.
 *
 * This gate has zero effect on any `app/api/user/project*` Route
 * Handler — all are independent, unaffected by this page's existence.
 * The reverse also holds: this page never provisions a Personal
 * Workspace, and never fetches Project/run data — Phase 7B is
 * eligibility, routing, navigation, and rendering only.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveProjectsUiEligibility } from "@/lib/projects/projectsUiEligibility";
import { PROJECTS_UI_ENABLED, PROJECTS_UI_CANARY_UIDS, PROJECTS_ENABLED, PROJECTS_CANARY_UIDS } from "@/lib/env";
import ProjectsShell from "@/components/projects/ProjectsShell";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
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

  return <ProjectsShell />;
}
