"use client";

/**
 * Multi-Reviewer Owner Override, Part F (§F11/§F12/§F15/§F16/§F18/§F19) —
 * the top-level multi-reviewer panel section on the adaptive review detail
 * page. Orchestrates: panel management (create/reconfigure/cancel),
 * reviewer selection, quorum/aggregation display, vote submission
 * (delegated to `AdaptivePanelVoteForm`), finalization, and owner override
 * (delegated to `AdaptivePanelOverrideForm`).
 *
 * `GET .../review-panel` is the single canonical data source for
 * everything in this component — capability flags
 * (`canReconfigurePanel`/`canCancelPanel`/`canVote`/`canFinalize`/`canOverride`)
 * come directly from the server's own read model (§F10, split per Step
 * 5.10's production-readiness hardening), never re-derived client-side, so
 * this component can never grant a control the server would reject.
 * `canReconfigurePanel` and `canCancelPanel` are independently gated (the
 * server may return one true and the other false — e.g. once multi-reviewer
 * has been disabled, an already-open panel remains cancellable but not
 * reconfigurable), so this component renders them as two independently
 * gated controls, never a single combined toggle.
 *
 * Reports the panel's existence/status to the parent via
 * `onPanelStatusChange` so `AdaptiveReviewDetail` can hide the
 * single-reviewer assignment/decision UI while a panel is `"open"` or
 * `"finalized"` — restored automatically once the panel is `"cancelled"`
 * or absent (§F11's coexistence requirement).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { MIN_ADAPTIVE_PANEL_REVIEWERS, MAX_ADAPTIVE_PANEL_REVIEWERS } from "@/lib/governance/adaptiveHumanReviewPanel";
import { mapAdaptivePanelErrorCode } from "@/lib/client/adaptivePanelSubmission";
import AdaptiveReviewerSelectionList, { EligiblePanelReviewer } from "./AdaptiveReviewerSelectionList";
import AdaptivePanelVoteForm from "./AdaptivePanelVoteForm";
import AdaptivePanelOverrideForm from "./AdaptivePanelOverrideForm";

type PanelReviewer = {
  userId: string;
  displayName?: string;
  isCurrentUser: boolean;
  hasSubmittedVote: boolean;
  voteStatus?: string;
  submittedAt?: string;
};

type RichPanel = {
  mode: "majority_quorum";
  status: "open" | "cancelled" | "finalized";
  revision: number;
  reviewers: PanelReviewer[];
  requiredReviewerCount: number;
  quorum: number;
  submittedCount: number;
  aggregationState: "waiting" | "deadlocked" | "ready" | "finalized";
  readyFinalStatus?: string;
  finalStatus?: string;
  finalizedAt?: string;
  finalizedVia?: "aggregation" | "owner_override";
  canReconfigurePanel: boolean;
  canCancelPanel: boolean;
  canVote: boolean;
  canFinalize: boolean;
  canOverride: boolean;
};

function formatDatetime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const STATUS_LABEL: Record<string, string> = {
  approved: "Approved",
  approved_with_conditions: "Approved with Conditions",
  changes_requested: "Changes Requested",
  rejected: "Rejected",
};

export default function AdaptiveMultiReviewerPanelSection({
  runId,
  expectedGovernanceUpdatedAt,
  onPanelStatusChange,
}: {
  runId: string;
  expectedGovernanceUpdatedAt: string;
  onPanelStatusChange?: (status: "open" | "cancelled" | "finalized" | null) => void;
}) {
  const { user, authReady, canMutate } = useAuth();
  const [panel, setPanel] = useState<RichPanel | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [eligibleReviewers, setEligibleReviewers] = useState<EligiblePanelReviewer[]>([]);
  // Server-derived (§F19) — never re-derived from the global env flag or
  // team settings client-side. Only meaningful while `panel === null`; the
  // GET route only computes/returns it in that exact branch.
  const [canCreatePanel, setCanCreatePanel] = useState(false);

  const [showConfigForm, setShowConfigForm] = useState(false);
  const [selectedReviewerIds, setSelectedReviewerIds] = useState<string[]>([]);
  const [configSubmitting, setConfigSubmitting] = useState(false);
  const [configMessage, setConfigMessage] = useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);

  const [cancelling, setCancelling] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeMessage, setFinalizeMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  // A stale in-flight request from a PREVIOUS runId (e.g. still resolving
  // after the operator navigates from one review to another, without a full
  // page reload — `AdaptiveReviewDetail`/this component are never remounted
  // by that client-side transition, only re-rendered with a new `runId`
  // prop) must never be allowed to overwrite state a newer request already
  // set — mirrors `TeamReviewQueue.tsx`'s own `abortRef` pattern, the
  // established fix for this exact class of race in this codebase.
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!user || !authReady) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadError(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const [panelRes, assignmentRes] = await Promise.all([
        authedFetch(`/api/teams/adaptive-runs/${encodeURIComponent(runId)}/review-panel`, { user, authReady, method: "GET", cache: "no-store", signal: controller.signal }),
        authedFetch(`/api/teams/adaptive-runs/${encodeURIComponent(runId)}/assignment`, { user, authReady, method: "GET", cache: "no-store", signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;

      if (assignmentRes.ok) {
        const assignmentJson = await assignmentRes.json();
        if (assignmentJson.ok) setEligibleReviewers(assignmentJson.eligibleReviewers ?? []);
      }

      if (!panelRes.ok) {
        setLoadError("The multi-reviewer panel is temporarily unavailable.");
        onPanelStatusChange?.(null);
        return;
      }
      const json = await panelRes.json();
      if (controller.signal.aborted) return;
      if (!json.ok) {
        setLoadError("The multi-reviewer panel is temporarily unavailable.");
        onPanelStatusChange?.(null);
        return;
      }
      setPanel(json.panel);
      setCanCreatePanel(json.panel === null ? Boolean(json.canCreatePanel) : false);
      onPanelStatusChange?.(json.panel ? json.panel.status : null);
    } catch {
      if (controller.signal.aborted) return;
      setLoadError("The multi-reviewer panel is temporarily unavailable.");
      onPanelStatusChange?.(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authReady, runId]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const submitConfig = async () => {
    // Auth Lifecycle Hardening, Step 6.3/6.9 — `canMutate` requires the
    // server session-cookie uid to already be confirmed matching the
    // client's, not just that SOME Firebase user is present.
    if (!user || !authReady || !canMutate || configSubmitting) return;
    if (selectedReviewerIds.length < MIN_ADAPTIVE_PANEL_REVIEWERS || selectedReviewerIds.length > MAX_ADAPTIVE_PANEL_REVIEWERS) {
      setConfigMessage({ kind: "error", text: `Select between ${MIN_ADAPTIVE_PANEL_REVIEWERS} and ${MAX_ADAPTIVE_PANEL_REVIEWERS} reviewers.` });
      return;
    }
    setConfigSubmitting(true);
    setConfigMessage(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch(`/api/teams/adaptive-runs/${encodeURIComponent(runId)}/review-panel`, {
        user,
        authReady,
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewerUserIds: selectedReviewerIds, expectedRevision: panel?.revision ?? 0 }),
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        const mapped = mapAdaptivePanelErrorCode(json?.error?.code ?? "unknown");
        setConfigMessage({ kind: "error", text: mapped.message });
        if (mapped.kind === "stale" || mapped.kind === "terminal") void load();
        return;
      }
      setConfigMessage({ kind: "success", text: panel ? "Panel reconfigured. Previous votes no longer apply to the new revision." : "Panel created." });
      setShowConfigForm(false);
      setSelectedReviewerIds([]);
      await load();
    } catch {
      setConfigMessage({ kind: "error", text: "Could not save the panel. Please try again." });
    } finally {
      setConfigSubmitting(false);
    }
  };

  const submitCancel = async () => {
    if (!user || !authReady || !canMutate || cancelling || !panel) return;
    setCancelling(true);
    setConfigMessage(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch(`/api/teams/adaptive-runs/${encodeURIComponent(runId)}/review-panel`, {
        user,
        authReady,
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: panel.revision }),
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        const mapped = mapAdaptivePanelErrorCode(json?.error?.code ?? "unknown");
        setConfigMessage({ kind: "error", text: mapped.message });
        if (mapped.kind === "stale" || mapped.kind === "terminal") void load();
        return;
      }
      setConfigMessage({ kind: "success", text: "Panel cancelled. Single-reviewer review is available again." });
      await load();
    } catch {
      setConfigMessage({ kind: "error", text: "Could not cancel the panel. Please try again." });
    } finally {
      setCancelling(false);
    }
  };

  const submitFinalize = async () => {
    if (!user || !authReady || !canMutate || finalizing || !panel) return;
    setFinalizing(true);
    setFinalizeMessage(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch(`/api/teams/adaptive-runs/${encodeURIComponent(runId)}/review-panel/finalize`, {
        user,
        authReady,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedPanelRevision: panel.revision, expectedGovernanceUpdatedAt }),
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        const mapped = mapAdaptivePanelErrorCode(json?.error?.code ?? "unknown");
        setFinalizeMessage({ kind: "error", text: mapped.message });
        if (mapped.kind === "stale" || mapped.kind === "terminal") void load();
        return;
      }
      await load();
    } catch {
      setFinalizeMessage({ kind: "error", text: "Could not finalize the panel. Please try again." });
    } finally {
      setFinalizing(false);
    }
  };

  const openConfigForm = () => {
    setSelectedReviewerIds(panel?.reviewers.map((r) => r.userId) ?? []);
    setConfigMessage(null);
    setShowConfigForm(true);
  };

  if (panel === undefined) {
    return (
      <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
        <h2 className="text-base font-bold text-cp-text">Multi-Reviewer Panel</h2>
        <div className="mt-3 text-sm text-cp-muted" aria-live="polite">
          Loading review panel…
        </div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
        <h2 className="text-base font-bold text-cp-text">Multi-Reviewer Panel</h2>
        <p className="mt-3 text-sm text-cp-muted" role="status">
          {loadError}
        </p>
      </section>
    );
  }

  // ---- No panel (§F11) ----
  if (panel === null) {
    return (
      <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
        <h2 className="text-base font-bold text-cp-text">Multi-Reviewer Panel</h2>
        <p className="mt-2 text-sm text-cp-muted">
          No multi-reviewer panel exists for this run. The reviewer above handles this review directly.
        </p>
        {canCreatePanel ? (
          !showConfigForm ? (
            <button
              type="button"
              onClick={openConfigForm}
              className="mt-3 rounded-lg border border-cp-border px-3 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
            >
              Create a multi-reviewer panel
            </button>
          ) : (
            <div className="mt-3 space-y-3">
              <p className="rounded-lg bg-cp-raised px-3 py-2 text-xs text-cp-muted">
                Creating an open panel replaces direct single-reviewer review for this run — reviewers vote instead.
              </p>
              <AdaptiveReviewerSelectionList eligibleReviewers={eligibleReviewers} selected={selectedReviewerIds} onChange={setSelectedReviewerIds} disabled={configSubmitting} />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={submitConfig}
                  disabled={configSubmitting || !canMutate}
                  className="rounded-lg bg-cp-primary px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                >
                  {configSubmitting ? "Creating…" : "Create panel"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowConfigForm(false)}
                  disabled={configSubmitting}
                  className="rounded-lg border border-cp-border px-3 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )
        ) : null}
        {configMessage ? (
          <p className={`mt-3 text-xs font-medium ${configMessage.kind === "success" ? "text-emerald-400" : configMessage.kind === "error" ? "text-red-400" : "text-cp-muted"}`} role={configMessage.kind === "error" ? "alert" : "status"} aria-live="polite">
            {configMessage.text}
          </p>
        ) : null}
      </section>
    );
  }

  // ---- Cancelled (§F11) ----
  if (panel.status === "cancelled") {
    return (
      <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
        <h2 className="text-base font-bold text-cp-text">Multi-Reviewer Panel</h2>
        <p className="mt-2 rounded-lg bg-cp-raised px-3 py-2 text-xs text-cp-muted" role="status">
          This panel was cancelled. Single-reviewer review is available above.
        </p>
        <ul className="mt-3 space-y-1 text-sm text-cp-text">
          {panel.reviewers.map((r) => (
            <li key={r.userId}>{r.displayName ?? r.userId}</li>
          ))}
        </ul>
      </section>
    );
  }

  // ---- Finalized (§F11) ----
  if (panel.status === "finalized") {
    return (
      <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
        <h2 className="text-base font-bold text-cp-text">Multi-Reviewer Panel</h2>
        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-cp-muted">Final status</dt>
            <dd className="text-cp-text">{STATUS_LABEL[panel.finalStatus ?? ""] ?? panel.finalStatus}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-cp-muted">Finalized</dt>
            <dd className="text-cp-text">{formatDatetime(panel.finalizedAt)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-cp-muted">Via</dt>
            <dd className="text-cp-text">{panel.finalizedVia === "owner_override" ? "Owner override" : "Panel vote"}</dd>
          </div>
        </dl>
        <p className="mt-3 rounded-lg bg-cp-raised px-3 py-2 text-xs text-cp-muted" role="status">
          This panel has reached a final decision and can no longer be changed.
        </p>
        <ul className="mt-3 space-y-1 text-sm text-cp-text">
          {panel.reviewers.map((r) => (
            <li key={r.userId} className="flex justify-between">
              <span>{r.displayName ?? r.userId}</span>
              <span className="text-xs text-cp-muted">{r.hasSubmittedVote ? STATUS_LABEL[r.voteStatus ?? ""] ?? r.voteStatus : "No vote"}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  // ---- Open (§F11/§F15/§F16/§F17) ----
  const stateCopy =
    panel.aggregationState === "waiting"
      ? "Waiting for more reviewer votes."
      : panel.aggregationState === "deadlocked"
        ? "The panel is deadlocked. More votes, panel reconfiguration, or an owner override is required."
        : panel.aggregationState === "ready"
          ? `Ready to finalize as ${STATUS_LABEL[panel.readyFinalStatus ?? ""] ?? panel.readyFinalStatus}.`
          : "";

  return (
    <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <h2 className="text-base font-bold text-cp-text">Multi-Reviewer Panel</h2>
      <p className="mt-1 text-xs text-cp-muted">
        {panel.submittedCount} of {panel.requiredReviewerCount} reviewers voted (quorum {panel.quorum}).
      </p>
      <p className="mt-2 text-sm font-medium text-cp-text" role="status" aria-live="polite">
        {stateCopy}
      </p>

      <ul className="mt-3 space-y-1 text-sm text-cp-text">
        {panel.reviewers.map((r) => (
          <li key={r.userId} className="flex items-center justify-between">
            <span>
              {r.displayName ?? r.userId}
              {r.isCurrentUser ? <span className="ml-2 rounded bg-cp-primary-soft px-2 py-0.5 text-xs font-bold text-cp-primary">You</span> : null}
            </span>
            <span className="text-xs text-cp-muted">{r.hasSubmittedVote ? STATUS_LABEL[r.voteStatus ?? ""] ?? r.voteStatus : "Not yet voted"}</span>
          </li>
        ))}
      </ul>

      {panel.canVote ? (
        <div className="mt-4 border-t border-cp-border pt-4">
          <AdaptivePanelVoteForm runId={runId} panelRevision={panel.revision} onSuccess={() => void load()} onRequestReload={() => void load()} />
        </div>
      ) : null}

      {panel.canFinalize ? (
        <div className="mt-4 border-t border-cp-border pt-4">
          <button
            type="button"
            onClick={submitFinalize}
            disabled={finalizing || !canMutate}
            aria-busy={finalizing}
            className="rounded-lg bg-cp-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
          >
            {finalizing ? "Finalizing…" : "Finalize"}
          </button>
          {finalizeMessage ? (
            <p className="mt-2 text-xs font-medium text-red-400" role="alert">
              {finalizeMessage.text}
            </p>
          ) : null}
        </div>
      ) : null}

      {panel.canReconfigurePanel || panel.canCancelPanel ? (
        <div className="mt-4 border-t border-cp-border pt-4">
          {!showConfigForm ? (
            <div className="flex flex-wrap gap-2">
              {panel.canReconfigurePanel ? (
                <button
                  type="button"
                  onClick={openConfigForm}
                  className="rounded-lg border border-cp-border px-3 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
                >
                  Reconfigure reviewers
                </button>
              ) : null}
              {panel.canCancelPanel ? (
                <button
                  type="button"
                  onClick={submitCancel}
                  disabled={cancelling || !canMutate}
                  className="rounded-lg border border-cp-border px-3 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                >
                  {cancelling ? "Cancelling…" : "Cancel panel"}
                </button>
              ) : null}
              {!panel.canReconfigurePanel ? (
                <p className="basis-full text-xs text-cp-muted">
                  Multi-reviewer panel review has been disabled — this panel can still be cancelled, but not reconfigured.
                </p>
              ) : null}
            </div>
          ) : (
            // Only reachable via `openConfigForm`, which is itself only
            // ever rendered behind `panel.canReconfigurePanel` above — so
            // `canReconfigurePanel` is already guaranteed true here.
            <div className="space-y-3">
              <p className="rounded-lg bg-cp-raised px-3 py-2 text-xs text-cp-muted">
                Reconfiguring starts a new revision — all existing votes for this panel no longer apply.
              </p>
              <AdaptiveReviewerSelectionList eligibleReviewers={eligibleReviewers} selected={selectedReviewerIds} onChange={setSelectedReviewerIds} disabled={configSubmitting} />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={submitConfig}
                  disabled={configSubmitting || !canMutate}
                  className="rounded-lg bg-cp-primary px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                >
                  {configSubmitting ? "Saving…" : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowConfigForm(false)}
                  disabled={configSubmitting}
                  className="rounded-lg border border-cp-border px-3 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {configMessage ? (
            <p className={`mt-2 text-xs font-medium ${configMessage.kind === "success" ? "text-emerald-400" : configMessage.kind === "error" ? "text-red-400" : "text-cp-muted"}`} role={configMessage.kind === "error" ? "alert" : "status"} aria-live="polite">
              {configMessage.text}
            </p>
          ) : null}
        </div>
      ) : null}

      {panel.canOverride ? (
        <div className="mt-4 border-t border-cp-border pt-4">
          <AdaptivePanelOverrideForm
            runId={runId}
            expectedPanelRevision={panel.revision}
            expectedGovernanceUpdatedAt={expectedGovernanceUpdatedAt}
            onSuccess={() => void load()}
            onRequestReload={() => void load()}
          />
        </div>
      ) : null}
    </section>
  );
}
