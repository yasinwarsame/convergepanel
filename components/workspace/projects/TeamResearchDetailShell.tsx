"use client";

/**
 * TEAM-RESEARCH-PARITY-R3 — LAYER 2: the Team research DETAIL client shell.
 *
 * Rendered by both Team detail addresses after their Server Component has
 * already enforced identity, Team Workspace access, `research.read` and (for a
 * Project address) Project existence + Workspace containment:
 *   - `/workspace/team/{W}/projects/{P}/research/{runId}` (`project` given)
 *   - `/workspace/team/{W}/research/{runId}`               (`project` null → Unfiled)
 *
 * It loads the run ONLY through the canonical R1 endpoint
 * `GET /api/workspaces/{W}/runs/{runId}` — with `?projectId=` on a Project
 * address, so the server enforces run-level Project containment — interprets
 * it with the pure `interpretTeamRunDetailResponse()`, and renders the result
 * body with the shared R2 `PersistedResearchResultView`. It never calls the
 * Personal run endpoint, never reads Firestore, never executes models and
 * never generates synthesis (the shared view hard-wires
 * `allowSynthesisGeneration={false}`).
 *
 * NOT AN AUTHORIZATION BOUNDARY. `viewerRole`, the assignee, the creator, the
 * Project label and the provenance are presentation only. The client checks on
 * `team.workspaceId` / `team.projectId` are ROUTE CONTAINMENT: a response that
 * does not belong to this exact address is never painted here.
 *
 * TRANSPORT (mirrors the hardened Personal durable report):
 *   - waits for auth readiness; one request per (uid, workspaceId, projectId, runId);
 *   - a generation guard claimed before the first await, re-checked before
 *     every commit, and an AbortController — a late response for an earlier
 *     address or identity never paints;
 *   - one forced token-refresh retry on HTTP 401, then an honest session state;
 *   - 403 and 404 render ONE indistinguishable unavailable state; 5xx and
 *     network failures are retryable; retry repeats the READ only.
 *
 * ANCILLARY PRESENTATION (R3-R1, P0 contract). Every ready report is rendered
 * with an EXPLICIT `delegated_read_only` adaptive ancillary presentation —
 * selected here by the Team caller, never inferred from viewerRole — so the
 * shared renderer mounts no Personal export action, no Personal export
 * history and no Personal/legacy review & governance section, and makes no
 * ancillary request. Team export is intentionally absent (`exportSurface:
 * null`). The review position shows `TeamResearchReviewSummary` built from the
 * already-authorized `team.review`, with no Workspace review deep link (see
 * that component for why the link is deferred).
 *
 * ACTIONS. No Personal hand-off is passed: "Verify this claim" and "Run
 * follow-up" stay undefined (no Team destination exists yet), and no read-only
 * execution target is delegated, so the single-model branch renders the neutral
 * "This saved report is read-only." copy. Starting research requires
 * capabilities (`research.create` + `research.organize`) that Viewers and
 * Reviewers lack, so a "run this again" pointer would mislead them.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import { createGenerationGuard } from "@/lib/client/authGeneration";
import { Breadcrumb } from "@/components/shared/Breadcrumb";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import TeamResearchReviewSummary from "@/components/workspace/projects/TeamResearchReviewSummary";
import type { AdaptiveAncillaryPresentation } from "@/components/adaptive/adaptiveAncillaryPresentation";
import {
  interpretTeamRunDetailResponse,
  type TeamRunDetailMeta,
  type TeamRunDetailPresentation,
} from "@/lib/research/teamRunDetailPresentation";
import { teamRunDetailApiUrl } from "@/lib/workspaces/teamResearchDetailHref";

export type TeamResearchDetailShellProps = {
  workspaceId: string;
  /** Server-resolved, authorized Workspace display name. */
  workspaceName: string;
  runId: string;
  /** Server-resolved, Workspace-contained Project for a Project address; `null` for the Unfiled address. */
  project: { id: string; name: string } | null;
  /** Presentation hint from the server-resolved capability set (`audit.read`) — not authorization. */
  showAudit: boolean;
};

