/**
 * Phase 7C — shared base run-summary serializer, extracted from
 * `app/api/user/workspace/runs/route.ts`'s private `toSummary()` (the
 * original, unmodified formula — this extraction is a mechanical move, not
 * a rewrite). Previously duplicated verbatim in
 * `lib/projects/projectRunSummary.ts` because Route Handler files can't
 * export private helpers for reuse; both consumers now share this one
 * implementation.
 *
 * `WorkspaceRunSummary` (workspace/runs route) is exactly `RunSummaryBase`.
 * `ProjectRunSummary` (project-runs route) is `RunSummaryBase` plus one
 * additive field, `projectId` — see `lib/projects/projectRunSummary.ts`.
 * Neither consumer's external response shape changes as a result of this
 * extraction.
 */

import "server-only";
import type { ModelId } from "@/lib/types";
import type { QueryType } from "@/lib/adaptiveSchema/types";

export type RunSummaryBase = {
  id: string;
  at: string;
  question: string;
  selectedModels: ModelId[];
  status?: string;
  modelsOk?: number;
  modelsTotal?: number;
  synthesisConsensusScore?: number;
  governanceStatus?: "approved" | "needs_review" | "blocked";
  hasAdaptiveOutput?: boolean;
  adaptiveSchemaId?: QueryType;
};

export function normalizeGovernanceStatus(v: unknown): "approved" | "needs_review" | "blocked" | undefined {
  if (v === "approved" || v === "needs_review" || v === "blocked") return v;
  return undefined;
}

/** Raw seconds/nanoseconds off a Firestore Timestamp — never `.toMillis()`, which truncates below millisecond precision. See `workspaceRunsCursor.ts`/`projectRunsCursor.ts`. */
export function firestoreSecondsNanos(value: unknown): { seconds: number; nanoseconds: number } {
  if (value && typeof value === "object" && "seconds" in value && "nanoseconds" in value) {
    const v = value as { seconds: unknown; nanoseconds: unknown };
    if (typeof v.seconds === "number" && typeof v.nanoseconds === "number") {
      return { seconds: v.seconds, nanoseconds: v.nanoseconds };
    }
  }
  return { seconds: 0, nanoseconds: 0 };
}

export function firestoreMillisForDisplay(value: unknown): number {
  if (value && typeof value === "object" && "toMillis" in value && typeof (value as { toMillis: () => number }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  return 0;
}

export function toRunSummaryBase(id: string, data: Record<string, unknown>): RunSummaryBase {
  const sortKey = firestoreMillisForDisplay(data.createdAt);
  const perModel =
    (data.runDocument as { perModel?: unknown[] } | undefined)?.perModel ??
    (data.resultsCompact as { perModel?: unknown[] } | undefined)?.perModel;
  const modelsTotal = Array.isArray(perModel)
    ? perModel.length
    : Array.isArray(data.selectedModels)
      ? (data.selectedModels as unknown[]).length
      : 0;
  const modelsOk = Array.isArray(perModel)
    ? (perModel as { status?: string }[]).filter((p) => p.status === "ok").length
    : undefined;

  const synSum = data.synthesisConsensusSummary as { overallConsensusScore?: number } | undefined;
  const synthesisConsensusScore = typeof synSum?.overallConsensusScore === "number" ? synSum.overallConsensusScore : undefined;

  const adaptiveOutput = data.adaptiveOutput as { schemaId?: unknown } | undefined;
  const hasAdaptiveOutput = !!adaptiveOutput && typeof adaptiveOutput.schemaId === "string";

  return {
    id,
    at: new Date(sortKey || Date.now()).toISOString(),
    question: String(data.question ?? ""),
    selectedModels: (Array.isArray(data.selectedModels) ? data.selectedModels : []) as ModelId[],
    status: typeof data.status === "string" ? data.status : undefined,
    modelsOk,
    modelsTotal: modelsTotal || undefined,
    synthesisConsensusScore,
    governanceStatus: normalizeGovernanceStatus(data.governanceStatus),
    ...(hasAdaptiveOutput ? { hasAdaptiveOutput, adaptiveSchemaId: adaptiveOutput!.schemaId as QueryType } : {}),
  };
}
