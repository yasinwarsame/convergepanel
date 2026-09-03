"use client";

/**
 * Team Projects UI, Phase 12A.2 — client mutation helper for
 * `POST /api/workspaces/{workspaceId}/projects` (create). Reuses
 * `authedFetch`, `mapMutationErrorCode()`, and the pure DTO shape checks
 * from `lib/projects/projectMutationResponse.ts`.
 *
 * Phase PROJECT-UI-AR-I1 — extended with `archiveProject()` /
 * `restoreProject()` against the EXISTING Team lifecycle routes
 * (`.../projects/{projectId}/archive|restore`, server contract unchanged),
 * mirroring `hooks/useProjectLifecycle.ts`'s Personal precedent while
 * remaining a deliberately separate, Team-typed hook (Team DTOs carry
 * `workspaceId` and may legitimately carry `updateTime: null`; Personal
 * ones cannot). Rename UI is still not shipped on the Team side.
 *
 * Load-bearing rules, all enforced here rather than in components:
 *   - The request body is exactly `{ expectedUpdateTime: project.updateTime }`
 *     — the Project DTO's own NATIVE Firestore updateTime token, verbatim.
 *     Never `updatedAt`, never `Date.now()`, never a manufactured token.
 *   - `updateTime === null` (the row came from a post-mutation
 *     projection-read failure and holds no valid token) returns
 *     `invalid_update_time` WITHOUT sending a request. The UI must refetch
 *     to obtain a token; it must never invent one.
 *   - A synchronous, ref-backed per-Project lock (`busyOperationsRef`):
 *     the first mutation for a Project acquires it before any await; a
 *     second mutation for the SAME Project while one is in flight sends
 *     NO request and returns `internal_error`; unrelated Projects are
 *     never blocked; the lock is released on success and on every handled
 *     failure. This is UX protection only — the server's
 *     `lastUpdateTime` precondition remains the authoritative guard.
 *   - A `2xx` with `projectionUnavailable: true` / `project.updateTime:
 *     null` is a COMMITTED success (the server contract says so) — it is
 *     returned as `status: "ok"`, never as an error, and never retried.
 *   - Error codes are mapped through `mapMutationErrorCode()` plus the two
 *     Team-route denials it has no member for (`insufficient_capability`,
 *     `team_workspace_not_found`), so a real 403 is never collapsed into a
 *     generic 500-style message. No retry logic exists anywhere in this
 *     hook — stale/denied outcomes are surfaced to the caller, which
 *     refetches.
 */

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import { mapMutationErrorCode, type ProjectMutationErrorCode } from "@/lib/projects/projectMutationResponse";
import { isValidUpdateTimeTokenShape } from "@/lib/projects/updateTimeTokenClient";
import type { TeamProjectSummary } from "@/hooks/useTeamProjects";

export type TeamProjectMutationErrorCode = ProjectMutationErrorCode | "insufficient_capability" | "team_workspace_not_found";

export type TeamProjectMutationResult = { status: "ok"; project: TeamProjectSummary } | { status: "error"; errorCode: TeamProjectMutationErrorCode };

export type TeamProjectLifecycleOperation = "create" | "archive" | "restore";

export interface UseTeamProjectLifecycleResult {
  isCreating: boolean;
  createProject: (name: string) => Promise<TeamProjectMutationResult>;
  /** True while ANY lifecycle mutation for this Project is in flight — drives disabled/pending UI. */
  isProjectBusy: (projectId: string) => boolean;
  /** Which operation currently holds this Project's lock (for operation-specific pending labels), or `null`. */
  getBusyOperation: (projectId: string) => TeamProjectLifecycleOperation | null;
  archiveProject: (project: TeamProjectSummary) => Promise<TeamProjectMutationResult>;
  restoreProject: (project: TeamProjectSummary) => Promise<TeamProjectMutationResult>;
}

/** The only two Team-route error codes `mapMutationErrorCode()` cannot express; everything else defers to the shared mapping (which collapses unknown codes to `internal_error`, never guessing). */
function mapTeamMutationErrorCode(raw: unknown): TeamProjectMutationErrorCode {
  if (raw === "insufficient_capability" || raw === "team_workspace_not_found") return raw;
  return mapMutationErrorCode(raw);
}

async function parseMutationResponse(res: Response): Promise<{ ok: true; project: unknown } | { ok: false; errorCode: TeamProjectMutationErrorCode }> {
  const body = await res.json().catch(() => null);
  if (res.ok && body?.ok === true && body.project) {
    return { ok: true, project: body.project };
  }
  return { ok: false, errorCode: mapTeamMutationErrorCode(body?.errorCode) };
}

