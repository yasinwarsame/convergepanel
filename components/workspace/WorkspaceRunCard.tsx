/**
 * Phase 5D — a single Workspace research row. Deliberately a new,
 * Workspace-scoped component rather than an extraction of History's row
 * (`app/page.tsx:2160-2261`) — that row branches on 3 item types
 * (research/verification/video) and reads 8+ pieces of `Home`'s local
 * state; Workspace only ever has one type, so this card is intentionally
 * simpler, not a generalization of History's. Visual treatment (date
 * format, status-line composition, governance chip, single-link-as-row)
 * mirrors History's established pattern verbatim — see
 * `docs/workspaces/phase5d-workspace-research-design.md` §30–36.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { GovernanceChip } from "@/components/shared/GovernanceChip";
import type { WorkspaceRunSummary } from "@/hooks/useWorkspaceRuns";

/**
 * Pure: mirrors History's exact status-line composition
 * (`app/page.tsx:2202-2219`) — `{modelsOk}/{modelsTotal} model responses`
 * (+ non-"complete" status suffix), "Run ended with an error" when
 * `status === "error"` with no counts, "Research panel" fallback
 * otherwise, `· Synthesis {score}/100` suffix when present. No new status
 * vocabulary — this composes exactly what History already shows.
 */
export function workspaceRunStatusLine(item: Pick<WorkspaceRunSummary, "status" | "modelsOk" | "modelsTotal" | "synthesisConsensusScore">): string {
  let base: string;
  if (item.modelsOk != null && item.modelsTotal != null) {
    base = `${item.modelsOk}/${item.modelsTotal} model responses`;
    if (item.status && item.status !== "complete") {
      base += ` · ${item.status}`;
    }
  } else if (item.status === "error") {
    base = "Run ended with an error";
  } else {
    base = "Research panel";
  }
  if (item.synthesisConsensusScore != null) {
    base += ` · Synthesis ${item.synthesisConsensusScore}/100`;
  }
  return base;
}

/**
 * Phase 7E-A — `actions` is an optional slot for Projects-context-only
 * controls (e.g. "Add to project"). Deliberately rendered as a SIBLING of
 * `Link`, never nested inside it — the whole row's report navigation is a
 * single `<a>`, and an interactive control nested inside an `<a>` would be
 * both invalid HTML and unreliable to click. When `actions` is omitted
 * (every existing caller: `/workspace`, Active/Archived-adjacent contexts),
 * rendering is byte-identical to before this prop existed — see this
 * component's own tests for the enforced "exactly one `<a>`, zero
 * `<button>`" invariant on that default path.
 */
export function WorkspaceRunCard({ item, actions }: { item: WorkspaceRunSummary; actions?: ReactNode }) {
  return (
    <li className="rounded-xl border-2 border-cp-border bg-cp-raised transition-colors hover:border-cp-accent hover:bg-cp-primary-soft">
      <Link href={`/?openResearchRun=${encodeURIComponent(item.id)}`} className="flex w-full items-start gap-3 px-3 py-3 text-left">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-cp-faint">{new Date(item.at).toLocaleString()}</span>
          </span>
          <span className="mt-1 block text-sm font-medium text-cp-text line-clamp-2">{item.question}</span>
          <span className="mt-1 block text-xs text-cp-muted">{workspaceRunStatusLine(item)}</span>
        </span>
        <GovernanceChip status={item.governanceStatus} />
      </Link>
      {actions && <div className="flex justify-end gap-2 border-t border-cp-border-soft px-3 py-2">{actions}</div>}
    </li>
  );
}
