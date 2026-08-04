"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — a plain, safe error
 * block. Never renders a raw API response, Firestore error, parser reason,
 * or stack trace — only the caller-supplied, already-sanitized message.
 */

export default function ReviewErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-cp-border bg-cp-surface px-6 py-10 text-center shadow-sm" role="alert" aria-live="polite">
      <p className="text-sm font-medium text-red-400">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
