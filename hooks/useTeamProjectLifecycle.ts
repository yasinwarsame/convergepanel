"use client";

/**
 * Team Projects UI, Phase 12A.2 — client mutation helper for
 * `POST /api/workspaces/{workspaceId}/projects` (create only). Reuses
 * `authedFetch`, `mapMutationErrorCode()`, and `validateProjectMutationDto()`
 * directly from `lib/projects/projectMutationResponse.ts` — that module is
 * a pure, schema-generic validator with no Personal-specific coupling
 * (confirmed in PHASE 12A.2's source inventory), so no Team-specific
 * fork of it is needed.
 *
 * Deliberately create-only, unlike Personal's `useProjectLifecycle()`:
 * this phase does not ship rename/archive/restore UI for Team Projects
 * (PHASE 12A.2 Section W — archive/restore deferred), so this hook does
 * not implement unused mutation methods for them. The rename/archive/
 * restore Team API routes already exist and are untouched; a future
 * phase can add a matching hook surface for them without touching this
 * file's create path.
 */

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import { mapMutationErrorCode, type ProjectMutationErrorCode } from "@/lib/projects/projectMutationResponse";
import { isValidUpdateTimeTokenShape } from "@/lib/projects/updateTimeTokenClient";
import type { TeamProjectSummary } from "@/hooks/useTeamProjects";

export type TeamProjectMutationResult = { status: "ok"; project: TeamProjectSummary } | { status: "error"; errorCode: ProjectMutationErrorCode };

export interface UseTeamProjectLifecycleResult {
  isCreating: boolean;
  createProject: (name: string) => Promise<TeamProjectMutationResult>;
}

async function parseMutationResponse(res: Response): Promise<{ ok: true; project: unknown } | { ok: false; errorCode: ProjectMutationErrorCode }> {
  const body = await res.json().catch(() => null);
  if (res.ok && body?.ok === true && body.project) {
    return { ok: true, project: body.project };
  }
  return { ok: false, errorCode: mapMutationErrorCode(body?.errorCode) };
}

/**
 * Team-specific validation, deliberately NOT `validateProjectMutationDto()`
 * (`lib/projects/projectMutationResponse.ts`): that function's shape check
 * requires `updateTime` to be a well-formed token, rejecting `null`. The
 * Team create endpoint's DTO can legitimately return `updateTime: null`
 * when the post-commit projection read fails (the mutation itself still
 * committed) — see `TeamProjectSummaryDto`'s own contract. Rejecting that
 * as `internal_error` would misreport a genuinely successful creation.
 */
function validateTeamProjectCreateDto(raw: unknown, expectedWorkspaceId: string): TeamProjectSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.id !== "string" ||
    c.id.length === 0 ||
    c.workspaceId !== expectedWorkspaceId ||
    typeof c.name !== "string" ||
    c.status !== "active" ||
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
  // Synchronous source of truth for the single-flight guard — mirrors
  // `useProjectLifecycle()`'s `busyOperationsRef` pattern, narrowed to the
  // one operation this hook actually implements.
  const inFlightRef = useRef(false);

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
        const validated = validateTeamProjectCreateDto(parsed.project, workspaceId);
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

  return { isCreating, createProject };
}
