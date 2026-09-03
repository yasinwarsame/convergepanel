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
import Link from "next/link";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { getProject } from "@/lib/firestore/projects";
import { getTeamWorkspaceRun } from "@/lib/firestore/teamWorkspaceRuns";
import TeamResearchResultView from "@/components/workspace/projects/TeamResearchResultView";

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

  const backHref = `/workspace/team/${encodeURIComponent(params.workspaceId)}/projects/${encodeURIComponent(params.projectId)}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-cp-text">{access.workspace.name}</h1>
      </div>

      <Link href={backHref} className="text-sm font-medium text-cp-accent hover:underline">
        &larr; Back to Project
      </Link>

      <h2 className="mt-4 text-xl font-semibold text-cp-text break-words">{run.question}</h2>

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
