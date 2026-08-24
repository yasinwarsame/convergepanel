"use client";

/**
 * Approval Workflow, Phase 9C.1 — client shell for the Workspace review
 * queue. READ-ONLY: fetches `GET /api/workspaces/{workspaceId}/review-queue`
 * and `GET /api/workspaces/{workspaceId}/projects` (Project name list, one
 * bounded call, never per-row) only. No assignment/decision/panel/
 * override/resubmission mutation exists anywhere in this component or its
 * children (Phase 9C.1 §69, mandatory — verified structurally in this
 * file's own test suite).
 *
 * `workspaceId` is a prop supplied by the server-gated page
 * (`app/workspace/reviews/page.tsx`) — never re-derived, hardcoded, or
 * read from a Project/assignment/queue row on the client (Phase 9C.1
 * §14). URL search params (`view`, `project`) are the single source of
 * truth for filter state — never held only in component memory — so
 * back/forward/refresh/share-link all reproduce the exact same query.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import {
  fetchWorkspaceReviewQueue,
  fetchWorkspaceProjectOptions,
  parseProjectFilterParam,
  projectFilterToParamValue,
  DEFAULT_REVIEW_QUEUE_LIMIT,
  type WorkspaceReviewQueueRow,
  type ReviewQueueProjectFilter,
  type WorkspaceProjectOption,
} from "@/lib/client/workspaceReviewQueueClient";
import { REVIEW_QUEUE_VIEWS, getReviewQueueViewLabel, normalizeReviewQueueView, getReviewQueueEmptyStateCopy, type ReviewQueueView } from "@/lib/workspaces/reviewQueuePresentation";
import ReviewQueueRow from "./ReviewQueueRow";
import ReviewEmptyState from "@/components/teamGovernance/ReviewEmptyState";
import ReviewErrorState from "@/components/teamGovernance/ReviewErrorState";

const GENERIC_ERROR_MESSAGE = "We couldn't load reviews. Try again.";

/** Pure — independently unit-testable without rendering. Invalid `view` normalizes to the default; any `project` value other than `"unfiled"` or absent/`"all"` is treated as a literal Project id (never validated here — the backend/Project list is the source of truth for whether it resolves). */
export function parseQueueSearchParams(searchParams: URLSearchParams): { view: ReviewQueueView; projectFilter: ReviewQueueProjectFilter } {
  return {
    view: normalizeReviewQueueView(searchParams.get("view")),
    projectFilter: parseProjectFilterParam(searchParams.get("project")),
  };
}

/** Pure — the URL a filter-change navigates to. Always sets both `view` and `project` explicitly (never partial), so a changed filter can never accidentally inherit a stale value from a param it didn't touch. */
export function buildQueueHref(pathname: string, view: ReviewQueueView, projectFilter: ReviewQueueProjectFilter): string {
  const params = new URLSearchParams();
  params.set("view", view);
  params.set("project", projectFilterToParamValue(projectFilter));
  return `${pathname}?${params.toString()}`;
}

/** Pure — appends only rows not already present by `runId`, preserving existing order. Never used to replace a filter change's first page (that always sets `items` outright), only "Load more" appends. */
export function mergeUniqueQueueRows(existing: WorkspaceReviewQueueRow[], incoming: WorkspaceReviewQueueRow[]): WorkspaceReviewQueueRow[] {
  const seen = new Set(existing.map((r) => r.runId));
  const merged = existing.slice();
  for (const row of incoming) {
    if (!seen.has(row.runId)) {
      seen.add(row.runId);
      merged.push(row);
    }
  }
  return merged;
}

