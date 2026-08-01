"use client";

/**
 * Immutable Adaptive Review History and Admin Audit Integration —
 * read-only "Review History" section (docs/governance-decision-receipts-design.md
 * §27.11). Fetches `GET /api/teams/adaptive-runs/{runId}/history` only —
 * never writes, never offers a repair action. Renders only the compact,
 * metadata-only fields the history endpoint returns — never reviewer
 * identity, comment text, condition text, a decision ID, or a team ID
 * (none of those are even present in the response to begin with).
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import type { AdaptiveReviewHistoryResponseV1 } from "@/lib/governance/adaptiveHumanReviewHistory";
import { humanReviewStatusLabel } from "@/lib/governance/teamReviewLabels";

function formatDatetime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function AdaptiveReviewHistorySection({ runId, canonicalTerminal }: { runId: string; canonicalTerminal: boolean }) {
  const { user, authReady } = useAuth();
  const [items, setItems] = useState<AdaptiveReviewHistoryResponseV1["items"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!user || !authReady) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setUnavailable(false);
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const res = await authedFetch(`/api/teams/adaptive-runs/${encodeURIComponent(runId)}/history`, {
          user,
          authReady,
          method: "GET",
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          setUnavailable(true);
          setItems(null);
          return;
        }
        const json = (await res.json()) as AdaptiveReviewHistoryResponseV1;
        if (json.ok && json.version === 1) {
          setItems(json.items);
        } else {
          setUnavailable(true);
        }
      } catch {
        if (!cancelled) {
          setUnavailable(true);
          setItems(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, authReady, runId]);

  return (
    <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <h2 className="text-base font-bold text-cp-text">Review History</h2>

      {loading ? (
        <div className="mt-3 text-sm text-cp-muted" aria-live="polite">
          Loading history…
        </div>
      ) : unavailable ? (
        <p className="mt-3 text-sm text-cp-muted" role="status">
          Review history is temporarily unavailable.
        </p>
      ) : items && items.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {items.map((item, i) => (
            <li key={i} className="rounded-lg border border-cp-border bg-cp-raised p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-cp-text">{humanReviewStatusLabel(item.newStatus)}</span>
                <span className="text-xs text-cp-muted">Immutable decision record</span>
              </div>
              <p className="mt-1 text-xs text-cp-muted">Decided {formatDatetime(item.reviewedAt)}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-cp-muted">
                <span>{item.commentPresent ? "Comment provided" : "No comment provided"}</span>
                <span aria-hidden>&middot;</span>
                <span>
                  {item.conditionsCount} condition{item.conditionsCount === 1 ? "" : "s"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : canonicalTerminal ? (
        <p className="mt-3 rounded-lg bg-cp-raised px-3 py-2 text-xs text-cp-muted" role="status">
          The review decision is saved, but its history record is still being recorded.
        </p>
      ) : (
        <p className="mt-3 text-sm text-cp-muted" role="status">
          No history recorded yet.
        </p>
      )}
    </section>
  );
}
