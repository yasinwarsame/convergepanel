"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — queue filter controls
 * (kind, flagged, reviewable) plus pagination and a manual refresh action.
 * Fully keyboard-accessible: real `<select>`/`<button>` elements, visible
 * focus styles via the shared cp-accent ring, accessible labels.
 */

export type TeamReviewQueueFiltersState = {
  kind: "all" | "legacy" | "adaptive";
  flagged: "any" | "true" | "false";
  reviewable: "any" | "true" | "false";
};

const selectClasses =
  "rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent";

export default function TeamReviewFilters(props: {
  filters: TeamReviewQueueFiltersState;
  onChange: (next: TeamReviewQueueFiltersState) => void;
  onRefresh: () => void;
  refreshing: boolean;
  page: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onPageChange: (page: number) => void;
}) {
  const { filters, onChange, onRefresh, refreshing, page, hasNextPage, hasPreviousPage, onPageChange } = props;

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-cp-border bg-cp-surface p-4 shadow-sm">
      <label className="flex flex-col gap-1 text-xs font-medium text-cp-muted">
        Kind
        <select
          className={selectClasses}
          value={filters.kind}
          onChange={(e) => onChange({ ...filters, kind: e.target.value as TeamReviewQueueFiltersState["kind"] })}
        >
          <option value="all">All</option>
          <option value="legacy">Legacy</option>
          <option value="adaptive">Adaptive</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-cp-muted">
        Flagged
        <select
          className={selectClasses}
          value={filters.flagged}
          onChange={(e) => onChange({ ...filters, flagged: e.target.value as TeamReviewQueueFiltersState["flagged"] })}
        >
          <option value="any">Any</option>
          <option value="true">Flagged only</option>
          <option value="false">Not flagged</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-cp-muted">
        Reviewable
        <select
          className={selectClasses}
          value={filters.reviewable}
          onChange={(e) => onChange({ ...filters, reviewable: e.target.value as TeamReviewQueueFiltersState["reviewable"] })}
        >
          <option value="any">Any</option>
          <option value="true">Reviewable only</option>
          <option value="false">Not reviewable</option>
        </select>
      </label>

      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={!hasPreviousPage}
          aria-label="Previous page"
          className="rounded-lg border border-cp-border px-3 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-40"
        >
          &larr; Prev
        </button>
        <span className="text-sm text-cp-muted">Page {page}</span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={!hasNextPage}
          aria-label="Next page"
          className="rounded-lg border border-cp-border px-3 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-40"
        >
          Next &rarr;
        </button>
      </div>
    </div>
  );
}
