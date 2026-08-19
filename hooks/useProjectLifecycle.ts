"use client";

/**
 * Phase 7D — client mutation helper for the four Project lifecycle
 * endpoints (create/rename/archive/restore). Reuses `authedFetch`; never
 * manipulates `__session`/Firebase tokens directly. Deliberately keeps
 * each operation's request body explicit rather than exposing a generic
 * "PATCH any field" abstraction — see the module doc comment on each
 * operation below for why.
 *
 * Per-Project mutation locking (spec item 18/19): a Project id (or the
 * `CREATE_LOCK_KEY` sentinel for create, which has no id yet) can have at
 * most one lifecycle mutation in flight through this hook at a time. A
 * second call for the same id while one is outstanding is rejected
 * up-front, never queued or silently dropped-and-retried — this is a
 * defense-in-depth backstop; the UI is expected to disable the relevant
 * controls for a busy Project so this path is not the primary guard.
 *
 * Every mutation response is passed through `validateProjectMutationDto()`
 * before being adopted — a contradictory response (wrong id, wrong status
 * for the operation, missing/malformed `updateTime`) becomes
 * `internal_error`, never silently accepted.
 */

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import type { ProjectSummary } from "@/hooks/useProjects";
import { mapMutationErrorCode, validateProjectMutationDto, type ProjectMutationErrorCode } from "@/lib/projects/projectMutationResponse";

const CREATE_LOCK_KEY = "__create__";
const PROJECTS_ENDPOINT = "/api/user/projects";

export type ProjectMutationResult = { status: "ok"; project: ProjectSummary } | { status: "error"; errorCode: ProjectMutationErrorCode };

export interface UseProjectLifecycleResult {
  /** True while a lifecycle mutation for this exact Project id is in flight through this hook. */
  isProjectBusy: (projectId: string) => boolean;
  /** True while a create request is in flight. */
  isCreating: boolean;
  createProject: (name: string) => Promise<ProjectMutationResult>;
  renameProject: (project: ProjectSummary, name: string) => Promise<ProjectMutationResult>;
  archiveProject: (project: ProjectSummary) => Promise<ProjectMutationResult>;
  restoreProject: (project: ProjectSummary) => Promise<ProjectMutationResult>;
}

async function parseMutationResponse(res: Response): Promise<{ ok: true; project: unknown } | { ok: false; errorCode: ProjectMutationErrorCode }> {
  const body = await res.json().catch(() => null);
  if (res.ok && body?.ok === true && body.project) {
    return { ok: true, project: body.project };
  }
  return { ok: false, errorCode: mapMutationErrorCode(body?.errorCode) };
}

export function useProjectLifecycle(): UseProjectLifecycleResult {
  const { user } = useAuth();
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  // Synchronous source of truth for the lock check itself — React state
  // updates are batched/async, so a rapid double-call could otherwise both
  // observe the pre-update `busyIds` and both proceed. The ref is mutated
  // synchronously before any await; `busyIds` state exists only to let
  // components re-render when lock membership changes.
  const busyIdsRef = useRef<Set<string>>(new Set());

  const isProjectBusy = useCallback((projectId: string) => busyIds.has(projectId), [busyIds]);

  const withLock = useCallback(async (lockKey: string, fn: () => Promise<ProjectMutationResult>): Promise<ProjectMutationResult> => {
    if (busyIdsRef.current.has(lockKey)) {
      // Defense in depth — the UI is expected to have already disabled the
      // control that would produce this call. Never dispatches a second
      // request for the same lock key.
      return { status: "error", errorCode: "internal_error" };
    }
    busyIdsRef.current.add(lockKey);
    setBusyIds(new Set(busyIdsRef.current));
    try {
      return await fn();
    } finally {
      busyIdsRef.current.delete(lockKey);
      setBusyIds(new Set(busyIdsRef.current));
    }
  }, []);

  const createProject = useCallback(
    (name: string): Promise<ProjectMutationResult> =>
      withLock(CREATE_LOCK_KEY, async () => {
        try {
          const res = await authedFetch(PROJECTS_ENDPOINT, { user, authReady: true, method: "POST", body: JSON.stringify({ name }) });
          const parsed = await parseMutationResponse(res);
          if (!parsed.ok) return { status: "error", errorCode: parsed.errorCode };
          const validated = validateProjectMutationDto(parsed.project, { operation: "create" });
          if (!validated) return { status: "error", errorCode: "internal_error" };
          return { status: "ok", project: validated };
        } catch {
          return { status: "error", errorCode: "network_error" };
        }
      }),
    [user, withLock]
  );

  const renameProject = useCallback(
    (project: ProjectSummary, name: string): Promise<ProjectMutationResult> =>
      withLock(project.id, async () => {
        try {
          const res = await authedFetch(`${PROJECTS_ENDPOINT}/${encodeURIComponent(project.id)}`, {
            user,
            authReady: true,
            method: "PATCH",
            body: JSON.stringify({ name, expectedUpdateTime: project.updateTime }),
          });
          const parsed = await parseMutationResponse(res);
          if (!parsed.ok) return { status: "error", errorCode: parsed.errorCode };
          const validated = validateProjectMutationDto(parsed.project, { operation: "rename", expectedId: project.id, expectedStatus: project.status });
          if (!validated) return { status: "error", errorCode: "internal_error" };
          return { status: "ok", project: validated };
        } catch {
          return { status: "error", errorCode: "network_error" };
        }
      }),
    [user, withLock]
  );

  const archiveProject = useCallback(
    (project: ProjectSummary): Promise<ProjectMutationResult> =>
      withLock(project.id, async () => {
        try {
          const res = await authedFetch(`${PROJECTS_ENDPOINT}/${encodeURIComponent(project.id)}/archive`, {
            user,
            authReady: true,
            method: "POST",
            body: JSON.stringify({ expectedUpdateTime: project.updateTime }),
          });
          const parsed = await parseMutationResponse(res);
          if (!parsed.ok) return { status: "error", errorCode: parsed.errorCode };
          const validated = validateProjectMutationDto(parsed.project, { operation: "archive", expectedId: project.id });
          if (!validated) return { status: "error", errorCode: "internal_error" };
          return { status: "ok", project: validated };
        } catch {
          return { status: "error", errorCode: "network_error" };
        }
      }),
    [user, withLock]
  );

  const restoreProject = useCallback(
    (project: ProjectSummary): Promise<ProjectMutationResult> =>
      withLock(project.id, async () => {
        try {
          const res = await authedFetch(`${PROJECTS_ENDPOINT}/${encodeURIComponent(project.id)}/restore`, {
            user,
            authReady: true,
            method: "POST",
            body: JSON.stringify({ expectedUpdateTime: project.updateTime }),
          });
          const parsed = await parseMutationResponse(res);
          if (!parsed.ok) return { status: "error", errorCode: parsed.errorCode };
          const validated = validateProjectMutationDto(parsed.project, { operation: "restore", expectedId: project.id });
          if (!validated) return { status: "error", errorCode: "internal_error" };
          return { status: "ok", project: validated };
        } catch {
          return { status: "error", errorCode: "network_error" };
        }
      }),
    [user, withLock]
  );

  return {
    isProjectBusy,
    isCreating: busyIds.has(CREATE_LOCK_KEY),
    createProject,
    renameProject,
    archiveProject,
    restoreProject,
  };
}
