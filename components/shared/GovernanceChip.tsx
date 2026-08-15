/**
 * Extracted verbatim from `app/page.tsx` (History tab) for Phase 5D reuse in
 * the Workspace research list — mechanical relocation only, pure and
 * presentation-only (single `status` prop, no hooks, no closure over any
 * caller's local state), so this move has zero effect on History's own
 * rendering. `PanelHistoryGovernanceStatus` and `WorkspaceRunSummary`'s
 * `governanceStatus` field share the exact same `"approved" | "needs_review"
 * | "blocked"` union, so both callers use this component unmodified.
 */

import type { PanelHistoryGovernanceStatus } from "@/lib/user/panelHistory";

export function GovernanceChip({ status }: { status?: PanelHistoryGovernanceStatus }) {
  if (!status) return null;
  const cfg =
    status === "approved"
      ? { dot: "bg-emerald-500", text: "Approved", textCls: "text-emerald-800" }
      : status === "blocked"
        ? { dot: "bg-red-500", text: "Blocked", textCls: "text-red-800" }
        : { dot: "bg-amber-500", text: "Review", textCls: "text-amber-900" };
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 self-center rounded-full border border-cp-border bg-cp-surface px-2 py-0.5 text-[10px] font-semibold ${cfg.textCls}`}
      aria-label={`Governance: ${cfg.text}`}
    >
      <span className={`h-2 w-2 rounded-full ${cfg.dot}`} aria-hidden />
      {cfg.text}
    </span>
  );
}
