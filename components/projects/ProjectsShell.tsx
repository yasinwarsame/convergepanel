"use client";

/**
 * Phase 7C — the Projects shell, now with read-only data. Phase 7D adds
 * lifecycle mutation wiring (create/rename/archive/restore) via
 * `useProjectLifecycle()`, called once here and threaded down to both
 * Active and Archived sections so they share one set of per-Project
 * mutation locks — a Project row shown in both places (impossible in
 * practice, since a Project is either active or archived, but the shared
 * hook instance is what makes that invariant automatic rather than
 * something two independent hook instances would need to coordinate).
 *
 * Split into a pure, prop-driven view (`ProjectsShellView`, exported for
 * direct testing via `react-dom/server`'s `renderToStaticMarkup`, matching
 * this repo's established no-jsdom component-testing convention — see
 * `components/workspace/WorkspaceShell.tsx`) and a thin default-export
 * wrapper that supplies the three live list hooks plus the lifecycle
 * hook. All three list hooks are called unconditionally at the top of the
 * wrapper so their independent `useEffect`-triggered fetches fire in
 * parallel, not sequentially — mirrors `WorkspaceShell`'s
 * `useWorkspaceMetadata()`/`useWorkspaceRuns()` pattern.
 *
 * Reconciliation after a successful mutation (spec item 23):
 *  - create -> reset Active only (`onCreated`).
 *  - rename -> local `replaceItem()` on BOTH sections (spec item 11/23) —
 *    harmless no-op on whichever section doesn't hold that id; never a
 *    full section reset, since rename never changes status/membership.
 *  - archive/restore -> reset BOTH Active and Archived from page 1
 *    (`refreshSections`), since the Project moves between them.
 *  - Unfiled is never reset by any Project lifecycle mutation.
 *
 * The heading renders unconditionally, immediately, regardless of any
 * section's loading state — there is no page-level "loading" gate here
 * (unlike `WorkspaceShellView`, which gates on a separate
 * `/api/user/workspace` metadata call this shell has no equivalent of).
 * Each section owns its own independent loading/error/empty/pagination
 * state; a failure in one section never affects another.
 *
 * `page.tsx`'s server-side gate (identity → combined UI+backend
 * eligibility → canonical Personal Workspace prerequisite → `notFound()`)
 * is unchanged and unaffected by this file — an ineligible caller never
 * receives this component at all, so no client-side re-gating is needed or
 * added here.
 */

import { useProjects } from "@/hooks/useProjects";
import { useUnfiledRuns } from "@/hooks/useUnfiledRuns";
import { useProjectLifecycle } from "@/hooks/useProjectLifecycle";
import { ActiveProjectsSection } from "@/components/projects/ActiveProjectsSection";
import { UnfiledResearchSection } from "@/components/projects/UnfiledResearchSection";
import { ArchivedProjectsSection } from "@/components/projects/ArchivedProjectsSection";
import type { UseProjectsResult, ProjectSummary } from "@/hooks/useProjects";
import type { UseUnfiledRunsResult } from "@/hooks/useUnfiledRuns";
import type { UseProjectLifecycleResult } from "@/hooks/useProjectLifecycle";

export function ProjectsShellView({
  active,
  unfiled,
  archived,
  lifecycle,
  onCreated,
  onRenamed,
  refreshSections,
}: {
  active: UseProjectsResult;
  unfiled: UseUnfiledRunsResult;
  archived: UseProjectsResult;
  lifecycle: UseProjectLifecycleResult;
  onCreated: () => void;
  onRenamed: (updated: ProjectSummary) => void;
  refreshSections: () => void;
}) {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <h1 className="text-2xl font-semibold text-cp-text">Projects</h1>
      <p className="mt-2 text-sm text-cp-muted">Organize your Workspace research into projects.</p>

      <ActiveProjectsSection result={active} lifecycle={lifecycle} onRenamed={onRenamed} refreshSections={refreshSections} onCreated={onCreated} />
      <UnfiledResearchSection result={unfiled} />
      <ArchivedProjectsSection result={archived} lifecycle={lifecycle} onRenamed={onRenamed} refreshSections={refreshSections} />
    </main>
  );
}

export default function ProjectsShell() {
  const active = useProjects({ status: "active" });
  const unfiled = useUnfiledRuns();
  const archived = useProjects({ status: "archived" });
  const lifecycle = useProjectLifecycle();

  const handleCreated = () => {
    active.resetAndReloadFromStart();
  };

  const handleRenamed = (updated: ProjectSummary) => {
    active.replaceItem(updated);
    archived.replaceItem(updated);
  };

  const refreshSections = () => {
    active.resetAndReloadFromStart();
    archived.resetAndReloadFromStart();
  };

  return (
    <ProjectsShellView
      active={active}
      unfiled={unfiled}
      archived={archived}
      lifecycle={lifecycle}
      onCreated={handleCreated}
      onRenamed={handleRenamed}
      refreshSections={refreshSections}
    />
  );
}
