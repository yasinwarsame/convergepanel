/**
 * Approval Workflow, Phase 9C.1 — client-safe typed contract + fetch
 * helper for `GET /api/workspaces/{workspaceId}/review-queue`.
 *
 * Deliberately does NOT import `lib/workspaces/reviewQueue.ts` (guarded by
 * `"server-only"`, and Firebase-Admin-adjacent) — the row shape below is a
 * hand-mirrored, client-safe copy of that file's own `ReviewQueueRow`
 * export. Kept in exact field-for-field sync with it; any future backend
 * DTO change must be reflected here deliberately, not silently drift.
 *
 * `authedFetch()` only — no raw `fetch`, no SWR, no React Query, no
 * direct Firestore access from the browser.
 */

"use client";

import type { User } from "firebase/auth";
import { authedFetch } from "./authedFetch";

export type ReviewQueueView = "assigned_to_me" | "needs_review" | "changes_requested" | "overdue" | "recently_approved";

export type ReviewQueueAssignmentState = "unassigned" | "actionable" | "stale";

export interface WorkspaceReviewQueueRow {
  runId: string;
  workspaceId: string;
  projectId: string | null;
  runLabel: string;
  reviewStatus: string;
  createdAt: string;
  reviewedAt: string | null;
  assignment: {
    assignedReviewerUserId: string | null;
    assignedReviewerDisplayName: string | null;
    dueAt: string | null;
    state: ReviewQueueAssignmentState;
  };
  isAssignedToMe: boolean;
  isOverdue: boolean;
}

export interface WorkspaceReviewQueuePage {
  items: WorkspaceReviewQueueRow[];
  hasMore: boolean;
  nextCursor: string | null;
  viewerActions: { canManageReviews: boolean };
}

/** `undefined` = all Projects (no filter). `null` = canonical Unfiled (`projectId === null`). A non-empty string = one specific Project id. */
export type ReviewQueueProjectFilter = string | null | undefined;

export const DEFAULT_REVIEW_QUEUE_LIMIT = 25;

export function buildReviewQueueSearchParams(args: { view: ReviewQueueView; projectFilter: ReviewQueueProjectFilter; cursor?: string | null; limit?: number }): URLSearchParams {
  const params = new URLSearchParams();
  params.set("view", args.view);
  if (args.projectFilter === null) {
    params.set("scope", "unfiled");
  } else if (typeof args.projectFilter === "string") {
    params.set("projectId", args.projectFilter);
  }
  params.set("limit", String(args.limit ?? DEFAULT_REVIEW_QUEUE_LIMIT));
  if (args.cursor) params.set("cursor", args.cursor);
  return params;
}

/** `project` URL-search-param round-trip: absent or `"all"` -> `undefined`; `"unfiled"` -> `null`; anything else -> that literal Project id string. Never trusted as authorization — purely a display/query filter. */
export function parseProjectFilterParam(raw: string | null): ReviewQueueProjectFilter {
  if (raw === null || raw === "all") return undefined;
  if (raw === "unfiled") return null;
  return raw;
}

export function projectFilterToParamValue(filter: ReviewQueueProjectFilter): string {
  if (filter === undefined) return "all";
  if (filter === null) return "unfiled";
  return filter;
}

function isValidRow(value: unknown): value is WorkspaceReviewQueueRow {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.runId !== "string" || typeof r.runLabel !== "string" || typeof r.reviewStatus !== "string") return false;
  if (typeof r.createdAt !== "string") return false;
  const a = r.assignment as Record<string, unknown> | undefined;
  if (typeof a !== "object" || a === null) return false;
  if (typeof a.state !== "string") return false;
  if (typeof r.isAssignedToMe !== "boolean" || typeof r.isOverdue !== "boolean") return false;
  return true;
}

/** Structural response guard — this app doesn't silently trust arbitrary JSON from its own API (matching every other typed client parser in this codebase). Returns `null` on any shape mismatch; callers treat that identically to a network error. */
export function parseWorkspaceReviewQueueResponse(data: unknown): WorkspaceReviewQueuePage | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.ok !== true) return null;
  if (!Array.isArray(d.items) || !d.items.every(isValidRow)) return null;
  if (typeof d.hasMore !== "boolean") return null;
  const viewerActions = d.viewerActions as Record<string, unknown> | undefined;
  return {
    items: d.items as WorkspaceReviewQueueRow[],
    hasMore: d.hasMore,
    nextCursor: typeof d.nextCursor === "string" ? d.nextCursor : null,
    viewerActions: { canManageReviews: viewerActions?.canManageReviews === true },
  };
}

export type FetchWorkspaceReviewQueueResult = { status: "ok"; page: WorkspaceReviewQueuePage } | { status: "not_found" } | { status: "error" };

/** Never exposes backend error codes/reasons to the caller — `not_found` (concealed denial, 403/404) and `error` (everything else, including a malformed response body) are the only two failure shapes callers see. */
export async function fetchWorkspaceReviewQueue(args: {
  workspaceId: string;
  user: User | null;
  authReady: boolean;
  view: ReviewQueueView;
  projectFilter: ReviewQueueProjectFilter;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FetchWorkspaceReviewQueueResult> {
  try {
    const params = buildReviewQueueSearchParams(args);
    const res = await authedFetch(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/review-queue?${params.toString()}`, {
      user: args.user,
      authReady: args.authReady,
      method: "GET",
      cache: "no-store",
      signal: args.signal,
    });
    if (res.status === 403 || res.status === 404) return { status: "not_found" };
    if (!res.ok) return { status: "error" };
    const json = await res.json().catch(() => null);
    const page = parseWorkspaceReviewQueueResponse(json);
    if (!page) return { status: "error" };
    return { status: "ok", page };
  } catch {
    return { status: "error" };
  }
}

export interface WorkspaceProjectOption {
  id: string;
  name: string;
}

/** One bounded call for the Project filter's name list — never a per-row lookup (Phase 9C.1 §97). Best-effort: a failure here degrades the filter/labels gracefully (falls back to raw-safe placeholders) rather than blocking the queue itself. */
export async function fetchWorkspaceProjectOptions(args: { workspaceId: string; user: User | null; authReady: boolean; signal?: AbortSignal }): Promise<WorkspaceProjectOption[]> {
  try {
    const res = await authedFetch(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/projects?limit=50`, {
      user: args.user,
      authReady: args.authReady,
      method: "GET",
      cache: "no-store",
      signal: args.signal,
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object" || !Array.isArray((json as Record<string, unknown>).items)) return [];
    const items = (json as Record<string, unknown>).items as unknown[];
    const options: WorkspaceProjectOption[] = [];
    for (const raw of items) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.id === "string" && typeof item.name === "string") {
        options.push({ id: item.id, name: item.name });
      }
    }
    return options;
  } catch {
    return [];
  }
}
