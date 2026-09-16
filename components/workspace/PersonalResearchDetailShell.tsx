"use client";

/**
 * PERSONAL-RESEARCH-URL-1 — the durable Personal research report surface behind
 * `/workspace/research/{runId}`.
 *
 * A READ SURFACE. It loads one persisted run through the existing
 * `GET /api/user/runs/[runId]` and renders it with the same `ResultsDisplay` and
 * the same persisted-output adapters the root composer uses. It never executes a
 * model panel, never reads Firestore from the browser, and adds no second
 * run-detail endpoint — that API already owns authentication, Personal/Team
 * binding classification, Workspace integrity, Personal-reviewer access, the P0
 * availability contract and every result path.
 *
 * OWNERSHIP. The page can move run A → run B without remounting, so the loader
 * carries its own generation guard: each `runId` claims a generation synchronously
 * before its first await and re-checks immediately before every commit, so a
 * slow A response can never paint over B. A uid change starts a fresh lifecycle —
 * a report loaded as one identity is never reused for another.
 *
 * ERROR HONESTY. 403 and 404 collapse into one indistinguishable "unavailable"
 * state, so the page cannot reveal whether a run exists, belongs to someone else,
 * or belongs to a Team. The P0 `internal_error` 500 is kept separate and
 * retryable — telling someone their research is gone because a lookup failed is
 * the defect P0 existed to fix. Retry repeats the READ only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { useUserPlan } from "@/hooks/useUserPlan";
import { useTeamResearchSnapshot } from "@/hooks/useTeamResearchSnapshot";
import { AddToTeamProjectDialog } from "@/components/workspace/AddToTeamProjectDialog";
import type { TeamResearchSnapshotDto } from "@/lib/workspaces/teamResearchSnapshotResponse";
import { createGenerationGuard } from "@/lib/client/authGeneration";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import {
  interpretPersistedRunReadPayload,
  type PersistedResearchPresentation,
} from "@/lib/research/persistedRunPresentation";
import {
  personalResearchFollowUpHref,
  personalResearchVerifyClaimHref,
} from "@/lib/user/personalResearchHref";

/**
 * Viewer roles this CANONICAL PERSONAL surface accepts.
 *
 * The shared read API is also the Team shared-run detail endpoint, so it can
 * legitimately authorize a Team-bound run for a Team member. That must not make a
 * Team artifact render as a Personal report: `/workspace/research/{id}` is the
 * Personal address, and Team research has its own
 * `/workspace/team/{ws}/projects/{p}/research/{runId}`. This is route containment
 * IN ADDITION TO API authorization, never instead of it.
 */
const PERSONAL_VIEWER_ROLES = new Set(["owner", "personal_reviewer"]);

/**
 * The two roles the shared API issues for a TEAM-bound run. These are legitimate
 * authorizations for a real artifact, so they get the concealed `unavailable`
 * treatment — a Team report must stay indistinguishable from "no such report" on
 * the Personal address.
 *
 * C1 §B: anything else — absent, null, a non-string, an unrecognised string — is
 * NOT evidence about the run at all. The successful response contract always
 * carries exactly one of the four roles, so its absence is a response-contract
 * failure and is treated as `malformed`. The previous check only rejected a
 * non-Personal STRING, so a 200 with no role at all rendered as a Personal report.
 */
const TEAM_VIEWER_ROLES = new Set(["team_member", "team_reviewer"]);

/**
 * R2-C1 — the PERSONAL destination for the read-only single-model "run this
 * question again" pointer: the root composer. Owned here, never by the shared
 * renderer, so a Team report can never inherit it.
 */
const PERSONAL_READ_ONLY_EXECUTION_TARGET = { href: "/", label: "Research" } as const;

type PersonalViewerRole = "owner" | "personal_reviewer";

type DetailState =
  | { kind: "loading" }
  /** 403/404/wrong-artifact — one indistinguishable treatment. */
  | { kind: "unavailable" }
  /** P0 500, or a transport failure: honest and retryable. */
  | { kind: "transient" }
  /**
   * C1 §C/§D — the client's token was rejected. NOT `unavailable`: a stale or
   * revoked session says nothing about whether the report exists.
   */
  | { kind: "auth_error" }
  /** A success payload that cannot be represented honestly. */
  | { kind: "malformed" }
  | { kind: "in_progress"; question: string }
  | { kind: "failed"; question: string }
  | { kind: "ready"; payload: ReadyPayload };

