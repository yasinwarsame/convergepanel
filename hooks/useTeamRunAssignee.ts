"use client";

/**
 * Project/Research Assignment (brief §6.7) — client hook for the Team run
 * primary-assignee routes:
 *
 *   GET   /api/workspaces/{W}/runs/{runId}/assignee  → current assignee
 *         presentation + the run's current reviewer uids (D8 warning input)
 *   PATCH /api/workspaces/{W}/runs/{runId}/assignee  → set / clear, with the
 *         run's own expected-state token (`expectedAssigneeUid`), never a
 *         Project OCC token.
 *
 * Per-run busy lock (synchronous ref) is the real duplicate guard. Every
 * server denial is mapped to a closed error-code union; an unrecognized
 * code collapses to `internal_error`, never guessed into something else.
 * No Project token, no membership document, no capability internals.
 */

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";

export interface TeamRunAssigneeView {
  uid: string;
  displayName: string;
  state: "active" | "stale";
}

export type TeamRunAssigneeErrorCode =
  | "unauthorized"
  | "auth_error"
  | "team_workspace_not_found"
  | "team_workspace_unavailable"
  | "insufficient_capability"
  | "run_not_found"
  | "assignee_conflict"
  | "assignee_not_eligible"
  | "invalid_request_body"
  | "unexpected_field"
  | "rate_limited"
  | "internal_error"
  | "network_error";

const KNOWN_ERROR_CODES: readonly Exclude<TeamRunAssigneeErrorCode, "network_error">[] = [
  "unauthorized",
  "auth_error",
  "team_workspace_not_found",
  "team_workspace_unavailable",
  "insufficient_capability",
  "run_not_found",
  "assignee_conflict",
  "assignee_not_eligible",
  "invalid_request_body",
  "unexpected_field",
  "rate_limited",
  "internal_error",
];

export function mapTeamRunAssigneeErrorCode(raw: unknown): TeamRunAssigneeErrorCode {
  return KNOWN_ERROR_CODES.find((code) => code === raw) ?? "internal_error";
}

export type LoadTeamRunAssigneeResult = { status: "ok"; assignee: TeamRunAssigneeView | null; reviewerUids: string[] } | { status: "error"; errorCode: TeamRunAssigneeErrorCode };
export type SetTeamRunAssigneeResult = { status: "ok"; changed: boolean; assigneeUid: string | null } | { status: "error"; errorCode: TeamRunAssigneeErrorCode };

export interface UseTeamRunAssigneeResult {
  isRunBusy: (runId: string) => boolean;
  loadRunAssignee: (runId: string, signal?: AbortSignal) => Promise<LoadTeamRunAssigneeResult>;
  setRunAssignee: (args: { runId: string; assigneeUid: string | null; expectedAssigneeUid: string | null }) => Promise<SetTeamRunAssigneeResult>;
}

function isAssigneeView(value: unknown): value is TeamRunAssigneeView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.uid === "string" && v.uid.length > 0 && typeof v.displayName === "string" && (v.state === "active" || v.state === "stale");
}

/** Pure — exported for request-shape tests. */
export function buildSetTeamRunAssigneeRequest(args: { workspaceId: string; runId: string; assigneeUid: string | null; expectedAssigneeUid: string | null }): { url: string; body: string } {
  return {
    url: `/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}/assignee`,
    body: JSON.stringify({ assigneeUid: args.assigneeUid, expectedAssigneeUid: args.expectedAssigneeUid }),
  };
}

export function useTeamRunAssignee(args: { workspaceId: string }): UseTeamRunAssigneeResult {
  const { workspaceId } = args;
  const { user } = useAuth();
  const busyRef = useRef<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const isRunBusy = useCallback((runId: string) => busy.has(runId), [busy]);

  const loadRunAssignee = useCallback(
    async (runId: string, signal?: AbortSignal): Promise<LoadTeamRunAssigneeResult> => {
      try {
        const res = await authedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/assignee`, { user, authReady: true, method: "GET", cache: "no-store", signal });
        const body = await res.json().catch(() => null);
        if (!res.ok || body?.ok !== true) return { status: "error", errorCode: mapTeamRunAssigneeErrorCode(body?.errorCode) };
        const assignee = body.assignee;
        const reviewerUids = body.reviewerUids;
        if (!(assignee === null || isAssigneeView(assignee))) return { status: "error", errorCode: "internal_error" };
        if (!Array.isArray(reviewerUids) || !reviewerUids.every((u) => typeof u === "string")) return { status: "error", errorCode: "internal_error" };
        return { status: "ok", assignee, reviewerUids };
      } catch {
        return { status: "error", errorCode: "network_error" };
      }
    },
    [user, workspaceId]
  );

  const setRunAssignee = useCallback(
    async (input: { runId: string; assigneeUid: string | null; expectedAssigneeUid: string | null }): Promise<SetTeamRunAssigneeResult> => {
      if (busyRef.current.has(input.runId)) return { status: "error", errorCode: "internal_error" };
      busyRef.current.add(input.runId);
      setBusy(new Set(busyRef.current));
      try {
        const { url, body } = buildSetTeamRunAssigneeRequest({ workspaceId, ...input });
        const res = await authedFetch(url, { user, authReady: true, method: "PATCH", body });
        const json = await res.json().catch(() => null);
        if (!res.ok || json?.ok !== true) return { status: "error", errorCode: mapTeamRunAssigneeErrorCode(json?.errorCode) };
        if (typeof json.changed !== "boolean" || !(json.assigneeUid === null || typeof json.assigneeUid === "string")) return { status: "error", errorCode: "internal_error" };
        return { status: "ok", changed: json.changed, assigneeUid: json.assigneeUid };
      } catch {
        return { status: "error", errorCode: "network_error" };
      } finally {
        busyRef.current.delete(input.runId);
        setBusy(new Set(busyRef.current));
      }
    },
    [user, workspaceId]
  );

  return { isRunBusy, loadRunAssignee, setRunAssignee };
}
