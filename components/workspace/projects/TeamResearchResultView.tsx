"use client";

/**
 * Team Project Research Composer, Phase 12A.3 — a small, BOUNDED renderer
 * for a Team run's result, built directly from the authoritative
 * `POST /api/workspaces/{workspaceId}/runs` response shape
 * (`PanelResultPublic[]` + optional `governanceStatus`). Deliberately NOT
 * `ResultsDisplay.tsx` (the ~3,000-line Personal renderer with substantial
 * Personal-only orchestration — Deep Research tabs, Claim Verification,
 * adaptive-schema view routing, history integration) — importing that
 * wholesale here would materially broaden this phase's scope for no
 * product benefit, since 12A.3 v1 is explicitly ordinary Team research
 * only (no Deep Research expansion, no Claim/Video orchestration).
 *
 * Renders only what the ordinary-run response actually contains: each
 * model's own text/status, and the run's overall governance status via the
 * SAME `GovernanceChip` already used on the Team Project research list —
 * consistent styling, zero duplicated status-color logic.
 */

import { PANEL_MODELS, type PanelModelId } from "@/lib/panelModels";
import { GovernanceChip } from "@/components/shared/GovernanceChip";
import type { TeamResearchRunResult } from "@/hooks/useTeamProjectResearch";

function modelLabel(modelId: string): string {
  return PANEL_MODELS.find((m) => m.id === (modelId as PanelModelId))?.label ?? modelId;
}

export default function TeamResearchResultView({ run }: { run: TeamResearchRunResult }) {
  return (
    <section aria-labelledby="team-research-result-heading" className="mt-6 rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="team-research-result-heading" className="text-sm font-semibold uppercase tracking-wide text-cp-muted">
          Research complete
        </h2>
        <GovernanceChip status={run.governanceStatus} />
      </div>

      <ul className="mt-4 space-y-4">
        {run.results.map((result) => (
          <li key={result.modelId} className="rounded-xl border-2 border-cp-border bg-cp-raised p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-cp-text">{modelLabel(result.modelId)}</span>
              {result.status !== "ok" && (
                <span className="rounded-full border border-cp-border bg-cp-surface px-2 py-0.5 text-xs font-medium text-cp-muted">
                  {result.status === "substituted" ? "Substituted model" : "Failed"}
                </span>
              )}
            </div>
            {result.status === "failed" ? (
              <p className="mt-2 text-sm text-cp-muted">{result.error?.message ?? "This model did not return a response."}</p>
            ) : (
              <p className="mt-2 whitespace-pre-wrap text-sm text-cp-text">{result.rawTextFull}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
