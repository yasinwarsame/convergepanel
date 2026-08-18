/**
 * Project Read Foundation, Phase 7A — the browser-facing run summary DTO
 * for `GET /api/user/project-runs`. Field-for-field structural extension of
 * `WorkspaceRunSummary` (`app/api/user/workspace/runs/route.ts`): exactly
 * the shared `RunSummaryBase` (Phase 7C, `lib/runs/runSummary.ts`) plus one
 * additive field, `projectId`, which Phase 7 needs for its own assign/
 * move/unassign controls. Every other field matches exactly so Phase 7 UI
 * can share one run-card component across the Workspace and Project/
 * Unfiled surfaces without two competing shapes.
 *
 * Deliberately does NOT expose `workspaceId`, `userId`, raw model output,
 * or governance internals merely because the Firestore document contains
 * them — same minimal-DTO discipline as `WorkspaceRunSummary`.
 */

import "server-only";
import { firestoreSecondsNanos, toRunSummaryBase, type RunSummaryBase } from "@/lib/runs/runSummary";

export { firestoreSecondsNanos };

export interface ProjectRunSummary extends RunSummaryBase {
  projectId: string | null;
}

/** `projectId` is passed in already-classified (never re-derived from raw `data.projectId` here) — the caller has already run `classifyProjectIdFieldState()` as part of its own integrity check and knows the semantic value is trustworthy. */
export function toProjectRunSummary(id: string, data: Record<string, unknown>, projectId: string | null): ProjectRunSummary {
  return { ...toRunSummaryBase(id, data), projectId };
}
