"use client";

/**
 * Phase 7C — small, dumb presentational primitives shared by the three
 * Projects-shell sections (Active/Unfiled/Archived). Deliberately knows
 * nothing about any section's specific error-code union or copy — each
 * section computes its own `message`/`retry`/`action` strings (mirroring
 * `WorkspaceResearchList.tsx`'s `sectionErrorCopy()`/`loadMoreErrorCopy()`
 * separation) and passes plain strings down here. Visual treatment
 * (classes, structure) is a verbatim match of `WorkspaceResearchList.tsx`'s
 * `SectionInitialError`/`PaginationControl` so all four surfaces
 * (Workspace, Active, Unfiled, Archived) look identical.
 */

export function SectionLoadingRow({ label }: { label: string }) {
  return (
    <p className="mt-2 text-sm text-cp-muted" role="status">
      {label}
    </p>
  );
}

export function SectionInitialErrorBox({ message, retry, onRetry }: { message: string; retry: boolean; onRetry: () => void }) {
  return (
    <div className="mt-4 rounded-lg border border-cp-border bg-cp-raised p-4" role="alert">
      <p className="text-sm text-cp-muted">{message}</p>
      {retry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text transition-colors hover:bg-cp-surface"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function SectionEmptyBox({ lines }: { lines: string[] }) {
  return (
    <div className="mt-4 rounded-lg border border-cp-border bg-cp-raised p-4">
      {lines.map((line, i) => (
        <p key={line} className={i === 0 ? "text-sm text-cp-muted" : "mt-1 text-sm text-cp-muted"}>
          {line}
        </p>
      ))}
    </div>
  );
}

export function SectionPagination({
  loadingMore,
  errorMessage,
  errorAction,
  onLoadMore,
  onReload,
}: {
  loadingMore: boolean;
  errorMessage: string | null;
  errorAction: "retry" | "reload" | null;
  onLoadMore: () => void;
  onReload: () => void;
}) {
  if (errorMessage) {
    return (
      <div className="mt-4 flex flex-col items-center gap-2" role="alert">
        <p className="text-sm text-cp-muted">{errorMessage}</p>
        <button
          type="button"
          onClick={errorAction === "reload" ? onReload : onLoadMore}
          className="rounded-xl border-2 border-cp-border bg-cp-surface px-5 py-2.5 text-sm font-semibold text-cp-muted shadow-sm transition-colors hover:border-cp-accent hover:bg-cp-primary-soft"
        >
          {errorAction === "reload" ? "Reload" : "Retry"}
        </button>
      </div>
    );
  }
  return (
    <div className="mt-4 flex justify-center">
      <button
        type="button"
        disabled={loadingMore}
        onClick={onLoadMore}
        className="rounded-xl border-2 border-cp-border bg-cp-surface px-5 py-2.5 text-sm font-semibold text-cp-muted shadow-sm transition-colors hover:border-cp-accent hover:bg-cp-primary-soft disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loadingMore ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}