/**
 * TEAM-RESEARCH-PARITY-R2 — the shared, interpreted presentation, narrowed to
 * the Personal roles this address renders. ADD-TO-TEAM-PROJECT §S — the role is
 * kept because "Add to Team Project" is OWNER-ONLY: a `personal_reviewer` can
 * read this page, and the server would reject them on source ownership anyway,
 * but a visible affordance that always fails is a defect, not a safeguard.
 */
type ReadyPayload = PersistedResearchPresentation & { viewerRole: PersonalViewerRole };

/** The Personal-vs-Team ADDRESS decision stays here (R2 §O); the shared interpreter only validates the four-role enum. */
function toPersonalViewerRole(role: PersistedResearchPresentation["viewerRole"]): PersonalViewerRole | null {
  return PERSONAL_VIEWER_ROLES.has(role) ? (role as PersonalViewerRole) : null;
}

export default function PersonalResearchDetailShell({ runId }: { runId: string }) {
  const { user, authReady } = useAuth();
  const router = useRouter();
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [retryTick, setRetryTick] = useState(0);

  /**
   * ADD-TO-TEAM-PROJECT — the first MUTATING affordance on this read surface.
   * Offered only when the report is loaded, the viewer is the OWNER, and the
   * Team offering signal is on (`teamWorkspacesUiEnabled` is never
   * optimistically true). The dialog and its hook are the only path to the
   * mutation; nothing here re-executes research or touches the source.
   */
  const { teamWorkspacesUiEnabled } = useUserPlan();
  const snapshot = useTeamResearchSnapshot();
  const [addToTeamOpen, setAddToTeamOpen] = useState(false);
  const [teamSnapshot, setTeamSnapshot] = useState<TeamResearchSnapshotDto | null>(null);
  const addToTeamTriggerRef = useRef<HTMLButtonElement>(null);

  const guard = useRef(createGenerationGuard()).current;
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Leaving invalidates any in-flight read, so nothing commits into a dead tree.
      guard.next();
    };
  }, [guard]);

  const uid = user?.uid ?? null;

  useEffect(() => {
    // Claimed synchronously, before the first await: this runId (or this uid) is
    // now the page's intent, and any earlier read loses authority immediately.
    const generation = guard.next();
    const controller = new AbortController();
    // Drop the previous run/identity's report before any await — a report loaded
    // under one identity must never be visible under another.
    setState({ kind: "loading" });
    // A Team copy confirmation belongs to ONE run and ONE identity — never carried
    // across a run or uid change.
    setAddToTeamOpen(false);
    setTeamSnapshot(null);

    if (!authReady || !uid) {
      // The server page already gated access; an unsettled client auth state is
      // simply "not yet", never an error.
      return () => controller.abort();
    }

    const owns = () => mountedRef.current && guard.isCurrent(generation);

    void (async () => {
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        /**
         * C1 §C — `authedFetch` retries token ACQUISITION failures; it does not
         * retry an HTTP 401 from the server. So a stale or revoked ID token
         * produced a 401 that this surface read as "unavailable" and reported as
         * "deleted, or not yours" — a lie about the report's existence caused by
         * the viewer's own session. One forced refresh, then an honest auth state.
         */
        const read = (forceTokenRefresh = false) =>
          authedFetch(`/api/user/runs/${encodeURIComponent(runId)}`, {
            user,
            authReady,
            method: "GET",
            signal: controller.signal,
            ...(forceTokenRefresh ? { forceTokenRefresh: true } : {}),
          });

        let res = await read();
        if (!owns()) return;

        if (res.status === 401) {
          if (!user) {
            setState({ kind: "auth_error" });
            return;
          }
          // Exactly one retry. Never a loop: a server that rejects a freshly
          // minted token is telling us the session is finished.
          res = await read(true);
          // The refresh is an await of its own, so ownership is re-established
          // here rather than trusted from before it — a retry that became stale
          // (run A → B, or a uid change) commits nothing.
          if (!owns()) return;
          if (res.status === 401) {
            setState({ kind: "auth_error" });
            return;
          }
        }

        if (res.status === 500) {
          setState({ kind: "transient" });
          return;
        }
        if (!res.ok) {
          // 403/404 alike: never distinguish "doesn't exist" from "not yours".
          // 401 was separated above and can no longer reach this branch.
          setState({ kind: "unavailable" });
          return;
        }

        const data = (await res.json().catch(() => null)) as Record<string, any> | null;
        if (!owns()) return;
        if (!data || data.ok !== true) {
          setState({ kind: "malformed" });
          return;
        }

        /**
         * C1 §B — route containment FIRST, on the raw body, and owned HERE: a
         * known Team role is a real artifact on the wrong address, so it gets
         * the concealed treatment before any interpretation. Everything else is
         * then interpreted by the shared, pure `interpretPersistedRunReadPayload`
         * (R2 §D/§E), which fails CLOSED as malformed on a missing/unknown role,
         * a missing/mismatched run id, or a completed run with nothing to show.
         */
        if (typeof data.viewerRole === "string" && TEAM_VIEWER_ROLES.has(data.viewerRole)) {
          setState({ kind: "unavailable" });
          return;
        }
        const interpreted = interpretPersistedRunReadPayload(data, runId);
        if (interpreted.kind === "malformed") {
          setState({ kind: "malformed" });
          return;
        }
        // Defensive second containment: the interpreter accepts exactly four
        // roles and the two Team roles were concealed above, so only the two
        // Personal roles can reach here. Never rendered as a Personal report
        // otherwise.
        const viewerRole = toPersonalViewerRole(interpreted.kind === "ready" ? interpreted.presentation.viewerRole : interpreted.viewerRole);
        if (viewerRole === null) {
          setState({ kind: "unavailable" });
          return;
        }
        if (interpreted.kind === "in_progress") {
          setState({ kind: "in_progress", question: interpreted.question });
          return;
        }
        if (interpreted.kind === "failed") {
          setState({ kind: "failed", question: interpreted.question });
          return;
        }
        setState({ kind: "ready", payload: { ...interpreted.presentation, viewerRole } });
      } catch {
        // An aborted obsolete request must not surface an error of its own.
        if (!owns()) return;
        setState({ kind: "transient" });
      }
    })();

    return () => controller.abort();
  }, [runId, uid, authReady, user, guard, retryTick]);

  /** Repeats the READ only — never a model panel. */
  const retry = useCallback(() => {
    if (state.kind === "loading") return;
    setRetryTick((n) => n + 1);
  }, [state.kind]);

  /**
   * C1 §J/§N — "VERIFY THIS CLAIM", PRESERVED BY DELEGATION.
   *
   * History used to open saved research inside `/`, where this callback existed.
   * URL-1 moved History to this canonical page — and this page passed no callback,
   * while `DeepResearchView` rendered the button from `runId` + `claimId` alone.
   * The affordance was therefore still visible and did nothing: a direct
   * regression in the Evidence Workspace → Verify This Claim workflow.
   *
   * The fix is a hand-off, not a second pipeline. This navigates to the existing
   * root origin-linked Verify flow with the two canonical selectors and nothing
   * else; the user still submits the verification themselves, and
   * `/api/verify-claim` remains the authority that resolves and validates the
   * saved claim. A malformed pair produces no navigation at all rather than a
   * partial target.
   */
  const handleVerifyClaim = useCallback(
    (args: { runId: string; claimId: string }) => {
      const href = personalResearchVerifyClaimHref(args);
      if (!href) return;
      router.push(href);
    },
    [router]
  );

  /**
   * C1 §R — "Run follow-up" parity, by the same delegation. `?tab=research&q=`
   * pre-fills the root composer and deliberately does not auto-run, so the
   * follow-up keeps its existing "see it before you spend a run on it" semantics
   * and this read surface gains no execution path.
   */
  const handleRunFollowUp = useCallback(
    (followUpQuestion: string) => {
      const href = personalResearchFollowUpHref(followUpQuestion);
      if (!href) return;
      router.push(href);
    },
    [router]
  );

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      {/*
        §X — a one-level Personal hierarchy gets a plain back affordance, not a
        third breadcrumb variant. Team breadcrumbs are untouched.
      */}
      <Link href="/" className="text-sm font-medium text-cp-accent hover:underline">
        &larr; Back to Research
      </Link>

      {state.kind === "loading" && (
        <div role="status" className="mt-6 rounded-xl border border-cp-border bg-cp-surface px-6 py-10 text-center text-sm text-cp-muted shadow-sm">
          Loading this research report…
        </div>
      )}

      {state.kind === "unavailable" && (
        <section className="mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-6">
          <h1 className="text-xl font-semibold text-cp-text">This research isn&apos;t available</h1>
          <p className="mt-2 text-sm text-cp-muted">
            We couldn&apos;t open this report. It may have been deleted, or it may not belong to your account.
          </p>
        </section>
      )}

      {state.kind === "transient" && (
        <section role="alert" className="mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-6">
          <h1 className="text-xl font-semibold text-cp-text">We couldn&apos;t load this report</h1>
          <p className="mt-2 text-sm text-cp-muted">
            Something went wrong on our side. Your research hasn&apos;t gone anywhere — please try again.
          </p>
          <button
            type="button"
            onClick={retry}
            disabled={state.kind !== "transient"}
            className="mt-4 rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
          >
            Try again
          </button>
        </section>
      )}

      {state.kind === "auth_error" && (
        <section role="alert" className="mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-6">
          <h1 className="text-xl font-semibold text-cp-text">We couldn&apos;t verify your session</h1>
          <p className="mt-2 text-sm text-cp-muted">
            Your sign-in could not be confirmed, so we didn&apos;t load this report. This says nothing
            about the report itself — please sign in again and reopen this page.
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
        <section role="alert" className="mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-6">
          <h1 className="text-xl font-semibold text-cp-text">This report couldn&apos;t be displayed</h1>
          <p className="mt-2 text-sm text-cp-muted">
            The saved result for this research couldn&apos;t be read. Nothing was changed.
          </p>
        </section>
      )}

      {state.kind === "in_progress" && (
        <>
          <h1 className="mt-4 text-xl font-semibold text-cp-text break-words">{state.question}</h1>
          <section className="mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-5 text-sm text-cp-muted">
            This research is still in progress. Refresh this page to check again.
          </section>
        </>
      )}

      {state.kind === "failed" && (
        <>
          <h1 className="mt-4 text-xl font-semibold text-cp-text break-words">{state.question}</h1>
          <section role="alert" className="mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-5 text-sm text-cp-muted">
            This research run didn&apos;t finish successfully. Nothing was saved for it.
          </section>
        </>
      )}

      {state.kind === "ready" && (
        <>
          <h1 className="mt-4 text-xl font-semibold text-cp-text break-words">{state.payload.question}</h1>
          {state.payload.viewerRole === "owner" && teamWorkspacesUiEnabled && (
            <div className="mt-3">
              <button
                ref={addToTeamTriggerRef}
                type="button"
                disabled={snapshot.isSourceBusy(state.payload.runId)}
                onClick={() => setAddToTeamOpen(true)}
                className="rounded-lg border border-cp-border px-3 py-1.5 text-xs font-medium text-cp-text transition-colors hover:bg-cp-surface disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add to Team Project
              </button>
              {addToTeamOpen && (
                <AddToTeamProjectDialog
                  sourceRunId={state.payload.runId}
                  triggerRef={addToTeamTriggerRef}
                  onClose={() => setAddToTeamOpen(false)}
                  snapshot={snapshot}
                  onCreated={(result) => {
                    setAddToTeamOpen(false);
                    setTeamSnapshot(result);
                  }}
                />
              )}
            </div>
          )}
          {teamSnapshot && (
            <p role="status" className="mt-3 rounded-lg border border-cp-border bg-cp-primary-tint px-3 py-2 text-sm text-cp-text">
              {teamSnapshot.status === "created" ? "A Team copy of this research was created." : "This research is already in that Team Project."}{" "}
              <Link href={teamSnapshot.href} className="font-medium text-cp-accent hover:underline">
                Open the Team copy
              </Link>
              . Your Personal report is unchanged.
            </p>
          )}
          {/*
            TEAM-RESEARCH-PARITY-R2 — the report itself (restore notice, read-only
            ResultsDisplay with synthesis generation DISABLED, adaptive
            presentation) is the shared persisted-result view. §AO / C1 §J/§N/§R —
            read-only refers to DIRECT research execution: the two delegated
            actions execute nothing here, they hand off to the established root
            flows, which is what keeps the durable report from being a weaker
            version of the saved-research experience.
          */}
          <PersistedResearchResultView
            presentation={state.payload}
            onVerifyClaim={handleVerifyClaim}
            onRunFollowUp={handleRunFollowUp}
            readOnlyExecutionTarget={PERSONAL_READ_ONLY_EXECUTION_TARGET}
          />
        </>
      )}
    </main>
  );
}
