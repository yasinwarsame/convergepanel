/**
 * Approval Workflow, Phase 9C.1-R1C — client-safe typed contract + fetch
 * helper for `GET /api/workspaces` (the bounded, paginated "Team
 * Workspaces I actively belong to" discovery/selection list). Backs
 * `WorkspaceReviewsChooser`, the multi-Workspace Reviews selector.
 *
 * `authedFetch()` only — no raw `fetch`, no SWR, no React Query, no
 * direct Firestore access from the browser, matching every other client
 * fetcher in this codebase.
 */

"use client";

import type { User } from "firebase/auth";
import { authedFetch } from "./authedFetch";

export interface WorkspaceListItem {
  workspaceId: string;
  name: string;
}

export interface WorkspaceListPage {
  items: WorkspaceListItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

function isValidItem(value: unknown): value is WorkspaceListItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.workspaceId === "string" && v.workspaceId.length > 0 && typeof v.name === "string";
}

/** Structural response guard — never a blind cast of arbitrary JSON. */
export function parseWorkspaceListResponse(data: unknown): WorkspaceListPage | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.ok !== true) return null;
  if (!Array.isArray(d.items) || !d.items.every(isValidItem)) return null;
  if (typeof d.hasMore !== "boolean") return null;
  return {
    items: d.items as WorkspaceListItem[],
    hasMore: d.hasMore,
    nextCursor: typeof d.nextCursor === "string" ? d.nextCursor : null,
  };
}

export type FetchWorkspaceListResult = { status: "ok"; page: WorkspaceListPage } | { status: "error" };

export async function fetchWorkspaceList(args: { user: User | null; authReady: boolean; cursor?: string | null; signal?: AbortSignal }): Promise<FetchWorkspaceListResult> {
  try {
    const params = new URLSearchParams();
    if (args.cursor) params.set("cursor", args.cursor);
    const res = await authedFetch(`/api/workspaces?${params.toString()}`, {
      user: args.user,
      authReady: args.authReady,
      method: "GET",
      cache: "no-store",
      signal: args.signal,
    });
    if (!res.ok) return { status: "error" };
    const json = await res.json().catch(() => null);
    const page = parseWorkspaceListResponse(json);
    if (!page) return { status: "error" };
    return { status: "ok", page };
  } catch {
    return { status: "error" };
  }
}
