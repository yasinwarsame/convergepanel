"use client";

/**
 * Phase 7E-A — client mutation helper for the ONE run/Project association
 * operation this increment exposes: assigning an Unfiled run to an Active
 * Project. Consumes the already-production-proven `PATCH
 * /api/user/runs/{runId}/project` (Phase 6D.4A) exactly as-is — this hook
 * never changes that route, never adds a second association endpoint.
 *
 * `expectedProjectId` is the canonical run/Project concurrency token — a
 * genuinely different concept from Project lifecycle's `updateTime` OCC
 * token (`useProjectLifecycle.ts`). This hook never reads or sends a
 * Project's `updateTime`.
 *
 * Per-run mutation locking mirrors `useProjectLifecycle()`'s proven
 * pattern (synchronous ref check before the only `await`, so a rapid
 * duplicate call for the same run is rejected before ever reaching
 * `authedFetch`) but is a genuinely separate lock keyed by `runId`, not a
 * reuse of the Project lifecycle lock — the two lock entity spaces
 * (Project id vs. run id) are different resources and must never share a
 * key namespace.
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

export interface UseRunProjectAssociationResult {
  /** True while an association mutation for this exact run id is in flight through this hook. */
  isRunBusy: (runId: string) => boolean;
  /** Phase 7E-A only ever calls this with `expectedProjectId: null` (the run's canonical Unfiled state) — the parameter is explicit, never defaulted silently, so a future Move/Unassign caller in 7E-B cannot accidentally inherit an implicit null. */
  assign: (runId: string, targetProjectId: string, expectedProjectId: string | null) => Promise<RunProjectAssociationResult>;
}

export function useRunProjectAssociation(): UseRunProjectAssociationResult {
  const { user } = useAuth();
  const [busyRunIds, setBusyRunIds] = useState<ReadonlySet<string>>(new Set());
  // Synchronous source of truth for the lock check — see useProjectLifecycle.ts's identical rationale.
  const busyRunIdsRef = useRef<Set<string>>(new Set());

  const isRunBusy = useCallback((runId: string) => busyRunIds.has(runId), [busyRunIds]);

  const assign = useCallback(
    async (runId: string, targetProjectId: string, expectedProjectId: string | null): Promise<RunProjectAssociationResult> => {
      if (busyRunIdsRef.current.has(runId)) {
        // Defense in depth — the UI is expected to have already disabled the control that would produce this call.
        return { status: "error", errorCode: "internal_error" };
      }
      busyRunIdsRef.current.add(runId);
      setBusyRunIds(new Set(busyRunIdsRef.current));
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
        busyRunIdsRef.current.delete(runId);
        setBusyRunIds(new Set(busyRunIdsRef.current));
      }
    },
    [user]
  );

  return { isRunBusy, assign };
}
