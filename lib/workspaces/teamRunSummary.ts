/**
 * Team Run Lists, Phase 8C-B2 — the browser-facing run summary DTO for
 * every B2 Team route. Structural sibling of `ProjectRunSummary`
 * (`lib/projects/projectRunSummary.ts`): exactly the shared
 * `RunSummaryBase` (`lib/runs/runSummary.ts`) plus additive fields — here,
 * `userId`, `workspaceId`, and `projectId`, because a shared Workspace
 * resource needs creator attribution and its own Workspace/Project
 * association state, unlike a Personal DTO where those are implicit from
 * the authenticated caller.
 *
 * Deliberately does NOT expose membership documents, authorization
 * reasons/capability internals, Workspace role internals, or any
 * Firestore snapshot metadata — same minimal-DTO discipline as every
 * other run/Project summary in this codebase.
 */

import "server-only";
import { toRunSummaryBase, type RunSummaryBase } from "@/lib/runs/runSummary";

export type TeamRunSummaryDto = RunSummaryBase & {
  userId: string;
  workspaceId: string;
  projectId: string | null;
};

/**
 * `userId`/`workspaceId`/`projectId` are passed in already-validated
 * (never re-derived from raw `data` here) — the caller has already run
 * its own structural/integrity checks and knows these values are
 * trustworthy. `projectId` must never be `undefined` at this call site —
 * an absent `projectId` on a Team-bound run is an integrity failure the
 * caller resolves BEFORE constructing this DTO, never something this
 * function papers over.
 */
export function toTeamRunSummary(id: string, data: Record<string, unknown>, userId: string, workspaceId: string, projectId: string | null): TeamRunSummaryDto {
  return { ...toRunSummaryBase(id, data), userId, workspaceId, projectId };
}
