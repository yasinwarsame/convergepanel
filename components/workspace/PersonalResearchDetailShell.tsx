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
import { useAuth } from "@/components/AuthProvider";
import { createGenerationGuard } from "@/lib/client/authGeneration";
import ResultsDisplay from "@/components/ResultsDisplay";
import {
  adaptPersistedOutputToPanelPayload,
  adaptPersistedLegacyOutputToPanelPayload,
} from "@/lib/user/adaptivePersistedOutputAdapter";
import type { ModelResult, ModelId } from "@/lib/types";

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

type DetailState =
  | { kind: "loading" }
  /** 403/404/wrong-artifact — one indistinguishable treatment. */
  | { kind: "unavailable" }
  /** P0 500, or a transport failure: honest and retryable. */
  | { kind: "transient" }
  /** A success payload that cannot be represented honestly. */
  | { kind: "malformed" }
  | { kind: "in_progress"; question: string }
  | { kind: "failed"; question: string }
  | { kind: "ready"; payload: ReadyPayload };

type ReadyPayload = {
  runId: string;
  question: string;
  results: ModelResult[];
  adaptive: ReturnType<typeof adaptPersistedOutputToPanelPayload> | null;
  restoreNotice: string | null;
  synthesisReport: unknown;
  synthesisConsensusSummary: unknown;
  orgGovernanceStatus: "approved" | "needs_review" | "blocked" | null;
  governance: unknown;
};

export default function PersonalResearchDetailShell({ runId }: { runId: string }) {
  const { user, authReady } = useAuth();
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [retryTick, setRetryTick] = useState(0);

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

    if (!authReady || !uid) {
      // The server page already gated access; an unsettled client auth state is
      // simply "not yet", never an error.
      return () => controller.abort();
    }

    const owns = () => mountedRef.current && guard.isCurrent(generation);

    void (async () => {
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const res = await authedFetch(`/api/user/runs/${encodeURIComponent(runId)}`, {
          user,
          authReady,
          method: "GET",
          signal: controller.signal,
        });
        if (!owns()) return;

        if (res.status === 500) {
          setState({ kind: "transient" });
          return;
        }
        if (!res.ok) {
          // 401/403/404 alike: never distinguish "doesn't exist" from "not yours".
          setState({ kind: "unavailable" });
          return;
        }

        const data = (await res.json().catch(() => null)) as Record<string, any> | null;
        if (!owns()) return;
        if (!data || data.ok !== true) {
          setState({ kind: "malformed" });
          return;
        }

        // Route containment: a Team viewer role is not welcome on the Personal address.
        if (typeof data.viewerRole === "string" && !PERSONAL_VIEWER_ROLES.has(data.viewerRole)) {
          setState({ kind: "unavailable" });
          return;
        }
        // The response must describe the run that was asked for.
        if (typeof data.runId === "string" && data.runId.length > 0 && data.runId !== runId) {
          setState({ kind: "malformed" });
          return;
        }

        const question = typeof data.question === "string" ? data.question : "";
        const status = typeof data.status === "string" ? data.status : "";
        if (status === "queued" || status === "running") {
          setState({ kind: "in_progress", question });
          return;
        }
        if (status === "error" || status === "failed") {
          setState({ kind: "failed", question });
          return;
        }

        // Same envelope ORDER the root uses: adaptive, then procedural
        // legacy-adaptive, then legacy results. `adaptive.status === "absent"` is
        // NOT proof a run is ordinary legacy research — it is also correct for
        // every procedural run, which is what previously leaked structured JSON
        // into prose synthesis.
        let adaptive: ReadyPayload["adaptive"] = null;
        let restoreNotice: string | null = null;
        if (data.adaptive?.status === "valid" && data.adaptive.output) {
          adaptive = adaptPersistedOutputToPanelPayload(data.adaptive.output, {
            humanReview: data.adaptive.humanReview,
            reviewRouting: data.adaptive.reviewRouting,
          });
        } else if (data.legacyAdaptive?.status === "valid" && data.legacyAdaptive.output) {
          adaptive = adaptPersistedLegacyOutputToPanelPayload(data.legacyAdaptive.output);
        } else if (
          data.adaptive?.status === "malformed" ||
          data.legacyAdaptive?.status === "malformed"
        ) {
          restoreNotice =
            "This run's structured result couldn't be restored — showing the raw model responses instead.";
        } else if (
          data.adaptive?.status === "unsupported_version" ||
          data.legacyAdaptive?.status === "unsupported_version"
        ) {
          restoreNotice =
            "This run's structured result was saved by a newer version of ConvergePanel — showing the raw model responses instead.";
        }

        const results = Array.isArray(data.results) ? (data.results as ModelResult[]) : [];
        // A completed artifact with neither a structured result nor usable legacy
        // rows cannot be shown honestly. It is NOT "you haven't run this yet".
        if (!adaptive && results.length === 0) {
          setState({ kind: "malformed" });
          return;
        }

        const og = data.governanceStatus;
        setState({
          kind: "ready",
          payload: {
            runId: typeof data.runId === "string" && data.runId ? data.runId : runId,
            question,
            results,
            adaptive,
            restoreNotice,
            synthesisReport: data.synthesisCache?.report ?? null,
            synthesisConsensusSummary: data.synthesisCache?.consensusSummary ?? null,
            orgGovernanceStatus:
              og === "approved" || og === "needs_review" || og === "blocked" ? og : null,
            governance: data.governance ?? undefined,
          },
        });
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
          {state.payload.restoreNotice && (
            <p className="mt-3 rounded-lg border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-muted">
              {state.payload.restoreNotice}
            </p>
          )}
          <div className="mt-6">
            <ResultsDisplay
              results={state.payload.results}
              synthesizedReport={null}
              question={state.payload.question}
              runId={state.payload.runId}
              adaptive={state.payload.adaptive}
              synthesisStatus={state.payload.synthesisReport ? "complete" : "idle"}
              synthesisReport={state.payload.synthesisReport}
              synthesisConsensusSummary={state.payload.synthesisConsensusSummary as never}
              orgGovernanceStatus={state.payload.orgGovernanceStatus}
              teamGovernance={state.payload.governance as never}
              /*
                §AO — this is a durable READ surface. `onRerun`/`onAddModel` are
                required props whose real behaviour is the research execution
                pipeline, which must not be duplicated here. `readOnlyActions`
                makes those execution affordances render as an honest pointer back
                to the composer instead of buttons whose copy promises a re-run
                they would not perform. The callbacks stay required by the existing
                prop contract and are never invoked in this mode.
              */
              readOnlyActions
              onRerun={() => {}}
              onAddModel={() => {}}
            />
          </div>
        </>
      )}
    </main>
  );
}