/**
 * Team-specific validation, deliberately NOT `validateProjectMutationDto()`
 * (`lib/projects/projectMutationResponse.ts`): that function's shape check
 * requires `updateTime` to be a well-formed token, rejecting `null`. Every
 * Team mutation endpoint's DTO can legitimately return `updateTime: null`
 * when the post-commit projection read fails (the mutation itself still
 * committed) — see `TeamProjectSummaryDto`'s own contract. Rejecting that
 * as `internal_error` would misreport a genuinely successful mutation.
 */
function validateTeamProjectDto(raw: unknown, expected: { workspaceId: string; id?: string; status: "active" | "archived" }): TeamProjectSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.id !== "string" ||
    c.id.length === 0 ||
    (expected.id !== undefined && c.id !== expected.id) ||
    c.workspaceId !== expected.workspaceId ||
    typeof c.name !== "string" ||
    c.status !== expected.status ||
    typeof c.createdAt !== "string" ||
    typeof c.updatedAt !== "string" ||
    !(c.updateTime === null || isValidUpdateTimeTokenShape(c.updateTime))
  ) {
    return null;
  }
  return c as unknown as TeamProjectSummary;
}

export function useTeamProjectLifecycle(args: { workspaceId: string }): UseTeamProjectLifecycleResult {
  const { workspaceId } = args;
  const { user } = useAuth();
  const [isCreating, setIsCreating] = useState(false);
  // Synchronous source of truth for the create single-flight guard —
  // unchanged from Phase 12A.2.
  const inFlightRef = useRef(false);

  // Synchronous source of truth for the per-Project lifecycle lock; the
  // mirrored React state only exists so consumers re-render on changes.
  const busyOperationsRef = useRef<Map<string, TeamProjectLifecycleOperation>>(new Map());
  const [busyOperations, setBusyOperations] = useState<Map<string, TeamProjectLifecycleOperation>>(new Map());

  const isProjectBusy = useCallback((projectId: string) => busyOperations.has(projectId), [busyOperations]);
  const getBusyOperation = useCallback((projectId: string) => busyOperations.get(projectId) ?? null, [busyOperations]);

  const createProject = useCallback(
    async (name: string): Promise<TeamProjectMutationResult> => {
      if (inFlightRef.current) {
        return { status: "error", errorCode: "internal_error" };
      }
      inFlightRef.current = true;
      setIsCreating(true);
      try {
        const res = await authedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, {
          user,
          authReady: true,
          method: "POST",
          body: JSON.stringify({ name }),
        });
        const parsed = await parseMutationResponse(res);
        if (!parsed.ok) return { status: "error", errorCode: parsed.errorCode };
        const validated = validateTeamProjectDto(parsed.project, { workspaceId, status: "active" });
        if (!validated) return { status: "error", errorCode: "internal_error" };
        return { status: "ok", project: validated };
      } catch {
        return { status: "error", errorCode: "network_error" };
      } finally {
        inFlightRef.current = false;
        setIsCreating(false);
      }
    },
    [user, workspaceId]
  );

  const runLifecycleTransition = useCallback(
    async (project: TeamProjectSummary, operation: "archive" | "restore"): Promise<TeamProjectMutationResult> => {
      // No token, no request: a row from a projection-unavailable response
      // must be refetched before it can be acted on again.
      if (project.updateTime === null) {
        return { status: "error", errorCode: "invalid_update_time" };
      }
      if (busyOperationsRef.current.has(project.id)) {
        return { status: "error", errorCode: "internal_error" };
      }
      busyOperationsRef.current.set(project.id, operation);
      setBusyOperations(new Map(busyOperationsRef.current));
      try {
        const res = await authedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(project.id)}/${operation}`, {
          user,
          authReady: true,
          method: "POST",
          body: JSON.stringify({ expectedUpdateTime: project.updateTime }),
        });
        const parsed = await parseMutationResponse(res);
        if (!parsed.ok) return { status: "error", errorCode: parsed.errorCode };
        const validated = validateTeamProjectDto(parsed.project, { workspaceId, id: project.id, status: operation === "archive" ? "archived" : "active" });
        if (!validated) return { status: "error", errorCode: "internal_error" };
        return { status: "ok", project: validated };
      } catch {
        return { status: "error", errorCode: "network_error" };
      } finally {
        busyOperationsRef.current.delete(project.id);
        setBusyOperations(new Map(busyOperationsRef.current));
      }
    },
    [user, workspaceId]
  );

  const archiveProject = useCallback((project: TeamProjectSummary) => runLifecycleTransition(project, "archive"), [runLifecycleTransition]);
  const restoreProject = useCallback((project: TeamProjectSummary) => runLifecycleTransition(project, "restore"), [runLifecycleTransition]);

  return { isCreating, createProject, isProjectBusy, getBusyOperation, archiveProject, restoreProject };
}
