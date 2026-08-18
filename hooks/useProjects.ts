"use client";

/**
 * Phase 7C — client abstraction for `GET /api/user/projects`, parameterized
 * by `status` so one hook serves both the Active Projects and Archived
 * Projects sections (mirrors the server-side `listProjectsForOwner()`'s own
 * `status` param rather than duplicating this hook per section). Structural
 * mirror of `useWorkspaceRuns()` — same `authedFetch` + pure
 * response-parsing + cursor-ref + monotonic-sequence-guard pattern, applied
 * to the Projects list endpoint instead of runs.
 *
 * Same load-bearing invariant as `useWorkspaceRuns()`: on every successful
 * page response, `items`/`hasMore`/`nextCursor` are adopted regardless of
 * `items.length` — a definitive empty state requires `hasMore === false`,
 * never merely `items.length === 0`. See `isDefinitiveEmptyProjectsState()`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";

export interface ProjectSummary {
  id: string;
  name: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export type ProjectsListErrorCode =
  | "unauthorized"
  | "auth_error"
  | "projects_disabled"
  | "invalid_status"
  | "workspace_unavailable"
  | "workspace_invalid"
  | "workspace_missing"
  | "invalid_cursor"
  | "internal_error"
  | "network_error";

const KNOWN_ERROR_CODES: readonly ProjectsListErrorCode[] = [
  "unauthorized",
  "auth_error",
  "projects_disabled",
  "invalid_status",
  "workspace_unavailable",
  "workspace_invalid",
  "workspace_missing",
  "invalid_cursor",
  "internal_error",
];

export interface ProjectsListPage {
  items: ProjectSummary[];
  hasMore: boolean;
  nextCursor?: string;
}

export type ParseProjectsListPageResult = { ok: true; page: ProjectsListPage } | { ok: false; errorCode: ProjectsListErrorCode };

/** Pure: mirrors `parseWorkspaceRunsPageResponse()` — a malformed/absent `items`/`hasMore` on a nominally-`ok` response is `internal_error`, never a synthesized page shape. */
export function parseProjectsListPageResponse(outcome: { ok: boolean; body: unknown }): ParseProjectsListPageResult {
  const body = outcome.body as { ok?: unknown; items?: unknown; hasMore?: unknown; nextCursor?: unknown; errorCode?: unknown } | null;
  if (outcome.ok && body?.ok === true && Array.isArray(body.items) && typeof body.hasMore === "boolean") {
    return {
      ok: true,
      page: {
        items: body.items as ProjectSummary[],
        hasMore: body.hasMore,
        nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : undefined,
      },
    };
  }
  const errorCode = KNOWN_ERROR_CODES.find((code) => code === body?.errorCode) ?? "internal_error";
  return { ok: false, errorCode };
}

/** Pure: the ONLY condition allowed to render a Projects list section's definitive empty state — `items.length === 0` alone is never sufficient. */
export function isDefinitiveEmptyProjectsState(state: { status: "ready" | "loading" | "error"; items: readonly unknown[]; hasMore: boolean }): boolean {
  return state.status === "ready" && state.items.length === 0 && state.hasMore === false;
}

export interface UseProjectsResult {
  items: ProjectSummary[];
  hasMore: boolean;
  status: "loading" | "ready" | "error";
  initialErrorCode: ProjectsListErrorCode | null;
  loadingMore: boolean;
  loadMoreErrorCode: ProjectsListErrorCode | null;
  /** Requests the next page using the current (unadvanced-on-failure) cursor. No-op while already loading or when `hasMore` is false. */
  loadMore: () => void;
  /** Re-attempts the initial page load after an initial-load error. */
  retryInitial: () => void;
  /** Discards all client pagination state and re-fetches from page 1 — the ONLY path that ever resets an in-progress cursor, and only ever on explicit caller invocation. */
  resetAndReloadFromStart: () => void;
}

const PROJECTS_ENDPOINT = "/api/user/projects";

export function useProjects(args: { status: "active" | "archived" }): UseProjectsResult {
  const { status: listStatus } = args;
  const { user, loading: authLoading, authReady } = useAuth();

  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [initialErrorCode, setInitialErrorCode] = useState<ProjectsListErrorCode | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreErrorCode, setLoadMoreErrorCode] = useState<ProjectsListErrorCode | null>(null);

  // Cursor state lives outside React state (a ref) so a failed request can
  // never accidentally trigger a re-render-driven re-adoption — written in
  // exactly one place: the success branch of fetchPage().
  const cursorRef = useRef<string | undefined>(undefined);
  const seenIdsRef = useRef<Set<string>>(new Set());
  // Monotonic sequence guard — a response whose sequence no longer matches
  // the current one (unmounted, status/uid switched, or a newer request
  // already superseded it) is discarded, never applied to state.
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
        const base = `${PROJECTS_ENDPOINT}?status=${listStatus}`;
        const url = opts.cursor ? `${base}&cursor=${encodeURIComponent(opts.cursor)}` : base;
        const res = await authedFetch(url, { user: opts.currentUser, authReady: true, method: "GET", cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (seq !== seqRef.current) return; // superseded — never apply a stale response

        const result = parseProjectsListPageResponse({ ok: res.ok, body });
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
        const deduped: ProjectSummary[] = [];
        for (const item of result.page.items) {
          if (seenIdsRef.current.has(item.id)) {
            if (process.env.NODE_ENV !== "production") {
              console.warn("[useProjects] duplicate project id in response, dropping", item.id);
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
    [listStatus, user]
  );

  useEffect(() => {
    if (authLoading || !authReady) return;
    if (!user) {
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
    // Fresh identity or a `status` prop change — reset all pagination state
    // before fetching page 1. Deliberately keyed on `user?.uid`, not the
    // full `user` object — a token refresh must not wipe scroll progress.
    seenIdsRef.current = new Set();
    cursorRef.current = undefined;
    setItems([]);
    setHasMore(false);
    setLoadingMore(false);
    setLoadMoreErrorCode(null);
    void fetchPage({ cursor: undefined, isLoadMore: false, currentUser: user });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, authReady, user?.uid, listStatus]);

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
