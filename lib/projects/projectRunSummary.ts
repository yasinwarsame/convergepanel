/**
 * Project Read Foundation, Phase 7A — the browser-facing run summary DTO
 * for `GET /api/user/project-runs`. Field-for-field structural mirror of
 * `WorkspaceRunSummary`/`toSummary()` in
 * `app/api/user/workspace/runs/route.ts` (that route's conversion logic is
 * private/unexported inside a Next.js route file, not an importable
 * library module, so it's duplicated here rather than modified or
 * re-exported — Phase 6D's protected-systems boundary keeps that route
 * untouched) — plus one additive field, `projectId`, which Phase 7 needs
 * for its own assign/move/unassign controls. Every other field matches
 * exactly so Phase 7 UI can share one run-card component across the
 * Workspace and Project/Unfiled surfaces without two competing shapes.
 *
 * Deliberately does NOT expose `workspaceId`, `userId`, raw model output,
 * or governance internals merely because the Firestore document contains
 * them — same minimal-DTO discipline as `WorkspaceRunSummary`.
 */

import "server-only";
import type { ModelId } from "@/lib/types";
import type { QueryType } from "@/lib/adaptiveSchema/types";

export interface ProjectRunSummary {
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
  projectId: string | null;
}

function normalizeGovernanceStatus(v: unknown): "approved" | "needs_review" | "blocked" | undefined {
  if (v === "approved" || v === "needs_review" || v === "blocked") return v;
  return undefined;
}

/** Raw seconds/nanoseconds off a Firestore Timestamp — never `.toMillis()`, which truncates below millisecond precision. See `projectRunsCursor.ts`. */
export function firestoreSecondsNanos(value: unknown): { seconds: number; nanoseconds: number } {
  if (value && typeof value === "object" && "seconds" in value && "nanoseconds" in value) {
    const v = value as { seconds: unknown; nanoseconds: unknown };
    if (typeof v.seconds === "number" && typeof v.nanoseconds === "number") {
      return { seconds: v.seconds, nanoseconds: v.nanoseconds };
    }
  }
  return { seconds: 0, nanoseconds: 0 };
}

function firestoreMillisForDisplay(value: unknown): number {
  if (value && typeof value === "object" && "toMillis" in value && typeof (value as { toMillis: () => number }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  return 0;
}

/** `projectId` is passed in already-classified (never re-derived from raw `data.projectId` here) — the caller has already run `classifyProjectIdFieldState()` as part of its own integrity check and knows the semantic value is trustworthy. */
export function toProjectRunSummary(id: string, data: Record<string, unknown>, projectId: string | null): ProjectRunSummary {
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
    projectId,
  };
}
