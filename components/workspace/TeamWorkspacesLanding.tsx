"use client";

/**
 * Team Workspace Self-Service Onboarding — the `/workspace/team` client
 * shell. Zero-membership callers see an obvious "Create Workspace"
 * action (never a dead end); callers with one or more Workspaces see
 * that CTA alongside a list linking into each Workspace's Members page.
 * Never fetches member/invitation data itself — only Workspace names,
 * via the existing bounded/paginated `GET /api/workspaces` list (same
 * data source as `WorkspaceReviewsChooser`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { fetchWorkspaceList, type WorkspaceListItem } from "@/lib/client/workspaceListClient";
import { createTeamWorkspace } from "@/lib/client/workspaceTeamClient";
import ReviewErrorState from "@/components/teamGovernance/ReviewErrorState";

const GENERIC_ERROR_MESSAGE = "We couldn't load your Workspaces. Try again.";
const MAX_NAME_LENGTH = 200;

export default function TeamWorkspacesLanding() {
  const { user, authReady } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<WorkspaceListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const requestIdRef = useRef(0);
  const nameInputRef = useRef<HTMLInputElement>(null);

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

  const openCreateForm = useCallback(() => {
    setCreateError(null);
    setShowCreateForm(true);
    // Focus after the field mounts.
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }, []);

  const closeCreateForm = useCallback(() => {
    setShowCreateForm(false);
    setName("");
    setCreateError(null);
  }, []);

  const handleCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        setCreateError("Enter a name for your Workspace.");
        return;
      }
      if (trimmed.length > MAX_NAME_LENGTH) {
        setCreateError(`Workspace name must be ${MAX_NAME_LENGTH} characters or fewer.`);
        return;
      }
      setCreating(true);
      setCreateError(null);
      const result = await createTeamWorkspace({ user, authReady, name: trimmed });
      setCreating(false);
      if (result.status === "ok") {
        setShowCreateForm(false);
        setName("");
        // Phase 12A.1 — land the creator directly inside the Workspace
        // they just created, using ONLY the authoritative workspaceId the
        // creation response itself returned (never inferred from the
        // name, never re-derived by searching the list).
        router.push(`/workspace/team/${encodeURIComponent(result.workspace.workspaceId)}`);
      } else if (result.status === "invalid_name") {
        setCreateError("That Workspace name isn't valid. Try a shorter, plainer name.");
      } else {
        setCreateError("We couldn't create your Workspace. Please try again.");
      }
    },
    [name, user, authReady, router]
  );

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:py-14">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-cp-text">Team Workspaces</h1>
          <p className="mt-1 text-sm text-cp-muted">Create a Workspace to collaborate on research, projects, and reviews with your team.</p>
        </div>
        {!showCreateForm && (
          <button
            type="button"
            onClick={openCreateForm}
            className="inline-flex shrink-0 items-center justify-center rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
          >
            Create Workspace
          </button>
        )}
      </div>

      {showCreateForm && (
        <form onSubmit={handleCreate} className="mb-6 rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm" aria-label="Create Workspace">
          <label htmlFor="team-workspace-name" className="block text-sm font-medium text-cp-text">
            Workspace name
          </label>
          <input
            id="team-workspace-name"
            ref={nameInputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LENGTH}
            disabled={creating}
            placeholder="e.g. Research Team"
            className="mt-2 w-full rounded-lg border border-cp-border bg-cp-bg px-3 py-2 text-sm text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
          />
          {createError && (
            <p role="alert" className="mt-2 text-sm font-medium text-red-400">
              {createError}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={creating}
              className="rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create Workspace"}
            </button>
            <button
              type="button"
              onClick={closeCreateForm}
              disabled={creating}
              className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {status === "loading" && (
        <div role="status" className="rounded-xl border border-cp-border bg-cp-surface px-6 py-12 text-center text-sm text-cp-muted shadow-sm">
          Loading Workspaces…
        </div>
      )}

      {status === "error" && <ReviewErrorState message={GENERIC_ERROR_MESSAGE} onRetry={runQuery} />}

      {status === "ready" && items.length === 0 && !showCreateForm && (
        <div className="rounded-xl border border-cp-border bg-cp-raised px-6 py-12 text-center shadow-sm">
          <p className="text-sm text-cp-muted">You don&apos;t belong to any Team Workspace yet.</p>
          <button
            type="button"
            onClick={openCreateForm}
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
          >
            Create your first Workspace
          </button>
        </div>
      )}

      {status === "ready" && items.length > 0 && (
        <nav aria-label="Your Team Workspaces" className="rounded-xl border border-cp-border bg-cp-surface shadow-sm">
          <ul>
            {items.map((item) => (
              <li key={item.workspaceId} className="border-b border-cp-border-soft last:border-b-0">
                <Link
                  href={`/workspace/team/${encodeURIComponent(item.workspaceId)}/members`}
                  className="flex items-center justify-between px-4 py-3 text-sm font-medium text-cp-text transition-colors hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
                >
                  <span className="truncate">{item.name}</span>
                  <span aria-hidden="true" className="ml-3 text-cp-faint">
                    Members
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