type DetailState =
  | { kind: "loading" }
  /** 403 / 404 / a run that is not at this address — one indistinguishable treatment. */
  | { kind: "unavailable" }
  /** 5xx or a transport failure: honest and retryable. */
  | { kind: "transient" }
  /** The session was rejected after one forced refresh — says nothing about the research. */
  | { kind: "auth_error" }
  /** A successful response that cannot be represented honestly. */
  | { kind: "malformed" }
  | { kind: "in_progress"; question: string; meta: TeamRunDetailMeta }
  | { kind: "failed"; question: string; meta: TeamRunDetailMeta }
  | { kind: "ready"; presentation: TeamRunDetailPresentation; meta: TeamRunDetailMeta };

const STATE_BOX = "mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-6";

/**
 * The Team durable-report ancillary policy: always delegated read-only, never
 * Personal default. No export surface; the review position is the Team's own
 * read-only summary (or nothing when the DTO has no review).
 */
export function teamResearchAncillaryPresentation(review: TeamRunDetailMeta["review"]): AdaptiveAncillaryPresentation {
  return {
    kind: "delegated_read_only",
    exportSurface: null,
    reviewGovernanceSurface: review ? <TeamResearchReviewSummary review={review} /> : null,
  };
}

export default function TeamResearchDetailShell({ workspaceId, workspaceName, runId, project, showAudit }: TeamResearchDetailShellProps) {
  const { user, authReady } = useAuth();
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [retryTick, setRetryTick] = useState(0);

  const guard = useRef(createGenerationGuard()).current;
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      guard.next();
    };
  }, [guard]);

  const uid = user?.uid ?? null;
  const projectId = project?.id ?? null;

  useEffect(() => {
    // Claimed synchronously: this address + identity is now the page's intent,
    // and every earlier read loses authority immediately.
    const generation = guard.next();
    const controller = new AbortController();
    setState({ kind: "loading" });

    if (!authReady || !uid) {
      return () => controller.abort();
    }

    const owns = () => mountedRef.current && guard.isCurrent(generation);
    const url = teamRunDetailApiUrl({ workspaceId, projectId, runId });

    void (async () => {
      try {
        const read = (forceTokenRefresh = false) =>
          authedFetch(url, {
            user,
            authReady,
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            ...(forceTokenRefresh ? { forceTokenRefresh: true } : {}),
          });

        let res = await read();
        if (!owns()) return;

        if (res.status === 401) {
          // Exactly one forced refresh, under the same generation and abort
          // ownership. A second 401 is a finished session, not a missing run.
          res = await read(true);
          if (!owns()) return;
          if (res.status === 401) {
            setState({ kind: "auth_error" });
            return;
          }
        }

        if (res.status >= 500) {
          setState({ kind: "transient" });
          return;
        }
        if (!res.ok) {
          // 403 insufficient_capability, 404 run_not_found, 404
          // team_workspace_not_found: never distinguishable from each other.
          setState({ kind: "unavailable" });
          return;
        }

        const body = await res.json().catch(() => null);
        if (!owns()) return;

        const interpreted = interpretTeamRunDetailResponse(body, { workspaceId, projectId, runId });
        switch (interpreted.kind) {
          case "malformed":
            setState({ kind: "malformed" });
            return;
          case "out_of_scope":
            setState({ kind: "unavailable" });
            return;
          case "in_progress":
          case "failed":
            setState({ kind: interpreted.kind, question: interpreted.question, meta: interpreted.meta });
            return;
          case "ready":
            setState({ kind: "ready", presentation: interpreted.presentation, meta: interpreted.meta });
            return;
        }
      } catch {
        // An aborted obsolete request must not surface an error of its own.
        if (!owns()) return;
        setState({ kind: "transient" });
      }
    })();

    return () => controller.abort();
  }, [workspaceId, projectId, runId, uid, authReady, user, guard, retryTick]);

  /** Repeats the READ only — never a model panel. */
  const retry = useCallback(() => {
    if (state.kind === "loading") return;
    setRetryTick((n) => n + 1);
  }, [state.kind]);

  const workspaceHref = `/workspace/team/${encodeURIComponent(workspaceId)}`;
  const projectHref = project ? `${workspaceHref}/projects/${encodeURIComponent(project.id)}` : null;

  const question = state.kind === "ready" ? state.presentation.question : state.kind === "in_progress" || state.kind === "failed" ? state.question : null;
  const meta = state.kind === "ready" || state.kind === "in_progress" || state.kind === "failed" ? state.meta : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      {/*
        Phase 11B.3 composition, preserved: Breadcrumb -> heading -> WorkspaceNav
        -> content. The breadcrumb's final segment and the heading are the run's
        question, which exists only once this address's authorized read has
        returned — so both render only then, never on a denied, absent,
        malformed or transient path.
      */}
      {question !== null && (
        <Breadcrumb
          className="mb-3"
          segments={
            project && projectHref
              ? [
                  { label: workspaceName, href: workspaceHref },
                  { label: "Projects", href: `${workspaceHref}/projects` },
                  { label: project.name, href: projectHref },
                  { label: question },
                ]
              : [{ label: workspaceName, href: workspaceHref }, { label: question }]
          }
          mobileParent={project && projectHref ? { label: project.name, href: projectHref } : { label: workspaceName, href: workspaceHref }}
        />
      )}

      {question !== null && meta !== null && (
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-cp-text break-words">{question}</h1>
          {/* Project/Research Assignment (D9) — READ-ONLY; responsibility, never access. */}
          {meta.assignee !== null && (
            <p className="mt-1 text-sm text-cp-muted" data-testid="team-run-assignee">
              Assigned to <span className="font-medium text-cp-text">{meta.assignee.displayName}</span>
              {meta.assignee.state === "stale" ? <span className="ml-2 rounded-full border border-cp-border bg-cp-raised px-2 py-0.5 text-xs text-cp-faint">No longer eligible</span> : null}
            </p>
          )}
          {/* Provenance disclosure only — no source id, no link to a Personal artifact. */}
          {meta.origin !== null && (
            <p className="mt-1 text-sm text-cp-muted" data-testid="team-run-origin">
              Added from Personal research
            </p>
          )}
        </div>
      )}

      {/* Research detail sits beneath Projects for a Project address; the Unfiled address belongs to the Workspace overview. */}
      <WorkspaceNav workspaceId={workspaceId} active={project ? "projects" : "overview"} showAudit={showAudit} />

      {state.kind === "loading" && (
        <div role="status" className="mt-6 rounded-xl border border-cp-border bg-cp-surface px-6 py-10 text-center text-sm text-cp-muted shadow-sm">
          Loading this research…
        </div>
      )}

      {state.kind === "unavailable" && (
        <section className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">This research isn&apos;t available</h2>
          <p className="mt-2 text-sm text-cp-muted">We couldn&apos;t open this research. It may have been removed, moved, or you may not have access to it.</p>
        </section>
      )}

      {state.kind === "transient" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">We couldn&apos;t load this research</h2>
          <p className="mt-2 text-sm text-cp-muted">Something went wrong on our side. The research hasn&apos;t gone anywhere — please try again.</p>
          <button
            type="button"
            onClick={retry}
            className="mt-4 rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
          >
            Try again
          </button>
        </section>
      )}

      {state.kind === "auth_error" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">We couldn&apos;t verify your session</h2>
          <p className="mt-2 text-sm text-cp-muted">
            Your sign-in could not be confirmed, so we didn&apos;t load this research. This says nothing about the research itself — please sign in again and reopen this page.
          </p>
          <Link
            href="/login"
            className="mt-4 inline-block rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
          >
            Sign in again
          </Link>
        </section>
      )}

      {state.kind === "malformed" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">This research couldn&apos;t be displayed</h2>
          <p className="mt-2 text-sm text-cp-muted">The saved result for this research couldn&apos;t be read. Nothing was changed.</p>
        </section>
      )}

      {state.kind === "in_progress" && (
        <section className="mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-5 text-sm text-cp-muted">
          This research is still in progress. Refresh this page to check again.
        </section>
      )}

      {state.kind === "failed" && (
        <section role="alert" className="mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-5 text-sm text-cp-muted">
          This research run didn&apos;t finish successfully.
        </section>
      )}

      {state.kind === "ready" && (
        <PersistedResearchResultView presentation={state.presentation} adaptiveAncillaryPresentation={teamResearchAncillaryPresentation(state.meta.review)} />
      )}
    </main>
  );
}
