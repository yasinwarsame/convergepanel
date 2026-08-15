"use client";

/**
 * Phase 5C — small, focused client abstraction for
 * `GET /api/user/workspace`. Consumes the exact production envelope
 * (`{ok:true, workspace:{name,type}}` on success; `{ok:false, errorCode,
 * message}` on failure) — never the earlier `{name,type}` shorthand.
 * Phase 5D should reuse this exact pattern (fetch → typed result union →
 * hook) for `GET /api/user/workspace/runs` rather than each component
 * re-parsing response shapes inline.
 *
 * Response interpretation (`parseWorkspaceMetadataResponse`) is a pure
 * function, deliberately separated from the `useEffect`/fetch
 * orchestration below it, so the mapping itself is directly testable
 * without needing to invoke React hooks or mock `useAuth()`/`authedFetch`
 * at all.
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";

export interface WorkspaceMetadata {
  name: string;
  type: "personal";
}

export type WorkspaceMetadataErrorCode =
  | "unauthorized"
  | "auth_error"
  | "workspace_unavailable"
  | "workspace_invalid"
  | "workspace_missing"
  | "network_error";

export type UseWorkspaceMetadataResult =
  | { status: "loading" }
  | { status: "success"; workspace: WorkspaceMetadata }
  | { status: "error"; errorCode: WorkspaceMetadataErrorCode };

const KNOWN_ERROR_CODES: readonly WorkspaceMetadataErrorCode[] = [
  "unauthorized",
  "auth_error",
  "workspace_unavailable",
  "workspace_invalid",
  "workspace_missing",
];

/**
 * Pure: given the raw fetch outcome, produce the typed result. Never
 * reconstructs `name`/`type` from anything other than the response body
 * — a malformed/absent `workspace` object on an `ok:true` response is
 * treated as `workspace_unavailable`, never defaulted to some guessed
 * Workspace shape.
 */
export function parseWorkspaceMetadataResponse(outcome: { ok: boolean; body: any }): UseWorkspaceMetadataResult {
  if (outcome.ok && outcome.body?.ok === true && outcome.body?.workspace && typeof outcome.body.workspace.name === "string") {
    return { status: "success", workspace: { name: outcome.body.workspace.name, type: "personal" } };
  }
  const errorCode = KNOWN_ERROR_CODES.find((code) => code === outcome.body?.errorCode) ?? "workspace_unavailable";
  return { status: "error", errorCode };
}

export function useWorkspaceMetadata(): UseWorkspaceMetadataResult {
  const { user, loading: authLoading, authReady } = useAuth();
  const [result, setResult] = useState<UseWorkspaceMetadataResult>({ status: "loading" });

  useEffect(() => {
    if (authLoading || !authReady) return;
    if (!user) {
      setResult({ status: "error", errorCode: "unauthorized" });
      return;
    }

    let cancelled = false;
    (async () => {
      setResult({ status: "loading" });
      try {
        const res = await authedFetch("/api/user/workspace", { user, authReady: true, method: "GET", cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        setResult(parseWorkspaceMetadataResponse({ ok: res.ok, body }));
      } catch {
        if (!cancelled) setResult({ status: "error", errorCode: "network_error" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, authReady, user]);

  return result;
}
