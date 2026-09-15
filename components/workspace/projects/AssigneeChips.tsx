"use client";

/**
 * Project/Research Assignment (D4/D7) — read-only assignee chips shared by
 * the Team Project list row and the Team Project detail header. Renders
 * the server-resolved display name (never a uid) and marks a `stale`
 * assignee (no longer an eligible member) explicitly rather than hiding
 * it — history is preserved, the marker is honest.
 */

export interface AssigneeChipItem {
  uid: string;
  displayName: string;
  state: "active" | "stale";
}

export function AssigneeChips({ assignees, emptyLabel = null }: { assignees: readonly AssigneeChipItem[]; emptyLabel?: string | null }) {
  if (assignees.length === 0) {
    return emptyLabel ? <span className="text-xs text-cp-faint">{emptyLabel}</span> : null;
  }
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Assignees">
      {assignees.map((a) => (
        <li
          key={a.uid}
          className={`rounded-full border px-2 py-0.5 text-xs ${a.state === "stale" ? "border-cp-border bg-cp-raised text-cp-faint line-through" : "border-cp-border bg-cp-primary-soft text-cp-text"}`}
          title={a.state === "stale" ? "No longer eligible" : undefined}
        >
          {a.displayName}
          {a.state === "stale" ? <span className="sr-only"> (no longer eligible)</span> : null}
        </li>
      ))}
    </ul>
  );
}
