"use client";

/**
 * Personal Reviewer Inbox + Action Flow — the reviewer-facing inbox page
 * (Part 6). Fetches GET /api/user/reviews, the only discovery mechanism
 * for personal assignments (no notifications exist — Part 25).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { schemaLabel } from "@/lib/governance/teamReviewLabels";
import type { PersonalReviewInboxItemV1, PersonalReviewInboxFilter } from "@/lib/governance/personalReviewInbox";
import PersonalReviewStatusBadge from "./PersonalReviewStatusBadge";

function formatDatetime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const FILTERS: { value: PersonalReviewInboxFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "all", label: "All" },
];

export default function PersonalReviewInbox() {
  const { user, authReady, loading: authLoading } = useAuth();
  const [filter, setFilter] = useState<PersonalReviewInboxFilter>("pending");
  const [items, setItems] = useState<PersonalReviewInboxItemV1[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user || !authReady) return;
    setLoading(true);
    setError(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch(`/api/user/reviews?filter=${encodeURIComponent(filter)}`, {
        user,
        authReady,
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403 ? "You don't have access to this page." : "Your reviews are temporarily unavailable. Please try again.");
        setItems(null);
        return;
      }
      const json = await res.json();
      if (json.ok) {
        setItems(json.items);
      } else {
        setError("Your reviews are temporarily unavailable. Please try again.");
        setItems(null);
      }
    } catch {
      setError("Your reviews are temporarily unavailable. Please try again.");
      setItems(null);
    } finally {
      setLoading(false);
    }
  }, [user, authReady, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 pb-20">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-cp-text">My Reviews</h1>
        <p className="mt-1 text-sm text-cp-muted">Reports someone has personally assigned to you for review.</p>
      </header>

      <div role="tablist" aria-label="Filter reviews" className="mb-4 flex gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent ${
              filter === f.value ? "bg-cp-primary-soft text-cp-primary" : "text-cp-muted hover:bg-cp-raised hover:text-cp-text"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {authLoading || !authReady || loading ? (
        <div className="py-12 text-center text-cp-muted" aria-live="polite">
          <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-cp-accent border-t-transparent" aria-hidden />
          <p className="mt-4 text-sm">Loading…</p>
        </div>
      ) : error ? (
        <div role="alert" className="rounded-xl border border-red-700/40 bg-red-900/10 p-4 text-sm text-red-400">
          {error}
        </div>
      ) : items && items.length > 0 ? (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.runId}>
              <Link
                href={`/reviews/${encodeURIComponent(item.runId)}`}
                className="block rounded-xl border border-cp-border bg-cp-surface p-4 shadow-sm transition-colors hover:border-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-cp-text">{schemaLabel(item.schemaId)}</span>
                  <PersonalReviewStatusBadge status={item.status} />
                  <time className="ml-auto shrink-0 text-xs text-cp-muted" dateTime={item.assignedAt}>
                    Assigned {formatDatetime(item.assignedAt)}
                  </time>
                </div>
                <p className="mt-2 text-sm leading-snug text-cp-text">{item.title}</p>
                <p className="mt-2 text-xs text-cp-muted">
                  Assigned by {item.ownerDisplayName}
                  {item.completedAt ? <> &middot; Completed {formatDatetime(item.completedAt)}</> : null}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-cp-border bg-cp-raised p-6 text-center text-sm text-cp-muted">
          {filter === "pending" ? "No reviews are waiting on you right now." : filter === "completed" ? "You haven't completed any reviews yet." : "No reports have been assigned to you yet."}
        </div>
      )}
    </div>
  );
}
