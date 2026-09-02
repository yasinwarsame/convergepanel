"use client";

/**
 * Team Project Research Composer, Phase 12A.3 — client mutation helper for
 * `POST /api/workspaces/{workspaceId}/runs`. This is the ONLY endpoint this
 * hook ever calls — never `/api/run-panel` (the Personal endpoint). `projectId`
 * is always the caller-supplied, route-bound Project id; this hook has no
 * parameter for omitting or overriding it, so a Project-bound composer can
 * never accidentally submit an Unfiled (`projectId: null`) run.
 *
 * Mirrors `useTeamProjectLifecycle.ts`'s exact single-flight discipline: a
 * synchronous `inFlightRef` guard (not merely the async `isSubmitting`
 * state, which only updates on the next render) is what actually prevents a
 * second POST from a rapid double-click/double-Enter before React has had a
 * chance to re-render the disabled button — the async state alone would
 * still be `false` for the first few microtasks after the first call
 * begins.
 *
 * No client-side retry of any kind: a failed/errored submission is reported
 * to the caller and the hook returns to idle — the caller may resubmit
 * explicitly (a fresh, distinct user action), but this hook never
 * auto-retries a provider-running POST.
 */

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import type { ModelId } from "@/lib/types";
import type { PanelResultPublic } from "@/lib/panel/schemas";
import type { PanelHistoryGovernanceStatus } from "@/lib/user/panelHistory";

export interface TeamResearchRunResult {
  runId: string;
  results: PanelResultPublic[];
  governanceStatus?: PanelHistoryGovernanceStatus;
}

export type TeamResearchSubmitResult = { status: "ok"; run: TeamResearchRunResult } | { status: "error"; errorCode: string; message: string };

function readErrorCode(body: unknown): string {
  if (typeof body !== "object" || body === null) return "unknown_error";
  const d = body as Record<string, unknown>;
  return typeof d.errorCode === "string" ? d.errorCode : typeof d.error === "string" ? d.error : "unknown_error";
}

function readErrorMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) return "This research run could not be started. Please try again.";
  const d = body as Record<string, unknown>;
  return typeof d.message === "string" && d.message.trim().length > 0 ? d.message : "This research run could not be started. Please try again.";
}

function parseRunResponse(body: unknown): TeamResearchRunResult | null {
  if (typeof body !== "object" || body === null) return null;
  const d = body as Record<string, unknown>;
  if (d.ok !== true || typeof d.runId !== "string" || !Array.isArray(d.results)) return null;
  const governanceStatus = d.governanceStatus === "approved" || d.governanceStatus === "needs_review" || d.governanceStatus === "blocked" ? d.governanceStatus : undefined;
  return { runId: d.runId, results: d.results as PanelResultPublic[], governanceStatus };
}

export interface UseTeamProjectResearchResult {
  isSubmitting: boolean;
  submit: (args: { question: string; selectedModels: ModelId[] }) => Promise<TeamResearchSubmitResult>;
}

export function useTeamProjectResearch(args: { workspaceId: string; projectId: string }): UseTeamProjectResearchResult {
  const { workspaceId, projectId } = args;
  const { user } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inFlightRef = useRef(false);

  const submit = useCallback(
    async ({ question, selectedModels }: { question: string; selectedModels: ModelId[] }): Promise<TeamResearchSubmitResult> => {
      if (inFlightRef.current) {
        return { status: "error", errorCode: "already_submitting", message: "A research run is already in progress." };
      }
      inFlightRef.current = true;
      setIsSubmitting(true);
      try {
        const res = await authedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs`, {
          user,
          authReady: true,
          method: "POST",
          body: JSON.stringify({ question, selectedModels, projectId }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          return { status: "error", errorCode: readErrorCode(body), message: readErrorMessage(body) };
        }
        const parsed = parseRunResponse(body);
        if (!parsed) {
          return { status: "error", errorCode: "internal_error", message: "This research run could not be started. Please try again." };
        }
        return { status: "ok", run: parsed };
      } catch {
        return { status: "error", errorCode: "network_error", message: "Couldn't reach the server. Check your connection and try again." };
      } finally {
        inFlightRef.current = false;
        setIsSubmitting(false);
      }
    },
    [user, workspaceId, projectId]
  );

  return { isSubmitting, submit };
}
