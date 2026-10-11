"use client";

/**
 * Order 3 — read-only Workspace review integrity metrics. Rendered only on the
 * Team audit page (already gated server-side by admission + `audit.read`, and
 * mounted only when the release flag is on); the API re-authorizes
 * independently.
 *
 * One GET, no actions, no writes, no reviewer identity. Exact counts with
 * their denominators — never a score, percentage, rank or quality judgement.
 * A response that does not reconcile (`reconcileReviewIntegrityMetrics`) is
 * not rendered.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import type { ReviewIntegrityMetricsV1 } from "@/lib/governance/reviewIntegrityMetrics";
import { presentReviewIntegrityMetrics, reconcileReviewIntegrityMetrics, type PresentedReviewIntegrity } from "@/lib/governance/reviewIntegrityMetricsPresentation";

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; presented: PresentedReviewIntegrity };

export default function WorkspaceReviewIntegrityMetrics({ workspaceId }: { workspaceId: string }) {
  const { user, authReady } = useAuth();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/review-integrity-metrics`, { method: "GET", user, authReady });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; metrics?: unknown; message?: string } | null;
        if (cancelled) return;
        if (!res.ok || !body?.ok || body.metrics === undefined) {
          setState({ kind: "error", message: body?.message ?? "Review integrity metrics could not be loaded." });
          return;
        }
        if (reconcileReviewIntegrityMetrics(body.metrics).length > 0) {
          setState({ kind: "error", message: "Review integrity metrics are temporarily unavailable." });
          return;
        }
        setState({ kind: "ready", presented: presentReviewIntegrityMetrics(body.metrics as ReviewIntegrityMetricsV1) });
      } catch {
        if (!cancelled) setState({ kind: "error", message: "Review integrity metrics could not be loaded." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, authReady, workspaceId]);

  return (
    <section data-testid="review-integrity-metrics" className="mt-6 rounded-xl border border-cp-border bg-cp-surface p-5">
      <h2 className="text-lg font-semibold text-cp-text">Review integrity</h2>
      <p className="mt-1 text-sm text-cp-muted">
        Recorded human-review outcomes and decision paths for completed adaptive research in this Workspace. Counts reflect persisted governance records; missing provenance is not inferred.
      </p>
      {state.kind === "loading" && <p className="mt-4 text-sm text-cp-muted">Loading…</p>}
      {state.kind === "error" && (
        <p data-testid="review-integrity-error" className="mt-4 text-sm text-cp-muted">
          {state.message}
        </p>
      )}
      {state.kind === "ready" && state.presented.kind === "empty" && (
        <p data-testid="review-integrity-empty" className="mt-4 text-sm text-cp-muted">
          {state.presented.message}
        </p>
      )}
      {state.kind === "ready" && state.presented.kind === "ready" && <MetricsBody presented={state.presented} />}
    </section>
  );
}

function MetricsBody({ presented }: { presented: Extract<PresentedReviewIntegrity, { kind: "ready" }> }) {
  const { reviewState, decisionPath, multiReviewer } = presented;
  return (
    <>
      <div data-testid="review-integrity-states" className="mt-4">
        <h3 className="text-sm font-semibold text-cp-text">Recorded review state</h3>
        <ul className="mt-2 space-y-1 text-sm text-cp-text">
          <li>Completed adaptive research: {reviewState.total}</li>
          {reviewState.rows.map((r) => (
            <li key={r.key} data-testid={`review-integrity-state-${r.key}`}>
              {r.label}: {r.count}
            </li>
          ))}
        </ul>
      </div>
      <div data-testid="review-integrity-paths" className="mt-5 border-t border-cp-border-soft pt-4">
        <h3 className="text-sm font-semibold text-cp-text">Recorded decision path</h3>
        <ul className="mt-2 space-y-1 text-sm text-cp-text">
          <li>Terminal human decisions: {decisionPath.terminal}</li>
          {decisionPath.rows.map((r) => (
            <li key={r.key} data-testid={`review-integrity-path-${r.key}`}>
              {r.label}: {r.count}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-cp-muted">{decisionPath.note}</p>
      </div>
      <div data-testid="review-integrity-multi" className="mt-5 border-t border-cp-border-soft pt-4">
        <h3 className="text-sm font-semibold text-cp-text">Multi-reviewer decisions</h3>
        <ul className="mt-2 space-y-1 text-sm text-cp-text">
          <li>Explicit multi-reviewer decisions: {multiReviewer.explicit}</li>
          <li>Panel finalizations: {multiReviewer.panelFinalizations}</li>
          <li data-testid="review-integrity-owner-overrides">{multiReviewer.ownerOverrideLine}</li>
        </ul>
      </div>
      <p className="mt-4 text-xs text-cp-muted">Project integrity exclusions (not counted above): {presented.projectIntegrityExclusions}</p>
    </>
  );
}
