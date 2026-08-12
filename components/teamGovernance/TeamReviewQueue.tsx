"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — the team-review
 * queue page body. Read-only: fetches `/api/teams/runs?version=1&...` and
 * renders the result. Never calls the decision route, never renders a
 * mutation control (§25.24 — the strict read-only guarantee for this
 * step).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { useUserPlan } from "@/hooks/useUserPlan";
import type { TeamRunListResponseV1 } from "@/lib/governance/teamRunListContract";
import type { EnrichedTeamRunListItemV1, EnrichedTeamRunListResponseV1 } from "@/lib/governance/teamReviewQueueEnrichment";
import TeamReviewFilters, { TeamReviewQueueFiltersState } from "./TeamReviewFilters";
import TeamReviewListItem from "./TeamReviewListItem";
import ReviewEmptyState from "./ReviewEmptyState";
import ReviewErrorState from "./ReviewErrorState";

function BackNav() {
  return (
    <Link
      href="/"
      className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-cp-text transition-colors hover:text-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 rounded"
    >
      <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
      Back to research and claim verification
    </Link>
  );
}

function filtersFromSearchParams(params: URLSearchParams): TeamReviewQueueFiltersState {
  const kind = params.get("kind");
  const flagged = params.get("flagged");
  const reviewable = params.get("reviewable");
  return {
    kind: kind === "legacy" || kind === "adaptive" ? kind : "all",
    flagged: flagged === "true" || flagged === "false" ? flagged : "any",
    reviewable: reviewable === "true" || reviewable === "false" ? reviewable : "any",
  };
}

export default function TeamReviewQueue() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading, authReady } = useAuth();
  const { teamRole, loading: planLoading, teamId } = useUserPlan();

  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams]);
  const page = useMemo(() => {
    const raw = Number(searchParams.get("page") ?? "1");
    return Number.isInteger(raw) && raw >= 1 ? raw : 1;
  }, [searchParams]);

  const [items, setItems] = useState<EnrichedTeamRunListItemV1[]>([]);
  const [pagination, setPagination] = useState<TeamRunListResponseV1["pagination"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const buildQuery = useCallback(() => {
    const q = new URLSearchParams({ version: "1", page: String(page), limit: "25" });
    if (filters.kind !== "all") q.set("kind", filters.kind);
    if (filters.flagged !== "any") q.set("flagged", filters.flagged);
    if (filters.reviewable !== "any") q.set("reviewable", filters.reviewable);
    return q;
  }, [filters, page]);

  const load = useCallback(
    async (opts?: { manual?: boolean }) => {
      if (!user || !authReady) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (opts?.manual) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const res = await authedFetch(`/api/teams/runs?${buildQuery().toString()}`, {
          user,
          authReady,
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        if (!res.ok) {
          if (res.status === 403) {
            setError("You don't have access to the team review queue.");
          } else {
            setError("The review queue is temporarily unavailable. Please try again.");
          }
          setItems([]);
          setPagination(null);
          return;
        }

        const data = (await res.json()) as EnrichedTeamRunListResponseV1;
        if (data.ok && data.version === 1) {
          setItems(data.items);
          setPagination(data.pagination);
        } else {
          setError("The review queue is temporarily unavailable. Please try again.");
          setItems([]);
          setPagination(null);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError("The review queue is temporarily unavailable. Please try again.");
        setItems([]);
        setPagination(null);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [user, authReady, buildQuery]
  );

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authReady, filters.kind, filters.flagged, filters.reviewable, page]);

  const isAdmin = teamRole === "owner" || teamRole === "admin";

  const updateFilters = (next: TeamReviewQueueFiltersState) => {
    const q = new URLSearchParams();
    if (next.kind !== "all") q.set("kind", next.kind);
    if (next.flagged !== "any") q.set("flagged", next.flagged);
    if (next.reviewable !== "any") q.set("reviewable", next.reviewable);
    q.set("page", "1");
    router.push(`/team/reviews?${q.toString()}`);
  };

  const updatePage = (nextPage: number) => {
    if (nextPage < 1) return;
    const q = new URLSearchParams(searchParams.toString());
    q.set("page", String(nextPage));
    router.push(`/team/reviews?${q.toString()}`);
  };

  if (authLoading || !authReady || planLoading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <BackNav />
        <div className="py-12 text-center text-cp-muted" aria-live="polite">
          <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-cp-accent border-t-transparent" aria-hidden />
          <p className="mt-4 text-sm">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <BackNav />
        <ReviewEmptyState title="Sign in required" message="Please sign in to view your team's review queue." />
      </div>
    );
  }

  if (!teamId) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <BackNav />
        <ReviewEmptyState title="No team" message="You're not currently a member of a team." />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <BackNav />
        <ReviewEmptyState title="Insufficient permissions" message="Only team owners and admins can view the review queue." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 pb-20">
      <BackNav />

      <header className="mb-6 border-b border-cp-border pb-6">
        <h1 className="text-2xl font-bold text-cp-text md:text-3xl">Team Reviews</h1>
        <p className="mt-2 text-cp-text/75">Read-only review queue for your team&apos;s adaptive and legacy runs.</p>
      </header>

      <div className="mb-6">
        <TeamReviewFilters
          filters={filters}
          onChange={updateFilters}
          onRefresh={() => void load({ manual: true })}
          refreshing={refreshing}
          page={pagination?.page ?? page}
          hasNextPage={pagination?.hasNextPage ?? false}
          hasPreviousPage={pagination?.hasPreviousPage ?? false}
          onPageChange={updatePage}
        />
      </div>

      {loading ? (
        <div className="py-12 text-center text-cp-muted" aria-live="polite">
          <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-cp-accent border-t-transparent" aria-hidden />
          <p className="mt-4 text-sm">Loading queue…</p>
        </div>
      ) : error ? (
        <ReviewErrorState message={error} onRetry={() => void load({ manual: true })} />
      ) : items.length === 0 ? (
        pagination && pagination.total === 0 && page === 1 ? (
          <ReviewEmptyState
            title={filters.kind === "all" && filters.flagged === "any" && filters.reviewable === "any" ? "No review items" : "No filter matches"}
            message={
              filters.kind === "all" && filters.flagged === "any" && filters.reviewable === "any"
                ? "There are no runs in the team review queue yet."
                : "No runs match the current filter. Try a different combination."
            }
          />
        ) : (
          <ReviewEmptyState title="No results on this page" message="Try a previous page or a different filter." />
        )
      ) : (
        <ul className="space-y-3" aria-live="polite">
          {items.map((item) => (
            <TeamReviewListItem key={item.teamRunId} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
