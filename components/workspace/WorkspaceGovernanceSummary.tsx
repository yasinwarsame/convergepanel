"use client";

/**
 * Step 6.3 — read-only Workspace governance summary (contract:
 * docs/governance-workspace-summary-contract.md). Rendered only on the Team
 * audit page, which is already gated server-side by admission + `audit.read`;
 * the API re-authorizes independently.
 *
 * Read-only: one GET, no actions, no writes. Shows exact counts with their
 * denominators, keeps automated outcomes and human decisions apart, and never
 * computes or shows a score, tier, percentage or ranking. A response that does
 * not reconcile (`reconcileGovernanceSummary`) is not rendered.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import type { WorkspaceGovernanceSummary as Summary } from "@/lib/governance/workspaceGovernanceSummary";
import { FAMILY_LABELS, presentFamilies, reconcileGovernanceSummary, rollupAutomatedOutcomes } from "@/lib/governance/workspaceGovernanceSummaryPresentation";

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; summary: Summary };

export default function WorkspaceGovernanceSummary({ workspaceId }: { workspaceId: string }) {
  const { user, authReady } = useAuth();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/governance-summary`, { method: "GET", user, authReady });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; summary?: Summary; message?: string } | null;
        if (cancelled) return;
        if (!res.ok || !body?.ok || !body.summary) {
          setState({ kind: "error", message: body?.message ?? "The governance summary could not be loaded." });
          return;
        }
        if (reconcileGovernanceSummary(body.summary).length > 0) {
          setState({ kind: "error", message: "The governance summary is temporarily unavailable." });
          return;
        }
        setState({ kind: "ready", summary: body.summary });
      } catch {
        if (!cancelled) setState({ kind: "error", message: "The governance summary could not be loaded." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, authReady, workspaceId]);

  return (
    <section data-testid="governance-summary" className="mt-6 rounded-xl border border-cp-border bg-cp-surface p-5">
      <h2 className="text-lg font-semibold text-cp-text">Governance coverage</h2>
      <p className="mt-1 text-sm text-cp-muted">
        Exact counts of completed work in this Workspace by recorded governance outcome. Automated outcomes and human decisions are counted separately. These are counts only; they are never combined into a single quality measure.
      </p>
      {state.kind === "loading" && <p className="mt-4 text-sm text-cp-muted">Loading…</p>}
      {state.kind === "error" && (
        <p data-testid="governance-summary-error" className="mt-4 text-sm text-cp-muted">
          {state.message}
        </p>
      )}
      {state.kind === "ready" && <SummaryBody summary={state.summary} />}
    </section>
  );
}

function SummaryBody({ summary }: { summary: Summary }) {
  const rollup = rollupAutomatedOutcomes(summary);
  const families = presentFamilies(summary);
  return (
    <>
      <div data-testid="governance-summary-rollup" className="mt-4">
        <h3 className="text-sm font-semibold text-cp-text">Automated outcomes across all families ({rollup.denominator} records)</h3>
        <ul className="mt-2 space-y-1 text-sm text-cp-text">
          {rollup.buckets
            .filter((b) => b.count > 0)
            .map((b) => (
              <li key={b.outcome} data-testid={`governance-rollup-${b.outcome}`}>
                {b.label}: {b.count} of {rollup.denominator}
                <span className="text-cp-muted"> ({b.byFamily.map((x) => `${FAMILY_LABELS[x.family]} ${x.count}`).join(", ")})</span>
              </li>
            ))}
        </ul>
      </div>
      {families.map((f) => (
        <div key={f.family} data-testid={`governance-family-${f.family}`} className="mt-5 border-t border-cp-border-soft pt-4">
          <h3 className="text-sm font-semibold text-cp-text">
            {f.label} — {f.total} completed
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-cp-text">
            {f.automated.map((a, i) => (
              <li key={`${a.outcome}-${i}`}>
                {a.label}
                {a.detail ? ` (${a.detail})` : ""}: {a.count} of {f.automatedDenominator}
              </li>
            ))}
          </ul>
          {f.human.length > 0 && (
            <>
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-cp-muted">Human decisions</p>
              <ul className="mt-1 space-y-1 text-sm text-cp-text">
                {f.human.map((h, i) => (
                  <li key={`${h.label}-${i}`}>
                    {h.label}: {h.count}
                  </li>
                ))}
              </ul>
            </>
          )}
          <ul className="mt-3 space-y-1 text-xs text-cp-muted">
            {f.excludedNotComplete !== undefined && <li>Not yet complete (not counted above): {f.excludedNotComplete}</li>}
            <li>Excluded for Project integrity: {f.integrityAnomalies}</li>
            {f.reviewedMalformed > 0 && <li>Reviewed with an unrecognized status (not counted as a decision): {f.reviewedMalformed}</li>}
            {f.overlap > 0 && <li>Records with conflicting governance data (not counted): {f.overlap}</li>}
          </ul>
        </div>
      ))}
    </>
  );
}
