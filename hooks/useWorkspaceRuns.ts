"use client";

/**
 * Phase 5D — client abstraction for `GET /api/user/workspace/runs`, mirroring
 * `useWorkspaceMetadata()`'s established shape (`authedFetch` + a pure
 * response-parsing function separated from fetch orchestration).
 *
 * The load-bearing invariant this hook exists to get right: on EVERY
 * successful page response, `items`/`hasMore`/`nextCursor` are adopted from
 * that response regardless of how many items it contained — Phase 4B's
 * read-time integrity check can omit invalid bound rows from a page while
 * `hasMore` still legitimately advances the cursor, so a real, intended
 * response shape is `{items: [], hasMore: true, nextCursor: "..."}`. Cursor
 * state only ever changes on a SUCCESSFUL response; a failed request never
 * advances it — retrying re-sends the exact cursor that failed. See
 * `isDefinitiveEmptyState()` below for the corresponding empty-state guard.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import type { WorkspaceRunSummary } from "@/app/api/user/workspace/runs/route";
export type { WorkspaceRunSummary };

export type WorkspaceRunsErrorCode =
  | "unauthorized"
  | "auth_error"
  | "workspace_unavailable"
  | "workspace_invalid"
  | "workspace_missing"
  | "invalid_cursor"
  | "index_required"
  | "internal_error"
  | "network_error";

const KNOWN_ERROR_CODES: readonly WorkspaceRunsErrorCode[] = [
  "unauthorized",
  "auth_error",
  "workspace_unavailable",
  "workspace_invalid",
  "workspace_missing",
  "invalid_cursor",
  "index_required",
  "internal_error",
];

export interface WorkspaceRunsPage {
  items: WorkspaceRunSummary[];
  hasMore: boolean;
  nextCursor?: string;
}

export type ParseWorkspaceRunsPageResult = { ok: true; page: WorkspaceRunsPage } | { ok: false; errorCode: WorkspaceRunsErrorCode };

/**
 * Pure: given the raw fetch outcome, produce the typed page result. A
 * malformed/absent `items`/`hasMore` on a nominally-`ok` response is treated
 * as `internal_error` (the same fallback the API's own uncaught-error branch
 * uses), never guessed into a synthesized page shape.
 */
export function parseWorkspaceRunsPageResponse(outcome: { ok: boolean; body: unknown }): ParseWorkspaceRunsPageResult {
  const body = outcome.body as { ok?: unknown; items?: unknown; hasMore?: unknown; nextCursor?: unknown; errorCode?: unknown } | null;
  if (outcome.ok && body?.ok === true && Array.isArray(body.items) && typeof body.hasMore === "boolean") {
    return {
      ok: true,
      page: {
        items: body.items as WorkspaceRunSummary[],
        hasMore: body.hasMore,
        nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : undefined,
      },
    };
  }
  const errorCode = KNOWN_ERROR_CODES.find((code) => code === body?.errorCode) ?? "internal_error";
  return { ok: false, errorCode };
}

/**
 * Pure: the ONLY condition allowed to render the Workspace research list's
 * definitive empty state. `items.length === 0` alone is never sufficient —
 * see the module doc comment above.
 */
export function isDefinitiveEmptyState(state: { status: "ready" | "loading" | "error"; items: readonly unknown[]; hasMore: boolean }): boolean {
  return state.status === "ready" && state.items.length === 0 && state.hasMore === false;
}

export interface UseWorkspaceRunsResult {
  items: WorkspaceRunSummary[];
  hasMore: boolean;
  status: "loading" | "ready" | "error";
  initialErrorCode: WorkspaceRunsErrorCode | null;
  loadingMore: boolean;
  loadMoreErrorCode: WorkspaceRunsErrorCode | null;
  /** Requests the next page using the current (unadvanced-on-failure) cursor. No-op while already loading or when `hasMore` is false. */
  loadMore: () => void;
  /** Re-attempts the initial page load after an initial-load error. */
  retryInitial: () => void;
  /** Discards all client pagination state and re-fetches from page 1 — the ONLY path that ever resets an in-progress cursor, and only ever on explicit caller invocation (never automatic). */
  resetAndReloadFromStart: () => void;
}

const RUNS_ENDPOINT = "/api/user/workspace/runs";

