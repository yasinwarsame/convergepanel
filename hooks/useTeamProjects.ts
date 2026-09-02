"use client";

/**
 * Team Projects UI, Phase 12A.2 — client abstraction for
 * `GET /api/workspaces/{workspaceId}/projects` (active projects only —
 * no archived-status toggle in this phase, see PHASE 12A.2 Section K/L).
 * Structural mirror of `hooks/useProjects.ts`'s identical
 * `authedFetch` + pure response-parsing + cursor-ref +
 * monotonic-sequence-guard pattern, retargeted at the Team endpoint. A
 * deliberately separate hook, not a parameterized version of
 * `useProjects.ts` — that hook is documented as a Personal-scoped
 * structural mirror of `listProjectsForOwner()` and has no
 * workspace-id/fetcher injection point (see PHASE 12A.2's own source
 * inventory).
 *
 * Same load-bearing invariant as `useProjects()`: on every successful
 * page response, `items`/`hasMore`/`nextCursor` are adopted regardless of
 * `items.length` — a definitive empty state requires `hasMore === false`,
 * never merely `items.length === 0`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import { isValidUpdateTimeTokenShape, type UpdateTimeToken } from "@/lib/projects/updateTimeTokenClient";

export interface TeamProjectSummary {
  id: string;
  workspaceId: string;
  name: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  updateTime: UpdateTimeToken | null;
}

export type TeamProjectsListErrorCode =
  | "unauthorized"
  | "auth_error"
  | "team_workspace_not_found"
  | "insufficient_capability"
  | "invalid_status"
  | "invalid_cursor"
  | "internal_error"
  | "network_error";

const KNOWN_ERROR_CODES: readonly TeamProjectsListErrorCode[] = [
  "unauthorized",
  "auth_error",
  "team_workspace_not_found",
  "insufficient_capability",
  "invalid_status",
  "invalid_cursor",
  "internal_error",
];

export interface TeamProjectsListPage {
  items: TeamProjectSummary[];
  hasMore: boolean;
  nextCursor?: string;
}

export type ParseTeamProjectsListPageResult = { ok: true; page: TeamProjectsListPage } | { ok: false; errorCode: TeamProjectsListErrorCode };

/** Mirrors `isValidProjectSummaryItem()` — only the fields this UI actually renders/relies on. `updateTime` may be `null` (post-mutation projection-read failure) but never malformed. */
function isValidTeamProjectSummaryItem(item: unknown, expectedWorkspaceId: string): item is TeamProjectSummary {
  if (typeof item !== "object" || item === null) return false;
  const c = item as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    c.workspaceId === expectedWorkspaceId &&
    typeof c.name === "string" &&
    c.status === "active" &&
    (c.updateTime === null || isValidUpdateTimeTokenShape(c.updateTime))
  );
}

/** Pure: a single item whose `workspaceId` doesn't match the requested Workspace, or whose `status` isn't `"active"`, fails the WHOLE page closed as `internal_error` — mirrors `parseProjectsListPageResponse()`'s identical policy. */
export function parseTeamProjectsListPageResponse(outcome: { ok: boolean; body: unknown; expectedWorkspaceId: string }): ParseTeamProjectsListPageResult {
  const body = outcome.body as { ok?: unknown; items?: unknown; hasMore?: unknown; nextCursor?: unknown; errorCode?: unknown } | null;
  if (
    outcome.ok &&
    body?.ok === true &&
    Array.isArray(body.items) &&
    typeof body.hasMore === "boolean" &&
    body.items.every((item) => isValidTeamProjectSummaryItem(item, outcome.expectedWorkspaceId))
  ) {
    return {
      ok: true,
      page: {
        items: body.items as TeamProjectSummary[],
        hasMore: body.hasMore,
        nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : undefined,
      },
    };
  }
  const errorCode = KNOWN_ERROR_CODES.find((code) => code === body?.errorCode) ?? "internal_error";
  return { ok: false, errorCode };
}

export function isDefinitiveEmptyTeamProjectsState(state: { status: "ready" | "loading" | "error"; items: readonly unknown[]; hasMore: boolean }): boolean {
  return state.status === "ready" && state.items.length === 0 && state.hasMore === false;
}

export interface UseTeamProjectsResult {
  items: TeamProjectSummary[];
  hasMore: boolean;
  status: "loading" | "ready" | "error";
  initialErrorCode: TeamProjectsListErrorCode | null;
  loadingMore: boolean;
  loadMoreErrorCode: TeamProjectsListErrorCode | null;
  loadMore: () => void;
  retryInitial: () => void;
  /** The ONLY path that ever resets an in-progress cursor — called after a successful create so the newly created Project appears. */
  resetAndReloadFromStart: () => void;
}

export function useTeamProjects(args: { workspaceId: string }): UseTeamProjectsResult {
  const { workspaceId } = args;
  const { user, loading: authLoading, authReady } = useAuth();

  const [items, setItems] = useState<TeamProjectSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [initialErrorCode, setInitialErrorCode] = useState<TeamProjectsListErrorCode | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreErrorCode, setLoadMoreErrorCode] = useState<TeamProjectsListErrorCode | null>(null);

  const cursorRef = useRef<string | undefined>(undefined);
  const seenIdsRef = useRef<Set<string>>(new Set());
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
        const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/projects?status=active`;
        const url = opts.cursor ? `${base}&cursor=${encodeURIComponent(opts.cursor)}` : base;
        const res = await authedFetch(url, { user: opts.currentUser, authReady: true, method: "GET", cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (seq !== seqRef.current) return;

        const result = parseTeamProjectsListPageResponse({ ok: res.ok, body, expectedWorkspaceId: workspaceId });
        if (!result.ok) {
          if (opts.isLoadMore) {
            setLoadingMore(false);
            setLoadMoreErrorCode(result.errorCode);
          } else {
            setStatus("error");
            setInitialErrorCode(result.errorCode);
          }
          return;
        }

        const deduped: TeamProjectSummary[] = [];
        for (const item of result.page.items) {
          if (seenIdsRef.current.has(item.id)) continue;
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
    [workspaceId, user]
  );

  useEffect(() => {
    if (authLoading || !authReady) return;
    if (!user) {
      seqRef.current++;
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
    seenIdsRef.current = new Set();
    cursorRef.current = undefined;
    setItems([]);
    setHasMore(false);
    setLoadingMore(false);
    setLoadMoreErrorCode(null);
    void fetchPage({ cursor: undefined, isLoadMore: false, currentUser: user });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, authReady, user?.uid, workspaceId]);

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