export default function WorkspaceReviewQueueShell({ workspaceId }: { workspaceId: string }) {
  const { user, authReady } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { view, projectFilter } = parseQueueSearchParams(searchParams);

  const [items, setItems] = useState<WorkspaceReviewQueueRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [canManageReviews, setCanManageReviews] = useState(false);
  const [listStatus, setListStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projectOptions, setProjectOptions] = useState<WorkspaceProjectOption[]>([]);

  const projectNameById = new Map(projectOptions.map((p) => [p.id, p.name]));

  // Latest-request-wins guard (§28) — a slow response for a since-
  // abandoned view/filter must never overwrite state for the current one.
  const requestIdRef = useRef(0);

  const runQuery = useCallback(() => {
    if (!authReady) return;
    const requestId = ++requestIdRef.current;
    setListStatus("loading");
    setErrorMessage(null);
    (async () => {
      const result = await fetchWorkspaceReviewQueue({ workspaceId, user, authReady, view, projectFilter, limit: DEFAULT_REVIEW_QUEUE_LIMIT });
      if (requestIdRef.current !== requestId) return;
      if (result.status === "ok") {
        setItems(result.page.items);
        setCursor(result.page.nextCursor);
        setHasMore(result.page.hasMore);
        setCanManageReviews(result.page.viewerActions.canManageReviews);
        setListStatus("ready");
      } else {
        setItems([]);
        setCursor(null);
        setHasMore(false);
        setErrorMessage(GENERIC_ERROR_MESSAGE);
        setListStatus("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, view, projectFilter, authReady, user?.uid]);

  // Changing view or Project resets to the first page (§24) — this effect
  // re-runs on every [workspaceId, view, projectFilter] change and always
  // fetches page 1, never reusing a cursor across a filter/view change.
  useEffect(() => {
    runQuery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, view, projectFilter, authReady, user?.uid]);

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    (async () => {
      const options = await fetchWorkspaceProjectOptions({ workspaceId, user, authReady });
      if (!cancelled) setProjectOptions(options);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, authReady, user?.uid]);

  const handleLoadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const requestId = requestIdRef.current;
    const result = await fetchWorkspaceReviewQueue({ workspaceId, user, authReady, view, projectFilter, cursor, limit: DEFAULT_REVIEW_QUEUE_LIMIT });
    if (requestIdRef.current !== requestId) {
      // A filter/view change (or a fresh retry) started after this
      // request was issued — never append a stale page onto new state.
      return;
    }
    if (result.status === "ok") {
      setItems((prev) => mergeUniqueQueueRows(prev, result.page.items));
      setCursor(result.page.nextCursor);
      setHasMore(result.page.hasMore);
    }
    setLoadingMore(false);
  }, [cursor, loadingMore, workspaceId, user, authReady, view, projectFilter]);

  const handleViewChange = (nextView: ReviewQueueView) => {
    router.push(buildQueueHref(pathname, nextView, projectFilter));
  };

  const handleProjectChange = (nextProjectParam: string) => {
    router.push(buildQueueHref(pathname, view, parseProjectFilterParam(nextProjectParam)));
  };

  const emptyCopy = getReviewQueueEmptyStateCopy(view);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-cp-text">Reviews</h1>
        <p className="mt-1 text-sm text-cp-muted">Review work assigned to you and track Workspace review status.</p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Review queue view" className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-cp-border bg-cp-surface p-1">
          {REVIEW_QUEUE_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={v === view}
              onClick={() => handleViewChange(v)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent ${
                v === view ? "bg-cp-primary-soft text-cp-primary" : "text-cp-muted hover:bg-cp-raised hover:text-cp-text"
              }`}
            >
              {getReviewQueueViewLabel(v)}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-cp-muted">
          <span className="font-medium text-cp-text">Project</span>
          <select
            className="rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent"
            value={projectFilterToParamValue(projectFilter)}
            onChange={(e) => handleProjectChange(e.target.value)}
          >
            <option value="all">All projects</option>
            <option value="unfiled">Unfiled</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {listStatus === "loading" && (
        <div role="status" className="rounded-xl border border-cp-border bg-cp-surface px-6 py-12 text-center text-sm text-cp-muted shadow-sm">
          Loading reviews…
        </div>
      )}

      {listStatus === "error" && <ReviewErrorState message={errorMessage ?? GENERIC_ERROR_MESSAGE} onRetry={runQuery} />}

      {listStatus === "ready" && items.length === 0 && <ReviewEmptyState title={emptyCopy.title} message={emptyCopy.message} />}

      {listStatus === "ready" && items.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-cp-border bg-cp-surface shadow-sm">
          <ul>
            {items.map((row) => (
              <ReviewQueueRow key={row.runId} row={row} projectNameById={projectNameById} canManageReviews={canManageReviews} />
            ))}
          </ul>
        </div>
      )}

      {listStatus === "ready" && hasMore && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </main>
  );
}
