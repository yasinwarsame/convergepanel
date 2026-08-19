"use client";

/**
 * Phase 7E-A — client mutation helper for run/Project association. Phase
 * 7E-A shipped and production-canary-proved exactly one operation
 * (`assign`, Unfiled → Active Project). Phase 7E-B adds `move` (Project →
 * Project) and `remove` (Project → Unfiled), sharing a single private
 * dispatch helper — `assign`'s own externally-observable signature and
 * behavior are byte-for-byte unchanged from Phase 7E-A; it is not
 * reimplemented in terms of `move`/`remove` in any way that could change
 * its request shape, locking, or response validation.
 *
 * Consumes the already-production-proven `PATCH
 * /api/user/runs/{runId}/project` (Phase 6D.4A) exactly as-is for all
 * three operations — this hook never changes that route, never adds a
 * second association endpoint.
 *
 * `expectedProjectId` is the canonical run/Project concurrency token — a
 * genuinely different concept from Project lifecycle's `updateTime` OCC
 * token (`useProjectLifecycle.ts`). This hook never reads or sends a
 * Project's `updateTime`, for any of the three operations.
 *
 * Per-run mutation locking mirrors `useProjectLifecycle()`'s proven
 * pattern (synchronous ref check before the only `await`) but is a
 * genuinely separate lock keyed by `runId`, not a reuse of the Project
 * lifecycle lock. Phase 7E-B addition: the lock now also records WHICH
 * operation holds it (`ProjectAssociationOperation`), presentation-only —
 * mirrors Phase 7D.3B's `getBusyOperation()` fix for the exact same class
 * of bug (a shared busy boolean must never let a non-executing control
 * claim to be the one running).
 */

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import {
  mapRunProjectAssociationErrorCode,
  validateRunProjectAssociationDto,
  type RunProjectAssociationErrorCode,
} from "@/lib/projects/runProjectAssociationResponse";

export type RunProjectAssociationResult =
  | { status: "ok"; runId: string; projectId: string | null }
  | { status: "error"; errorCode: RunProjectAssociationErrorCode };

/** Presentation-only label for which operation currently holds a run's lock. Never affects locking/dispatch. */
export type ProjectAssociationOperation = "assign" | "move" | "remove";

export interface UseRunProjectAssociationResult {
  /** True while an association mutation for this exact run id is in flight through this hook. */
  isRunBusy: (runId: string) => boolean;
  /** Which operation is actually holding the lock for this run, or `null` if idle. Presentation-only — a control must still disable off `isRunBusy()`. */
  getBusyOperation: (runId: string) => ProjectAssociationOperation | null;
  /** Phase 7E-A only ever calls this with `expectedProjectId: null` (the run's canonical Unfiled state) — the parameter is explicit, never defaulted silently. Unchanged since Phase 7E-A. */
  assign: (runId: string, targetProjectId: string, expectedProjectId: string | null) => Promise<RunProjectAssociationResult>;
  /** Phase 7E-B — move an already-assigned run from its current Project to a different Active Project. `expectedProjectId` must be the run's own canonical current `projectId` (its source Project), never the route parameter directly. */
  move: (runId: string, targetProjectId: string, expectedProjectId: string) => Promise<RunProjectAssociationResult>;
  /** Phase 7E-B — remove an already-assigned run from its current Project (returns it to Unfiled). `expectedProjectId` must be the run's own canonical current `projectId`. */
  remove: (runId: string, expectedProjectId: string) => Promise<RunProjectAssociationResult>;
}

export function useRunProjectAssociation(): UseRunProjectAssociationResult {
  const { user } = useAuth();
  const [busyOperations, setBusyOperations] = useState<ReadonlyMap<string, ProjectAssociationOperation>>(new Map());
  // Synchronous source of truth for the lock check — see useProjectLifecycle.ts's identical rationale.
  const busyOperationsRef = useRef<Map<string, ProjectAssociationOperation>>(new Map());

  const isRunBusy = useCallback((runId: string) => busyOperations.has(runId), [busyOperations]);
  const getBusyOperation = useCallback((runId: string) => busyOperations.get(runId) ?? null, [busyOperations]);

  const dispatch = useCallback(
    async (
      runId: string,
      operation: ProjectAssociationOperation,
      targetProjectId: string | null,
      expectedProjectId: string | null
    ): Promise<RunProjectAssociationResult> => {
      if (busyOperationsRef.current.has(runId)) {
        // Defense in depth — the UI is expected to have already disabled the control that would produce this call.
        return { status: "error", errorCode: "internal_error" };
      }
      busyOperationsRef.current.set(runId, operation);
      setBusyOperations(new Map(busyOperationsRef.current));
      try {
        const res = await authedFetch(`/api/user/runs/${encodeURIComponent(runId)}/project`, {
          user,
          authReady: true,
          method: "PATCH",
          body: JSON.stringify({ projectId: targetProjectId, expectedProjectId }),
        });
        const body = await res.json().catch(() => null);
        if (!(res.ok && (body as { ok?: unknown } | null)?.ok === true)) {
          return { status: "error", errorCode: mapRunProjectAssociationErrorCode((body as { errorCode?: unknown } | null)?.errorCode) };
        }
        const validated = validateRunProjectAssociationDto(body, { expectedRunId: runId, expectedTargetProjectId: targetProjectId });
        if (!validated) return { status: "error", errorCode: "internal_error" };
        return { status: "ok", runId: validated.runId, projectId: validated.projectId };
      } catch {
        return { status: "error", errorCode: "network_error" };
      } finally {
        busyOperationsRef.current.delete(runId);
        setBusyOperations(new Map(busyOperationsRef.current));
      }
    },
    [user]
  );

  const assign = useCallback(
    (runId: string, targetProjectId: string, expectedProjectId: string | null): Promise<RunProjectAssociationResult> =>
      dispatch(runId, "assign", targetProjectId, expectedProjectId),
    [dispatch]
  );

  const move = useCallback(
    (runId: string, targetProjectId: string, expectedProjectId: string): Promise<RunProjectAssociationResult> =>
      dispatch(runId, "move", targetProjectId, expectedProjectId),
    [dispatch]
  );

  const remove = useCallback(
    (runId: string, expectedProjectId: string): Promise<RunProjectAssociationResult> => dispatch(runId, "remove", null, expectedProjectId),
    [dispatch]
  );

  return { isRunBusy, getBusyOperation, assign, move, remove };
}
