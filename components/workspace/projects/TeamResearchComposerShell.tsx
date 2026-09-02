"use client";

/**
 * Team Project Research Composer, Phase 12A.3 — the
 * `/workspace/team/{workspaceId}/projects/{projectId}/research/new` client
 * shell. `workspaceId`/`project` are resolved once, server-side, at the
 * page's own authorization gate (same pattern as every other Team Project
 * shell in this app) — this component never re-selects Workspace or
 * Project; both are fixed, non-editable context (Sections N/O — no
 * Workspace picker, no Project picker anywhere in this tree).
 *
 * Deliberately ORDINARY Team research only (Section D): question + model
 * selection + `POST /api/workspaces/{workspaceId}/runs` + result. No Deep
 * Research UI, no Claim/Video orchestration — those are separate product
 * surfaces this phase does not touch. `projectId` sent with every request
 * is always `project.id` — this component has no state that could produce
 * `projectId: null` or a different Project's id.
 *
 * Reuses `ModelPicker` (already genuinely generic — no Personal API calls,
 * no `app/page.tsx` dependency) and `getDefaultModelSelection()`
 * (`lib/utils/normalizeSelectedModels.ts`, a pure shared utility) for the
 * exact same default-selection convention Personal research already uses —
 * never an independently invented Team-only default.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useUserPlan } from "@/hooks/useUserPlan";
import { getPlanConfigById, type PlanId } from "@/lib/plans";
import { getDefaultModelSelection } from "@/lib/utils/normalizeSelectedModels";
import ModelPicker from "@/components/ModelPicker";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import TeamResearchResultView from "@/components/workspace/projects/TeamResearchResultView";
import { useTeamProjectResearch, type TeamResearchRunResult } from "@/hooks/useTeamProjectResearch";
import type { ModelId } from "@/lib/types";

/** Small, self-contained mirror of `app/page.tsx`'s own plan-id normalization (legacy "solo"/"pro" values) — not extracted from Personal code, just the same trivial literal mapping duplicated locally. */
function normalizePlanId(raw: string): PlanId {
  if (raw === "solo") return "lite";
  if (raw === "pro") return "full";
  if (raw === "free" || raw === "lite" || raw === "full") return raw;
  return "free";
}

export interface TeamResearchComposerProject {
  id: string;
  name: string;
}

export default function TeamResearchComposerShell({
  workspaceId,
  workspaceName,
  project,
  canReadAudit,
}: {
  workspaceId: string;
  workspaceName: string;
  project: TeamResearchComposerProject;
  canReadAudit: boolean;
}) {
  const { plan, loading: planLoading } = useUserPlan();
  const normalizedPlan = normalizePlanId((plan as string) || "free");
  const planConfig = getPlanConfigById(normalizedPlan);

  const [question, setQuestion] = useState("");
  const [selectedModels, setSelectedModels] = useState<ModelId[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<TeamResearchRunResult | null>(null);

  const { isSubmitting, submit } = useTeamProjectResearch({ workspaceId, projectId: project.id });

  useEffect(() => {
    if (!planLoading && selectedModels.length === 0) {
      setSelectedModels(getDefaultModelSelection(planConfig.maxModelsPerRun));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planLoading, planConfig.maxModelsPerRun]);

  const projectHref = `/workspace/team/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(project.id)}`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;

    const trimmed = question.trim();
    if (trimmed.length === 0) {
      setValidationError("Enter a question before running research.");
      return;
    }
    if (selectedModels.length < 2) {
      setValidationError("Select at least two models.");
      return;
    }
    setValidationError(null);
    setSubmitError(null);

    const outcome = await submit({ question: trimmed, selectedModels });
    if (outcome.status === "ok") {
      setResult(outcome.run);
    } else {
      setSubmitError(outcome.message);
    }
  }

  function handleStartAnother() {
    setResult(null);
    setSubmitError(null);
    setValidationError(null);
    setQuestion("");
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-cp-text">{workspaceName}</h1>
      </div>

      <WorkspaceNav workspaceId={workspaceId} active="projects" showAudit={canReadAudit} />

      <div className="mt-2">
        <p className="text-xs font-medium uppercase tracking-wide text-cp-faint">{project.name}</p>
        {/*
          Before/while composing: "Start research" (this is the permanent
          per-Project action's own page — not to be confused with the
          separate "Start Research" link on the Project detail page, which
          this heading has no effect on). After a successful run: show the
          actual submitted question (kept in `question` state, never
          cleared except by "Start another research") rather than a stale
          "Start research" label sitting above a completed result — falls
          back to a generic "Research results" only in the unreachable
          case `question` is somehow empty at that point.
        */}
        <h2 className="mt-1 text-xl font-semibold text-cp-text break-words">
          {result ? (question.trim().length > 0 ? question : "Research results") : "Start research"}
        </h2>
      </div>

      {!result && (
        <form onSubmit={handleSubmit} className="mt-6 rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
          <label htmlFor="team-research-question" className="block text-sm font-medium text-cp-text">
            What would you like to research?
          </label>
          <textarea
            id="team-research-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={isSubmitting}
            rows={5}
            placeholder="Ask a question for this Project's research panel…"
            className="mt-2 w-full rounded-lg border border-cp-border bg-cp-bg px-3 py-2 text-sm text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
          />

          <div className="mt-5">
            <ModelPicker selectedModels={selectedModels} onSelectionChange={setSelectedModels} plan={normalizedPlan} />
          </div>

          {(validationError || submitError) && (
            <p role="alert" className="mt-4 text-sm font-medium text-red-400">
              {validationError || submitError}
            </p>
          )}

          <div className="mt-5 flex gap-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
            >
              {isSubmitting ? "Running research…" : "Run research"}
            </button>
            <Link
              href={projectHref}
              className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
            >
              Back to Project
            </Link>
          </div>
        </form>
      )}

      {result && (
        <>
          <TeamResearchResultView run={result} />
          <div className="mt-4 flex gap-2">
            <Link
              href={projectHref}
              className="rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
            >
              Back to Project
            </Link>
            <button
              type="button"
              onClick={handleStartAnother}
              className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
            >
              Start another research
            </button>
          </div>
        </>
      )}
    </main>
  );
}
