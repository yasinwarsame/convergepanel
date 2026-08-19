"use client";

/**
 * Phase 7E-B — client abstraction for `GET /api/user/project-runs?projectId=`.
 * Structural mirror of `useUnfiledRuns()` (cursor-ref + monotonic-sequence-
 * guard + `authedFetch` pattern), but with a materially stricter integrity
 * policy: a status-scope-mismatch or a projectId-mismatch row is a
 * structural problem worth failing the WHOLE page closed, mirroring
 * `parseProjectsListPageResponse()`'s policy (`hooks/useProjects.ts`) —
 * deliberately NOT `useUnfiledRuns()`'s own per-item silent-drop-and-
 * continue for a stray non-null `projectId`. The reasoning is the same
 * one that module documents: a query that's supposed to be scoped to
 * exactly one Project returning something that violates that scope is
 * itself the structural problem, not an isolated bad row to quietly skip
 * past.
 *
 * Two independent things are validated, both fail-closed:
 *  1. the response's own `scope` envelope — `scope.type === "project"` and
 *     `scope.project.id === projectId` (the server's own confirmation of
 *     what it thinks it just served).
 *  2. every returned run's own `projectId` field — `=== projectId` exactly
 *     (mirrors the server's own `listProjectRunsForOwner.ts` integrity
 *     check; this is defense-in-depth on top of an already-enforced
 *     server guarantee, never the primary guarantee itself).
 *
 * Duplicate run ids across pages are still silently deduped (not an
 * integrity violation, just accidental repetition) — same `seenIdsRef`
 * pattern as `useUnfiledRuns()`/`useProjects()`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import type { ProjectRunSummary } from "@/lib/projects/projectRunSummary";
export type { ProjectRunSummary };

export type ProjectRunsErrorCode =
  | "unauthorized"
  | "auth_error"
  | "projects_disabled"
  | "project_not_found"
  | "project_unavailable"
  | "workspace_unavailable"
  | "workspace_invalid"
  | "workspace_missing"
  | "invalid_cursor"
  | "internal_error"
  | "network_error";

const KNOWN_ERROR_CODES: readonly ProjectRunsErrorCode[] = [
  "unauthorized",
  "auth_error",
  "projects_disabled",
  "project_not_found",
  "project_unavailable",
  "workspace_unavailable",
  "workspace_invalid",
  "workspace_missing",
  "invalid_cursor",
  "internal_error",
];

export interface ProjectRunsPage {
  items: ProjectRunSummary[];
  hasMore: boolean;
  nextCursor?: string;
}

export type ParseProjectRunsPageResult = { ok: true; page: ProjectRunsPage } | { ok: false; errorCode: ProjectRunsErrorCode };

/** Pure: the response's own confirmation of what it served must agree with what was requested — never trusted merely because the HTTP call as a whole succeeded. */
function isValidProjectScopeEnvelope(scope: unknown, expectedProjectId: string): boolean {
  if (typeof scope !== "object" || scope === null) return false;
  const c = scope as Record<string, unknown>;
  if (c.type !== "project") return false;
  const project = c.project;
  if (typeof project !== "object" || project === null) return false;
  const p = project as Record<string, unknown>;
  return typeof p.id === "string" && p.id === expectedProjectId && typeof p.name === "string" && (p.status === "active" || p.status === "archived");
}

/** Pure: minimal structural + exact-scope validation for a single returned run item — mirrors `isValidProjectSummaryItem()` in `hooks/useProjects.ts`. */
function isValidAssignedRunItem(item: unknown, expectedProjectId: string): item is ProjectRunSummary {
  if (typeof item !== "object" || item === null) return false;
  const c = item as Record<string, unknown>;
  return typeof c.id === "string" && c.id.length > 0 && c.projectId === expectedProjectId;
}

/**
 * Pure: a malformed/absent `items`/`hasMore` on a nominally-`ok` response,
 * a contradictory `scope` envelope, or ANY item whose `projectId` doesn't
 * exactly match `expectedProjectId` fails the WHOLE page closed as
 * `internal_error` — never a synthesized page shape, never a partially-
 * filtered one.
 */
export function parseProjectRunsPageResponse(outcome: { ok: boolean; body: unknown; expectedProjectId: string }): ParseProjectRunsPageResult {
  const body = outcome.body as { ok?: unknown; items?: unknown; hasMore?: unknown; nextCursor?: unknown; errorCode?: unknown; scope?: unknown } | null;
  if (
    outcome.ok &&
    body?.ok === true &&
    Array.isArray(body.items) &&
    typeof body.hasMore === "boolean" &&
    isValidProjectScopeEnvelope(body.scope, outcome.expectedProjectId) &&
    body.items.every((item) => isValidAssignedRunItem(item, outcome.expectedProjectId))
  ) {
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

/** Pure: the ONLY condition allowed to render a Project detail page's definitive empty state. */
export function isDefinitiveEmptyProjectRunsState(state: { status: "ready" | "loading" | "error"; items: readonly unknown[]; hasMore: boolean }): boolean {
  return state.status === "ready" && state.items.length === 0 && state.hasMore === false;
}

export interface UseProjectRunsResult {
  items: ProjectRunSummary[];
  hasMore: boolean;
  status: "loading" | "ready" | "error";
  initialErrorCode: ProjectRunsErrorCode | null;
  loadingMore: boolean;
  loadMoreErrorCode: ProjectRunsErrorCode | null;
  loadMore: () => void;
  retryInitial: () => void;
  resetAndReloadFromStart: () => void;
}

const PROJECT_RUNS_ENDPOINT = "/api/user/project-runs";

export function useProjectRuns(projectId: string): UseProjectRunsResult {
  const { user, loading: authLoading, authReady } = useAuth();

  const [items, setItems] = useState<ProjectRunSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [initialErrorCode, setInitialErrorCode] = useState<ProjectRunsErrorCode | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreErrorCode, setLoadMoreErrorCode] = useState<ProjectRunsErrorCode | null>(null);

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
        const base = `${PROJECT_RUNS_ENDPOINT}?projectId=${encodeURIComponent(projectId)}`;
        const url = opts.cursor ? `${base}&cursor=${encodeURIComponent(opts.cursor)}` : base;
        const res = await authedFetch(url, { user: opts.currentUser, authReady: true, method: "GET", cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (seq !== seqRef.current) return; // superseded — never apply a stale response

        const result = parseProjectRunsPageResponse({ ok: res.ok, body, expectedProjectId: projectId });
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
          if (seenIdsRef.current.has(item.id)) {
            if (process.env.NODE_ENV !== "production") {
              console.warn("[useProjectRuns] duplicate run id in response, dropping", item.id);
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
    [projectId, user]
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
  }, [authLoading, authReady, user?.uid, projectId]);

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
