"use client";

/**
 * Phase 7C — the Projects shell, now with read-only data. Split into a
 * pure, prop-driven view (`ProjectsShellView`, exported for direct testing
 * via `react-dom/server`'s `renderToStaticMarkup`, matching this repo's
 * established no-jsdom component-testing convention — see
 * `components/workspace/WorkspaceShell.tsx`) and a thin default-export
 * wrapper that supplies the three live hooks. All three hooks are called
 * unconditionally at the top of the wrapper so their independent
 * `useEffect`-triggered fetches fire in parallel, not sequentially —
 * mirrors `WorkspaceShell`'s `useWorkspaceMetadata()`/`useWorkspaceRuns()`
 * pattern.
 *
 * The heading renders unconditionally, immediately, regardless of any
 * section's loading state — there is no page-level "loading" gate here
 * (unlike `WorkspaceShellView`, which gates on a separate `/api/user/workspace`
 * metadata call this shell has no equivalent of). Each section owns its
 * own independent loading/error/empty/pagination state; a failure in one
 * section never affects another (Load more in one never resets another).
 *
 * `page.tsx`'s server-side gate (identity → combined UI+backend
 * eligibility → canonical Personal Workspace prerequisite → `notFound()`)
 * is unchanged and unaffected by this file — an ineligible caller never
 * receives this component at all, so no client-side re-gating is needed or
 * added here.
 */

import { useProjects } from "@/hooks/useProjects";
import { useUnfiledRuns } from "@/hooks/useUnfiledRuns";
import { ActiveProjectsSection } from "@/components/projects/ActiveProjectsSection";
import { UnfiledResearchSection } from "@/components/projects/UnfiledResearchSection";
import { ArchivedProjectsSection } from "@/components/projects/ArchivedProjectsSection";
import type { UseProjectsResult } from "@/hooks/useProjects";
import type { UseUnfiledRunsResult } from "@/hooks/useUnfiledRuns";

export function ProjectsShellView({
  active,
  unfiled,
  archived,
}: {
  active: UseProjectsResult;
  unfiled: UseUnfiledRunsResult;
  archived: UseProjectsResult;
}) {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <h1 className="text-2xl font-semibold text-cp-text">Projects</h1>
      <p className="mt-2 text-sm text-cp-muted">Organize your Workspace research into projects.</p>

      <ActiveProjectsSection result={active} />
      <UnfiledResearchSection result={unfiled} />
      <ArchivedProjectsSection result={archived} />
    </main>
  );
}

export default function ProjectsShell() {
  const active = useProjects({ status: "active" });
  const unfiled = useUnfiledRuns();
  const archived = useProjects({ status: "archived" });
  return <ProjectsShellView active={active} unfiled={unfiled} archived={archived} />;
}
