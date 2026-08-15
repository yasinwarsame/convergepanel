"use client";

/**
 * Phase 5C/5D — the Workspace shell. Phase 5C shipped the minimal shell
 * (heading, Workspace name, "New research" CTA, 4 sanitized error states).
 * Phase 5D adds the "Recent research" list (`WorkspaceResearchList`) below
 * the CTA — no selector, no settings, no Project/team affordances, still
 * Phase 5E+ scope.
 *
 * Split into a pure, prop-driven view (`WorkspaceShellView`, exported for
 * direct testing via `react-dom/server`'s `renderToStaticMarkup` —
 * matching this repo's established no-jsdom component-testing
 * convention, see `components/adaptive/__tests__/MetricsGridView.spec.tsx`)
 * and a thin default-export wrapper that supplies the live
 * `useWorkspaceMetadata()`/`useWorkspaceRuns()` state. Both hooks are
 * called unconditionally at the top of the wrapper so their independent
 * `useEffect`-triggered fetches fire in parallel, not sequentially — see
 * `docs/workspaces/phase5d-workspace-research-design.md` §19.
 */

import Link from "next/link";
import { useWorkspaceMetadata, type UseWorkspaceMetadataResult, type WorkspaceMetadataErrorCode } from "@/hooks/useWorkspaceMetadata";
import { useWorkspaceRuns, type UseWorkspaceRunsResult } from "@/hooks/useWorkspaceRuns";
import { WorkspaceResearchList, isEscalatedWorkspaceRunsError } from "@/components/workspace/WorkspaceResearchList";

export function errorCopy(code: WorkspaceMetadataErrorCode): { title: string; body: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { title: "Session unavailable", body: "Please sign in again to view your Workspace.", retry: false };
    case "workspace_missing":
      return { title: "Workspace not set up yet", body: "We couldn't find your Workspace. Please contact support if this continues.", retry: false };
    case "workspace_invalid":
      return { title: "There's a problem with your Workspace", body: "Please contact support so we can take a look.", retry: false };
    case "workspace_unavailable":
    case "network_error":
      return { title: "Couldn't load your Workspace", body: "This is usually temporary.", retry: true };
  }
}

export function WorkspaceShellView({ metadata, runs }: { metadata: UseWorkspaceMetadataResult; runs: UseWorkspaceRunsResult }) {
  // A runs-endpoint error can independently rediscover the SAME Workspace
  // prerequisite failure the metadata endpoint already guards against (a
  // race between the two parallel requests) — when it does, this is a
  // page-level prerequisite problem, not merely the list failing, so the
  // whole success view is replaced by the identical page-level error
  // treatment metadata failures already use (reusing `errorCopy()` with
  // the runs error code — the two endpoints' `workspace_missing`/
  // `workspace_invalid`/`workspace_unavailable` codes are identical by
  // construction). See phase5d design doc §20–21.
  const escalatedRunsErrorCode =
    metadata.status === "success" && runs.status === "error" && runs.initialErrorCode && isEscalatedWorkspaceRunsError(runs.initialErrorCode)
      ? runs.initialErrorCode
      : null;

  const effectiveErrorCode = metadata.status === "error" ? metadata.errorCode : escalatedRunsErrorCode;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <h1 className="text-2xl font-semibold text-cp-text">Workspace</h1>

      {metadata.status === "loading" && (
        <p className="mt-2 text-sm text-cp-muted" role="status">
          Loading your Workspace…
        </p>
      )}

      {metadata.status === "success" && !effectiveErrorCode && (
        <>
          <p className="mt-2 text-sm text-cp-muted">{metadata.workspace.name}</p>
          <div className="mt-8">
            <Link
              href="/"
              className="inline-flex items-center rounded-[11px] bg-cp-primary px-4 py-2 text-sm font-semibold text-white shadow-[0_2px_8px_rgba(37,99,235,0.3)] transition-colors hover:bg-cp-accent"
            >
              New research
            </Link>
          </div>
          <WorkspaceResearchList result={runs} />
        </>
      )}

      {effectiveErrorCode &&
        (() => {
          const copy = errorCopy(effectiveErrorCode);
          return (
            <div className="mt-6 rounded-lg border border-cp-border bg-cp-raised p-4" role="alert">
              <p className="text-sm font-medium text-cp-text">{copy.title}</p>
              <p className="mt-1 text-sm text-cp-muted">{copy.body}</p>
              {copy.retry && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-3 rounded-md border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text transition-colors hover:bg-cp-surface"
                >
                  Try again
                </button>
              )}
            </div>
          );
        })()}
    </main>
  );
}

export default function WorkspaceShell() {
  const metadata = useWorkspaceMetadata();
  const runs = useWorkspaceRuns();
  return <WorkspaceShellView metadata={metadata} runs={runs} />;
}
