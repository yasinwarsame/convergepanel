"use client";

/**
 * Project/Research Assignment (brief §2.7/§6.7) — `useWorkspaceMembers`,
 * extracted from the two inline `fetchWorkspaceMembers()` callers
 * (`WorkspaceOverviewShell`, `WorkspaceMembersShell`) as the assignee
 * pickers' data source. Same client function, same response validation,
 * same request-sequencing guard (a stale response never overwrites a
 * newer one). Read-only: exposes the member list + the Workspace OCC
 * token exactly as the server returned them.
 *
 * `enabled: false` (a closed picker) issues no request at all.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { fetchWorkspaceMembers, type WorkspaceMemberItem, type WorkspaceUpdateTimeToken } from "@/lib/client/workspaceTeamClient";

export interface UseWorkspaceMembersResult {
  status: "idle" | "loading" | "ready" | "error";
  members: WorkspaceMemberItem[];
  workspaceUpdateToken: WorkspaceUpdateTimeToken | null;
  reload: () => void;
}

export function useWorkspaceMembers(args: { workspaceId: string; enabled?: boolean }): UseWorkspaceMembersResult {
  const { workspaceId, enabled = true } = args;
  const { user, authReady } = useAuth();
  const [status, setStatus] = useState<UseWorkspaceMembersResult["status"]>(enabled ? "loading" : "idle");
  const [members, setMembers] = useState<WorkspaceMemberItem[]>([]);
  const [workspaceUpdateToken, setWorkspaceUpdateToken] = useState<WorkspaceUpdateTimeToken | null>(null);
  const requestId = useRef(0);

  const reload = useCallback(() => {
    if (!enabled || !authReady) return;
    const thisRequest = ++requestId.current;
    setStatus("loading");
    (async () => {
      const result = await fetchWorkspaceMembers({ user, authReady, workspaceId });
      if (requestId.current !== thisRequest) return;
      if (result.status === "ok") {
        setMembers(result.members);
        setWorkspaceUpdateToken(result.workspaceUpdateToken);
        setStatus("ready");
      } else {
        setMembers([]);
        setWorkspaceUpdateToken(null);
        setStatus("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, authReady, user?.uid, workspaceId]);

  useEffect(() => {
    if (!enabled) {
      requestId.current++;
      setStatus("idle");
      return;
    }
    reload();
  }, [enabled, reload]);

  return { status, members, workspaceUpdateToken, reload };
}
