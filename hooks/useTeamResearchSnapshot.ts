"use client";

/**
 * ADD-TO-TEAM-PROJECT §V — client mutation helper for
 * `POST /api/workspaces/{workspaceId}/projects/{projectId}/research/snapshots`.
 *
 * Per-SOURCE submission lock, mirroring `useRunProjectAssociation()`'s
 * proven pattern (synchronous ref check before the only `await`): one
 * user action can never issue parallel POSTs for the same source through
 * double-clicking. This is UX containment only — idempotency is the
 * server's (deterministic lock, read inside the transaction); a UI busy
 * flag is never an idempotency mechanism.
 *
 * The request body carries exactly the typed source identity the route
 * accepts; the destination is the URL. The response is validated through
 * the SAME shared module the server builds it with
 * (`validateTeamResearchSnapshotDto`), so a payload naming a different
 * destination, or an `href` that is not the exact Team detail address for
 * that destination, is rejected as `internal_error` rather than followed.
 */

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import {
  mapTeamResearchSnapshotErrorCode,
  validateTeamResearchSnapshotDto,
  type TeamResearchSnapshotDto,
  type TeamResearchSnapshotErrorCode,
} from "@/lib/workspaces/teamResearchSnapshotResponse";

export type TeamResearchSnapshotResult = { status: "ok"; snapshot: TeamResearchSnapshotDto } | { status: "error"; errorCode: TeamResearchSnapshotErrorCode };

export interface UseTeamResearchSnapshotResult {
  /** True while a snapshot request for this exact source run id is in flight through this hook. */
  isSourceBusy: (sourceRunId: string) => boolean;
  create: (args: { sourceRunId: string; workspaceId: string; projectId: string }) => Promise<TeamResearchSnapshotResult>;
}

export function buildTeamResearchSnapshotRequest(args: { sourceRunId: string; workspaceId: string; projectId: string }): { url: string; body: string } {
  return {
    url: `/api/workspaces/${encodeURIComponent(args.workspaceId)}/projects/${encodeURIComponent(args.projectId)}/research/snapshots`,
    body: JSON.stringify({ source: { sourceType: "personal_research", runId: args.sourceRunId } }),
  };
}

export function useTeamResearchSnapshot(): UseTeamResearchSnapshotResult {
  const { user } = useAuth();
  const [busySources, setBusySources] = useState<ReadonlySet<string>>(new Set());
  // Synchronous source of truth for the lock check — see useRunProjectAssociation.ts's identical rationale.
  const busySourcesRef = useRef<Set<string>>(new Set());

  const isSourceBusy = useCallback((sourceRunId: string) => busySources.has(sourceRunId), [busySources]);

  const create = useCallback(
    async (args: { sourceRunId: string; workspaceId: string; projectId: string }): Promise<TeamResearchSnapshotResult> => {
      if (busySourcesRef.current.has(args.sourceRunId)) {
        // Defense in depth — the UI is expected to have already disabled the control that would produce this call.
        return { status: "error", errorCode: "internal_error" };
      }
      busySourcesRef.current.add(args.sourceRunId);
      setBusySources(new Set(busySourcesRef.current));
      try {
        const { url, body } = buildTeamResearchSnapshotRequest(args);
        const res = await authedFetch(url, { user, authReady: true, method: "POST", body });
        const json = await res.json().catch(() => null);
        if (!(res.ok && (json as { ok?: unknown } | null)?.ok === true)) {
          return { status: "error", errorCode: mapTeamResearchSnapshotErrorCode((json as { errorCode?: unknown } | null)?.errorCode) };
        }
        const validated = validateTeamResearchSnapshotDto(json, { workspaceId: args.workspaceId, projectId: args.projectId });
        if (!validated) return { status: "error", errorCode: "internal_error" };
        return { status: "ok", snapshot: validated };
      } catch {
        return { status: "error", errorCode: "network_error" };
      } finally {
        busySourcesRef.current.delete(args.sourceRunId);
        setBusySources(new Set(busySourcesRef.current));
      }
    },
    [user]
  );

  return { isSourceBusy, create };
}
