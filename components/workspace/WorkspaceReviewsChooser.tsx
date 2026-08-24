"use client";

/**
 * Approval Workflow, Phase 9C.1-R1C — the explicit Workspace-selection
 * state `/workspace/reviews/page.tsx` renders when a uid has TWO OR MORE
 * active Team Workspace memberships and no `?workspace=` param is
 * present. This is the corrected replacement for a real defect: silently
 * auto-selecting one Workspace made every other one's review queue
 * permanently unreachable through this UI, with no signal anything was
 * hidden. Never fetches queue/review data itself — only Workspace
 * names, via the bounded/paginated `GET /api/workspaces` list.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { fetchWorkspaceList, type WorkspaceListItem } from "@/lib/client/workspaceListClient";
import ReviewErrorState from "@/components/teamGovernance/ReviewErrorState";

const GENERIC_ERROR_MESSAGE = "We couldn't load your Workspaces. Try again.";

export default function WorkspaceReviewsChooser() {
  const { user, authReady } = useAuth();
  const [items, setItems] = useState<WorkspaceListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);

  const requestIdRef = useRef(0);

  const runQuery = useCallback(() => {
    if (!authReady) return;
    const requestId = ++requestIdRef.current;
    setStatus("loading");
    (async () => {
      const result = await fetchWorkspaceList({ user, authReady });
      if (requestIdRef.current !== requestId) return;
      if (result.status === "ok") {
        setItems(result.page.items);
        setCursor(result.page.nextCursor);
        setHasMore(result.page.hasMore);
        setStatus("ready");
      } else {
        setItems([]);
        setCursor(null);
        setHasMore(false);
        setStatus("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, user?.uid]);

  useEffect(() => {
    runQuery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, user?.uid]);

  const handleLoadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const requestId = requestIdRef.current;
    const result = await fetchWorkspaceList({ user, authReady, cursor });
    if (requestIdRef.current !== requestId) return;
    if (result.status === "ok") {
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.workspaceId));
        const merged = prev.slice();
        for (const item of result.page.items) {
          if (!seen.has(item.workspaceId)) {
            seen.add(item.workspaceId);
            merged.push(item);
          }
        }
        return merged;
      });
      setCursor(result.page.nextCursor);
      setHasMore(result.page.hasMore);
    }
    setLoadingMore(false);
  }, [cursor, loadingMore, user, authReady]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:py-14">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-cp-text">Reviews</h1>
        <p className="mt-1 text-sm text-cp-muted">Choose a Workspace to view its reviews.</p>
      </div>

      {status === "loading" && (
        <div role="status" className="rounded-xl border border-cp-border bg-cp-surface px-6 py-12 text-center text-sm text-cp-muted shadow-sm">
          Loading Workspaces…
        </div>
      )}

      {status === "error" && <ReviewErrorState message={GENERIC_ERROR_MESSAGE} onRetry={runQuery} />}

      {status === "ready" && (
        <nav aria-label="Workspace" className="rounded-xl border border-cp-border bg-cp-surface shadow-sm">
          <ul>
            {items.map((item) => (
              <li key={item.workspaceId} className="border-b border-cp-border-soft last:border-b-0">
                <Link
                  href={`/workspace/reviews?workspace=${encodeURIComponent(item.workspaceId)}`}
                  className="flex items-center justify-between px-4 py-3 text-sm font-medium text-cp-text transition-colors hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
                >
                  <span className="truncate">{item.name}</span>
                  <span aria-hidden="true" className="ml-3 text-cp-faint">
                    View
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {status === "ready" && hasMore && (
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
