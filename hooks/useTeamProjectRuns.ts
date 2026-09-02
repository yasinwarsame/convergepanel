"use client";

/**
 * Team Projects UI, Phase 12A.2 — client abstraction for
 * `GET /api/workspaces/{workspaceId}/projects/{projectId}/runs`,
 * read-only. Structural mirror of `hooks/useProjectRuns.ts`'s
 * `authedFetch` + cursor-ref + monotonic-sequence-guard pattern, but
 * simpler: the Team endpoint's response has no `scope` confirmation
 * envelope (unlike Personal's `GET /api/user/project-runs`) — only
 * `{ok, items, hasMore, nextCursor?}` — so there is no second structural
 * check to perform beyond each item's own `projectId` matching what was
 * requested.
 *
 * Deliberately does NOT expose move/remove/assign actions (PHASE 12A.2
 * Section U/V — Team run→project (re)association UI is out of scope this
 * phase; there is no Team research composer yet for any of that to be
 * meaningful against). Read-only research list only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import type { ModelId } from "@/lib/types";

export interface TeamProjectRunSummary {
  id: string;
  at: string;
  question: string;
  selectedModels: ModelId[];
  status?: string;
  modelsOk?: number;
  modelsTotal?: number;
  synthesisConsensusScore?: number;
  governanceStatus?: "approved" | "needs_review" | "blocked";
  projectId: string | null;
}

export type TeamProjectRunsErrorCode =
  | "unauthorized"
  | "auth_error"
  | "team_workspace_not_found"
  | "team_workspace_unavailable"
  | "insufficient_capability"
  | "project_not_found"
  | "invalid_cursor"
  | "internal_error"
  | "network_error";

const KNOWN_ERROR_CODES: readonly TeamProjectRunsErrorCode[] = [
  "unauthorized",
  "auth_error",
  "team_workspace_not_found",
  "team_workspace_unavailable",
  "insufficient_capability",
  "project_not_found",
  "invalid_cursor",
  "internal_error",
];

export interface TeamProjectRunsPage {
  items: TeamProjectRunSummary[];
  hasMore: boolean;
  nextCursor?: string;
}

export type ParseTeamProjectRunsPageResult = { ok: true; page: TeamProjectRunsPage } | { ok: false; errorCode: TeamProjectRunsErrorCode };

/** Pure: an item whose own `projectId` doesn't exactly match what was requested fails the WHOLE page closed as `internal_error` — mirrors `parseProjectRunsPageResponse()`'s identical policy. */
function isValidTeamProjectRunItem(item: unknown, expectedProjectId: string): item is TeamProjectRunSummary {
  if (typeof item !== "object" || item === null) return false;
  const c = item as Record<string, unknown>;
  return typeof c.id === "string" && c.id.length > 0 && typeof c.question === "string" && c.projectId === expectedProjectId;
}

export function parseTeamProjectRunsPageResponse(outcome: { ok: boolean; body: unknown; expectedProjectId: string }): ParseTeamProjectRunsPageResult {
  const body = outcome.body as { ok?: unknown; items?: unknown; hasMore?: unknown; nextCursor?: unknown; errorCode?: unknown } | null;
  if (
    outcome.ok &&
    body?.ok === true &&
    Array.isArray(body.items) &&
    typeof body.hasMore === "boolean" &&
    body.items.every((item) => isValidTeamProjectRunItem(item, outcome.expectedProjectId))
  ) {
    return {
      ok: true,
      page: {
        items: body.items as TeamProjectRunSummary[],
        hasMore: body.hasMore,
        nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : undefined,
      },
    };
  }
  const errorCode = KNOWN_ERROR_CODES.find((code) => code === body?.errorCode) ?? "internal_error";
  return { ok: false, errorCode };
}

export function isDefinitiveEmptyTeamProjectRunsState(state: { status: "ready" | "loading" | "error"; items: readonly unknown[]; hasMore: boolean }): boolean {
  return state.status === "ready" && state.items.length === 0 && state.hasMore === false;
}

export interface UseTeamProjectRunsResult {
  items: TeamProjectRunSummary[];
  hasMore: boolean;
  status: "loading" | "ready" | "error";
  initialErrorCode: TeamProjectRunsErrorCode | null;
  loadingMore: boolean;
  loadMoreErrorCode: TeamProjectRunsErrorCode | null;
  loadMore: () => void;
  retryInitial: () => void;
  resetAndReloadFromStart: () => void;
}

export function useTeamProjectRuns(args: { workspaceId: string; projectId: string }): UseTeamProjectRunsResult {
  const { workspaceId, projectId } = args;
  const { user, loading: authLoading, authReady } = useAuth();

  const [items, setItems] = useState<TeamProjectRunSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [initialErrorCode, setInitialErrorCode] = useState<TeamProjectRunsErrorCode | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreErrorCode, setLoadMoreErrorCode] = useState<TeamProjectRunsErrorCode | null>(null);

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
        const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/runs`;
        const url = opts.cursor ? `${base}?cursor=${encodeURIComponent(opts.cursor)}` : base;
        const res = await authedFetch(url, { user: opts.currentUser, authReady: true, method: "GET", cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (seq !== seqRef.current) return;

        const result = parseTeamProjectRunsPageResponse({ ok: res.ok, body, expectedProjectId: projectId });
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

        const deduped: TeamProjectRunSummary[] = [];
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
    [workspaceId, projectId, user]
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
  }, [authLoading, authReady, user?.uid, workspaceId, projectId]);

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
