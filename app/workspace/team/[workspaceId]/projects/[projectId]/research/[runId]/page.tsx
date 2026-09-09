/**
 * Team Research Detail, Phase 12A.4 —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/research/{runId}`.
 * Server-gated identically to the sibling Team Project detail page (same
 * `resolveServerComponentIdentity()` + `resolveWorkspaceAccess()` +
 * `getProject()` + explicit cross-Workspace containment check — that
 * page's own already-reviewed pattern, reused verbatim, not redefined),
 * PLUS the capability this page actually needs (`research.read` — reading
 * research content, not `projects.read`, which only covers Project
 * metadata), PLUS a new run-level containment check performed entirely by
 * `getTeamWorkspaceRun()` (`lib/firestore/teamWorkspaceRuns.ts`): the
 * fetched run must belong to BOTH this Workspace AND this Project, or it
 * is treated identically to "doesn't exist".
 *
 * Deliberately NOT a client-side fetch and NOT a route through
 * `/api/user/runs/[runId]` (the Personal single-run endpoint) — that route
 * has no Project-containment check at all, and reusing it here would
 * violate the deliberate Team/Personal separation this codebase maintains
 * throughout (see `hooks/useTeamProjectResearch.ts`'s own doc comment, and
 * `TeamResearchComposerShell.tsx`'s explicit avoidance of
 * `ResultsDisplay.tsx`). This is a pure Server Component: identity,
 * access, Project, and run are all resolved server-side before render,
 * with zero client-side data fetch.
 *
 * A `"pending"` run (most commonly still `"running"`) renders a small
 * inline in-progress state rather than the full `TeamResearchResultView` —
 * no live polling/auto-refresh in this phase, that's out of scope; a
 * static "still running, refresh to check" message is sufficient.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { getProject } from "@/lib/firestore/projects";
import { getTeamWorkspaceRun } from "@/lib/firestore/teamWorkspaceRuns";
import TeamResearchResultView from "@/components/workspace/projects/TeamResearchResultView";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import { Breadcrumb } from "@/components/shared/Breadcrumb";

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
    // genuine "doesn't exist / not yours". See
    // `app/workspace/projects/[projectId]/page.tsx`'s own doc comment for
    // the established precedent this mirrors. Caught by the app's
    // existing global `app/error.tsx` boundary.
    throw new Error("Something went wrong while loading this page. Please try again.");
  }
  if (!access.granted || access.workspaceType !== "team") {
    notFound();
  }
  // This page renders research content, not Project metadata — it needs
  // `research.read`, not `projects.read` (the capability the sibling
  // Project detail page checks).
  if (!access.capabilities.includes("research.read")) {
    notFound();
  }

  const projectResult = await getProject(params.projectId);
  if (projectResult.status === "firestore_unavailable" || projectResult.status === "read_failed") {
    // Same transient-vs-genuine distinction as the Workspace access check
    // above — a `.get()` failure is not evidence the Project doesn't exist.
    throw new Error("Something went wrong while loading this page. Please try again.");
  }
  if (projectResult.status !== "found") {
    notFound();
  }
  // Cross-Workspace containment — concealed identically to "doesn't
  // exist", matching the Project detail page's own established policy.
  if (projectResult.project.workspaceId !== params.workspaceId) {
    notFound();
  }

  const run = await getTeamWorkspaceRun({
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    runId: params.runId,
  });
  if (run.status === "firestore_unavailable") {
    // Same transient-vs-genuine distinction as the checks above — a
    // `.get()` failure is not evidence the run doesn't exist.
    throw new Error("Something went wrong while loading this page. Please try again.");
  }
  if (run.status === "not_found") {
    notFound();
  }

  const workspaceHref = `/workspace/team/${encodeURIComponent(params.workspaceId)}`;
  const projectHref = `${workspaceHref}/projects/${encodeURIComponent(params.projectId)}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      {/*
        Phase 11B.3 — every label here comes from a value this page ALREADY
        resolved and authorized above: the Workspace name from
        `resolveWorkspaceAccess()`, the Project name from the `getProject()` read
        that enforced Workspace containment, and the question from the
        `getTeamWorkspaceRun()` read that enforced Workspace + Project
        containment. No new read, and nothing derived from a route id.

        Placed after all of those gates, so it cannot render on a denied,
        cross-tenant, not-found or transient-failure path.

        This breadcrumb REPLACES the isolated "Back to Project" link that used to
        sit here: its Project segment (desktop) and `mobileParent` (mobile) now
        own that parent navigation, and two equivalent affordances would be
        redundant.
      */}
      <Breadcrumb
        className="mb-3"
        segments={[
          { label: access.workspace.name, href: workspaceHref },
          { label: "Projects", href: `${workspaceHref}/projects` },
          { label: projectResult.project.name, href: projectHref },
          { label: run.question },
        ]}
        mobileParent={{ label: projectResult.project.name, href: projectHref }}
      />

      {/*
        Phase 11B.3-C1 — page composition is the SAME on all seven Team Workspace
        surfaces: Breadcrumb -> page heading -> WorkspaceNav -> content.
      */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-cp-text break-words">{run.question}</h1>
      </div>

      {/*
        Phase 11B.2 — the same shared WorkspaceNav the Team research COMPOSER
        already renders, in the same position relative to the page heading, so the
        two research surfaces navigate identically.

        `active="projects"`: research detail sits hierarchically beneath the
        Workspace's Projects area. The individual run is NOT a nav tab.

        `showAudit` is a PRESENTATION HINT derived from the same fresh,
        server-resolved capability set this page already required above — it is
        not a second authorization decision. A viewer without `audit.read`
        simply does not see the Audit Log link; their `research.read` access to
        this page is unaffected.

        Rendered only after identity, Workspace access, `research.read`,
        Project containment and run containment have all succeeded, so it
        cannot appear on a denied, cross-tenant or transient-failure path.
      */}
      <WorkspaceNav
        workspaceId={params.workspaceId}
        active="projects"
        showAudit={access.capabilities.includes("audit.read")}
      />

      {run.status === "pending" ? (
        <section className="mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-5 text-sm text-cp-muted">
          This research is still in progress. Refresh this page to check again.
        </section>
      ) : (
        <TeamResearchResultView run={{ runId: run.runId, results: run.results, governanceStatus: run.governanceStatus }} />
      )}
    </main>
  );
}
