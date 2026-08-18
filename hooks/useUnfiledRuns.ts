"use client";

/**
 * Phase 7C — client abstraction for `GET /api/user/project-runs?scope=unfiled`.
 * Structural mirror of `useWorkspaceRuns()`, applied to the Unfiled-scoped
 * Project-runs endpoint. Always requests `scope=unfiled` — never `projectId`
 * — so `missing_scope`/`ambiguous_scope`/`unknown_scope` are unreachable
 * from this hook by construction and are deliberately not modeled in
 * `UnfiledRunsErrorCode`.
 *
 * `ProjectRunSummary` is imported as a type-only import from the
 * `"server-only"`-guarded `lib/projects/projectRunSummary.ts` — safe here
 * because `import type` is fully erased at compile time and never pulls in
 * the runtime module, exactly like `useWorkspaceRuns()`'s existing
 * `import type { WorkspaceRunSummary } from "@/app/api/user/workspace/runs/route"`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import type { ProjectRunSummary } from "@/lib/projects/projectRunSummary";
export type { ProjectRunSummary };

export type UnfiledRunsErrorCode =
  | "unauthorized"
  | "auth_error"
  | "projects_disabled"
  | "workspace_unavailable"
  | "workspace_invalid"
  | "workspace_missing"
  | "invalid_cursor"
  | "internal_error"
  | "network_error";

const KNOWN_ERROR_CODES: readonly UnfiledRunsErrorCode[] = [
  "unauthorized",
  "auth_error",
  "projects_disabled",
  "workspace_unavailable",
  "workspace_invalid",
  "workspace_missing",
  "invalid_cursor",
  "internal_error",
];

export interface UnfiledRunsPage {
  items: ProjectRunSummary[];
  hasMore: boolean;
  nextCursor?: string;
}

export type ParseUnfiledRunsPageResult = { ok: true; page: UnfiledRunsPage } | { ok: false; errorCode: UnfiledRunsErrorCode };

/** Pure: mirrors `parseWorkspaceRunsPageResponse()` — a malformed/absent `items`/`hasMore` on a nominally-`ok` response is `internal_error`, never a synthesized page shape. The response's `scope` field is not consumed here (always `{type:"unfiled"}` for this hook by construction). */
export function parseUnfiledRunsPageResponse(outcome: { ok: boolean; body: unknown }): ParseUnfiledRunsPageResult {
  const body = outcome.body as { ok?: unknown; items?: unknown; hasMore?: unknown; nextCursor?: unknown; errorCode?: unknown } | null;
  if (outcome.ok && body?.ok === true && Array.isArray(body.items) && typeof body.hasMore === "boolean") {
    return {
      ok: true,
      page: {
        items: body.items as ProjectRunSummary[],
        hasMore: body.hasMore,
        nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : undefined,
      },
    };
  }
  const errorCode = KNOWN_ERROR_CODES.find((code) => code === body?.errorCode) ?? "internal_error";
  return { ok: false, errorCode };
}

/** Pure: the ONLY condition allowed to render the Unfiled section's definitive empty state. */
export function isDefinitiveEmptyUnfiledState(state: { status: "ready" | "loading" | "error"; items: readonly unknown[]; hasMore: boolean }): boolean {
  return state.status === "ready" && state.items.length === 0 && state.hasMore === false;
}

export interface UseUnfiledRunsResult {
  items: ProjectRunSummary[];
  hasMore: boolean;
  status: "loading" | "ready" | "error";
  initialErrorCode: UnfiledRunsErrorCode | null;
  loadingMore: boolean;
  loadMoreErrorCode: UnfiledRunsErrorCode | null;
  loadMore: () => void;
  retryInitial: () => void;
  resetAndReloadFromStart: () => void;
}

const UNFILED_ENDPOINT = "/api/user/project-runs?scope=unfiled";

export function useUnfiledRuns(): UseUnfiledRunsResult {
  const { user, loading: authLoading, authReady } = useAuth();

  const [items, setItems] = useState<ProjectRunSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [initialErrorCode, setInitialErrorCode] = useState<UnfiledRunsErrorCode | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreErrorCode, setLoadMoreErrorCode] = useState<UnfiledRunsErrorCode | null>(null);

  const cursorRef = useRef<string | undefined>(undefined);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seqRef = useRef(0);

  const fetchPage = useCallback(async (opts: { cursor: string | undefined; isLoadMore: boolean; currentUser: typeof user }) => {
    const seq = ++seqRef.current;
    if (opts.isLoadMore) {
      setLoadingMore(true);
      setLoadMoreErrorCode(null);
    } else {
      setStatus("loading");
      setInitialErrorCode(null);
    }

    try {
      const url = opts.cursor ? `${UNFILED_ENDPOINT}&cursor=${encodeURIComponent(opts.cursor)}` : UNFILED_ENDPOINT;
      const res = await authedFetch(url, { user: opts.currentUser, authReady: true, method: "GET", cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (seq !== seqRef.current) return; // superseded — never apply a stale response

      const result = parseUnfiledRunsPageResponse({ ok: res.ok, body });
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

      const deduped: ProjectRunSummary[] = [];
      for (const item of result.page.items) {
        // Defense in depth, on top of the server's own fail-whole-page-closed
        // integrity check (listProjectRunsForOwner.ts): this hook is
        // hardcoded to scope=unfiled, so every item's contract is
        // `projectId === null`. A row that somehow violates that is
        // rejected here too — never silently rendered as Unfiled, never
        // reinterpreted via a missing-field fallback. See item 12/34 of the
        // Phase 7C spec ("No client missing-field fallback").
        if (item.projectId !== null) {
          if (process.env.NODE_ENV !== "production") {
            console.warn("[useUnfiledRuns] non-null projectId on an Unfiled-scoped item, dropping", item.id);
          }
          continue;
        }
        if (seenIdsRef.current.has(item.id)) {
          if (process.env.NODE_ENV !== "production") {
            console.warn("[useUnfiledRuns] duplicate run id in response, dropping", item.id);
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
  }, []);

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
