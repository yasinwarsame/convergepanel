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
 *
 * Production hotfix — the shared panel-execution engine (`executeOrdinaryRun()`,
 * used identically by Personal and Team) can classify a query into a
 * structured-JSON adaptive schema regardless of which UI called it, so
 * `rawTextFull` sometimes IS a JSON payload (optionally wrapped in a
 * markdown ```json fence) rather than prose. This view still does not
 * consume the run response's separate `adaptive` field or the
 * `AdaptivePanelResponse` schema-aware rendering system — that remains
 * deliberately out of scope, unchanged from the original 12A.3 boundary.
 * This is presentation-only: if `rawTextFull` (after stripping an optional
 * fence, via the existing shared `stripJsonFences` helper) parses as a JSON
 * object/array, it's shown pretty-printed in a `<pre>` block instead of a
 * raw unformatted paragraph; any non-JSON text renders exactly as before.
 */

import { PANEL_MODELS, type PanelModelId } from "@/lib/panelModels";
import { GovernanceChip } from "@/components/shared/GovernanceChip";
import { stripJsonFences } from "@/lib/adaptiveSchema/util";
import type { TeamResearchRunResult } from "@/hooks/useTeamProjectResearch";

function modelLabel(modelId: string): string {
  return PANEL_MODELS.find((m) => m.id === (modelId as PanelModelId))?.label ?? modelId;
}

/**
 * Returns pretty-printed JSON text if `rawTextFull` (after stripping an
 * optional markdown fence) parses as a JSON object/array, else `null` — a
 * bare JSON-parseable scalar (e.g. a quoted string or a number) is
 * deliberately NOT treated as "structured" here, since real model output in
 * this shape is always an object/array.
 */
function formatIfJson(rawTextFull: string): string | null {
  const candidate = stripJsonFences(rawTextFull);
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(parsed, null, 2);
    }
    return null;
  } catch {
    return null;
  }
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
        {run.results.map((result) => {
          const prettyJson = result.status === "failed" ? null : formatIfJson(result.rawTextFull);
          return (
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
              ) : prettyJson !== null ? (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-cp-surface p-3 text-xs text-cp-text">{prettyJson}</pre>
              ) : (
                <p className="mt-2 whitespace-pre-wrap text-sm text-cp-text">{result.rawTextFull}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
