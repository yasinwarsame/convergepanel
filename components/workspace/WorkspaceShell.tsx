"use client";

/**
 * Phase 5C — the minimal Workspace shell. Deliberately does NOT render a
 * research list, history cards, counts, a selector, or settings — all
 * Phase 5D+ scope. Reuses the existing research entry point (`/`) for the
 * CTA rather than inventing a Workspace-scoped creation flow; new
 * Personal adaptive research is already server-bound to the Workspace,
 * so no selection step is offered here.
 *
 * Split into a pure, prop-driven view (`WorkspaceShellView`, exported for
 * direct testing via `react-dom/server`'s `renderToStaticMarkup` —
 * matching this repo's established no-jsdom component-testing
 * convention, see `components/adaptive/__tests__/MetricsGridView.spec.tsx`)
 * and a thin default-export wrapper that supplies the live
 * `useWorkspaceMetadata()` state. The hook's own internal `useEffect`
 * never fires during a static-markup render, so a component that read
 * the hook directly could only ever be tested in its initial `loading`
 * state — splitting the render out as a pure function makes every state
 * (loading/success/every error code) independently, faithfully testable.
 */

import Link from "next/link";
import { useWorkspaceMetadata, type UseWorkspaceMetadataResult, type WorkspaceMetadataErrorCode } from "@/hooks/useWorkspaceMetadata";

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

export function WorkspaceShellView({ metadata }: { metadata: UseWorkspaceMetadataResult }) {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <h1 className="text-2xl font-semibold text-cp-text">Workspace</h1>

      {metadata.status === "loading" && (
        <p className="mt-2 text-sm text-cp-muted" role="status">
          Loading your Workspace…
        </p>
      )}

      {metadata.status === "success" && (
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
        </>
      )}

      {metadata.status === "error" &&
        (() => {
          const copy = errorCopy(metadata.errorCode);
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
  return <WorkspaceShellView metadata={metadata} />;
}
