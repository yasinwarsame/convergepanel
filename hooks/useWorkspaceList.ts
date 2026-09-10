"use client";

/**
 * Phase 11B.5 — the global Team Workspace membership-discovery lifecycle behind
 * `WorkspaceSwitcher`.
 *
 * SELECTION DATA, NOT AUTHORIZATION. This hook knows a Workspace *exists*
 * because authenticated membership discovery returned it. It confers nothing:
 * every destination route still resolves its own access independently, and no
 * capability may be inferred from an item appearing here.
 *
 * Source is the existing `GET /api/workspaces` via `fetchWorkspaceList()` —
 * never client Firestore, never a route parameter, never
 * `teamWorkspacesUiEnabled` (which is self-service ROLLOUT ADMISSION and says
 * nothing about membership; Phase 11B.5-P0 decoupled the two).
 *
 * THE LIST MUST BE COMPLETE. The switcher contract is *all* active Team
 * Workspaces, and the API pages at 20, so a single page silently strands the
 * 21st membership. Paging runs until `hasMore === false`.
 *
 * TWO INDEPENDENT STALE-DATA DEFENCES, because they fail differently:
 *   - `AbortController` cancels the transport.
 *   - A monotonic generation counter rejects any result that still arrives —
 *     an already-resolved promise, or a response that raced the abort — so a
 *     late page belonging to a previous uid can never be committed to state.
 * Dropping either one leaves a real hole; the suite mutates each separately.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { fetchWorkspaceList, type WorkspaceListItem } from "@/lib/client/workspaceListClient";

export type WorkspaceListStatus = "idle" | "loading" | "ready" | "partial_error" | "error";

export interface UseWorkspaceListResult {
  /** Active Team memberships, in server order, deduplicated by workspaceId. */
  items: WorkspaceListItem[];
  status: WorkspaceListStatus;
  /** Re-runs the whole discovery lifecycle for the current uid. */
  retry: () => void;
}

/**
 * Hard bound on REQUESTS, deliberately not on memberships: it exists only so a
 * server that kept answering `hasMore: true` forever cannot spin the client. At
 * the current page size of 20 this still covers 1000 Workspaces, far beyond the
 * seat model, and exhausting it reports `partial_error` rather than pretending
 * the list is complete.
 */
export const WORKSPACE_LIST_MAX_PAGES = 50;

export function useWorkspaceList(): UseWorkspaceListResult {
  const { user, authReady } = useAuth();
  const [items, setItems] = useState<WorkspaceListItem[]>([]);
  const [status, setStatus] = useState<WorkspaceListStatus>("idle");
  const [retryTick, setRetryTick] = useState(0);

  const generationRef = useRef(0);
  /**
   * The effect depends on `uid`, never on the `user` OBJECT: a new object
   * identity on an unrelated auth re-render must not refetch, and neither must
   * a pathname change (TopNav is mounted once in the root layout and persists
   * across client navigation — membership does not change by navigating).
   */
  const userRef = useRef(user);
  userRef.current = user;

  const uid = user?.uid ?? null;

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();

    // Drop the previous identity's Workspaces IMMEDIATELY, before any await:
    // on a uid change or logout, another account's Workspace names must not
    // remain on screen for even one frame.
    setItems([]);

    if (!authReady || !uid) {
      setStatus("idle");
      return () => controller.abort();
    }

    setStatus("loading");

    void (async () => {
      const accumulated: WorkspaceListItem[] = [];
      const seenWorkspaceIds = new Set<string>();
      const consumedCursors = new Set<string>();
      let cursor: string | null = null;

      /**
       * No generation check here on purpose. Every caller is reached only after
       * the post-await check below, and no `await` sits between that check and
       * this commit — so a second check could never fire, and an unfalsifiable
       * guard is worse than none: it reads as protection while no test can
       * demonstrate it doing anything. The single checkpoint after each await is
       * the whole defence, and the suite kills its removal.
       */
      const settle = (nextStatus: WorkspaceListStatus) => {
        setItems(accumulated.slice());
        setStatus(nextStatus);
      };
      /** Keep what was actually verified; never present a truncated list as complete. */
      const degrade = () => settle(accumulated.length > 0 ? "partial_error" : "error");

      for (let page = 0; page < WORKSPACE_LIST_MAX_PAGES; page++) {
        const result = await fetchWorkspaceList({
          user: userRef.current,
          authReady: true,
          cursor,
          signal: controller.signal,
        });

        // Generation check AFTER every await — this is the defence that still
        // works when the response arrives despite the abort.
        if (generationRef.current !== generation) return;

        if (result.status !== "ok") {
          degrade();
          return;
        }

        for (const item of result.page.items) {
          if (seenWorkspaceIds.has(item.workspaceId)) continue; // first server occurrence wins
          seenWorkspaceIds.add(item.workspaceId);
          accumulated.push(item);
        }

        if (!result.page.hasMore) {
          settle("ready");
          return;
        }

        const nextCursor = result.page.nextCursor;
        // `hasMore` with no usable cursor, or a cursor already consumed, is a
        // malformed pagination contract. Stop — do not loop, and do not claim
        // completeness we cannot establish.
        if (!nextCursor || consumedCursors.has(nextCursor)) {
          degrade();
          return;
        }
        consumedCursors.add(nextCursor);
        cursor = nextCursor;
      }

      degrade();
    })();

    return () => {
      controller.abort();
    };
  }, [authReady, uid, retryTick]);

  const retry = useCallback(() => setRetryTick((n) => n + 1), []);

  return { items, status, retry };
}