export function useWorkspaceRuns(): UseWorkspaceRunsResult {
  const { user, loading: authLoading, authReady } = useAuth();

  const [items, setItems] = useState<WorkspaceRunSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [initialErrorCode, setInitialErrorCode] = useState<WorkspaceRunsErrorCode | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreErrorCode, setLoadMoreErrorCode] = useState<WorkspaceRunsErrorCode | null>(null);

  // Cursor state lives outside React state proper (a ref) so a failed
  // request can never accidentally trigger a re-render-driven re-adoption —
  // it is written in exactly one place: the success branch of fetchPage().
  const cursorRef = useRef<string | undefined>(undefined);
  const seenIdsRef = useRef<Set<string>>(new Set());
  // Monotonic sequence guard — a response whose sequence no longer matches
  // the current one (unmounted, UID switched, or a newer request already
  // superseded it) is discarded, never applied to state. Matches the
  // `historyLoadSeq`/`cancelled`-flag pattern already established in
  // `app/page.tsx` and `useWorkspaceMetadata`.
  const seqRef = useRef(0);

  const fetchPage = useCallback(
    async (opts: { cursor: string | undefined; isLoadMore: boolean; currentUser: typeof user }) => {
      const seq = ++seqRef.current;
      if (opts.isLoadMore) {
        setLoadingMore(true);
        setLoadMoreErrorCode(null);
      } else {
        setStatus("loading");
        setInitialErrorCode(null);
      }

      try {
        const url = opts.cursor ? `${RUNS_ENDPOINT}?cursor=${encodeURIComponent(opts.cursor)}` : RUNS_ENDPOINT;
        const res = await authedFetch(url, { user: opts.currentUser, authReady: true, method: "GET", cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (seq !== seqRef.current) return; // superseded — never apply a stale response

        const result = parseWorkspaceRunsPageResponse({ ok: res.ok, body });
        if (!result.ok) {
          if (opts.isLoadMore) {
            setLoadingMore(false);
            setLoadMoreErrorCode(result.errorCode);
          } else {
            setStatus("error");
            setInitialErrorCode(result.errorCode);
          }
          return; // cursor/items/hasMore are NOT touched on failure
        }

        // Success — adopt unconditionally, regardless of items.length.
        const deduped: WorkspaceRunSummary[] = [];
        for (const item of result.page.items) {
          if (seenIdsRef.current.has(item.id)) {
            if (process.env.NODE_ENV !== "production") {
              console.warn("[useWorkspaceRuns] duplicate run id in response, dropping", item.id);
            }
            continue;
          }
          seenIdsRef.current.add(item.id);
          deduped.push(item);
        }
        cursorRef.current = result.page.nextCursor;
        setHasMore(result.page.hasMore);
        if (opts.isLoadMore) {
          setItems((prev) => [...prev, ...deduped]);
          setLoadingMore(false);
          setLoadMoreErrorCode(null);
        } else {
          setItems(deduped);
          setStatus("ready");
          setInitialErrorCode(null);
        }
      } catch {
        if (seq !== seqRef.current) return;
        if (opts.isLoadMore) {
          setLoadingMore(false);
          setLoadMoreErrorCode("network_error");
        } else {
          setStatus("error");
          setInitialErrorCode("network_error");
        }
      }
    },
    [user]
  );

  useEffect(() => {
    if (authLoading || !authReady) return;
    if (!user) {
      // Logout / never-signed-in: reset to a definitive, non-loading error
      // state rather than leaving a stale/loading view — matches
      // useWorkspaceMetadata's unauthorized handling.
      seqRef.current++; // invalidate any in-flight request from a prior user
      seenIdsRef.current = new Set();
      cursorRef.current = undefined;
      setItems([]);
      setHasMore(false);
      setLoadingMore(false);
      setLoadMoreErrorCode(null);
      setStatus("error");
      setInitialErrorCode("unauthorized");
      return;
    }
    // Fresh identity (initial mount, or a genuine UID change) — reset all
    // pagination state before fetching page 1. This is the only place a
    // user switch can affect this hook's output; the fetch below always
    // starts from cursor=undefined.
    //
    // Deliberately keyed on `user?.uid`, not the full `user` object
    // (`useWorkspaceMetadata` keys on the full object) — a Firebase Auth
    // token refresh can hand back a new `user` object instance with the
    // SAME uid, and re-running this effect on every such refresh would
    // silently wipe a user's already-scrolled-through pagination progress
    // back to page 1. Only a genuine identity change (or the initial
    // mount) should ever reset this hook's list state.
    seenIdsRef.current = new Set();
    cursorRef.current = undefined;
    setItems([]);
    setHasMore(false);
    setLoadingMore(false);
    setLoadMoreErrorCode(null);
    void fetchPage({ cursor: undefined, isLoadMore: false, currentUser: user });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, authReady, user?.uid]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || status !== "ready" || !user) return;
    void fetchPage({ cursor: cursorRef.current, isLoadMore: true, currentUser: user });
  }, [loadingMore, hasMore, status, user, fetchPage]);

  const retryInitial = useCallback(() => {
    if (!user) return;
    void fetchPage({ cursor: undefined, isLoadMore: false, currentUser: user });
  }, [user, fetchPage]);

  const resetAndReloadFromStart = useCallback(() => {
    if (!user) return;
    seenIdsRef.current = new Set();
    cursorRef.current = undefined;
    setItems([]);
    setHasMore(false);
    setLoadingMore(false);
    setLoadMoreErrorCode(null);
    void fetchPage({ cursor: undefined, isLoadMore: false, currentUser: user });
  }, [user, fetchPage]);

  return { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart };
}
