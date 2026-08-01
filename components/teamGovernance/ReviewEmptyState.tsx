"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — a plain, parameterized
 * empty-state block for the team-review queue. No hidden dependency on any
 * particular data shape — just a heading and a message, matching this
 * repository's convention of hand-built, inline empty states (no shared
 * EmptyState component exists elsewhere to reuse — confirmed in the Part
 * E1.1 audit).
 */

export default function ReviewEmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-xl border border-cp-border bg-cp-surface px-6 py-12 text-center shadow-sm" role="status">
      <p className="text-base font-semibold text-cp-text">{title}</p>
      <p className="mt-2 text-sm text-cp-muted">{message}</p>
    </div>
  );
}
