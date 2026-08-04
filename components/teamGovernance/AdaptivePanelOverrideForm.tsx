"use client";

/**
 * Multi-Reviewer Owner Override, Part F (§F17/§F18/§F19) — owner-only
 * override form. The PARENT is solely responsible for only ever rendering
 * this component to a caller whose role is exactly `"owner"` while the
 * panel is open and the canonical review is reviewable — this component
 * does not re-derive or re-check that authorization itself, but the
 * server-side route independently re-enforces owner-only regardless (never
 * trust the client gate alone). Clearly, visually distinct from ordinary
 * finalization: explicit status choice, a REQUIRED justification, and an
 * explicit confirmation checkbox that must be checked before the one POST
 * can be sent. Never auto-retried. Votes are never read, shown as an input,
 * or affected by this form.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  ADAPTIVE_REVIEW_DECISION_STATUSES,
  AdaptiveReviewDecisionStatus,
  MAX_REVIEW_COMMENT_LENGTH,
  validateConditionsForStatus,
} from "@/lib/governance/adaptiveHumanReviewRequest";
import { postAdaptivePanelAction, AdaptivePanelActionOutcome } from "@/lib/client/adaptivePanelSubmission";
import AdaptiveReviewConditionsEditor from "./AdaptiveReviewConditionsEditor";

const OVERRIDE_STATUS_OPTIONS: readonly AdaptiveReviewDecisionStatus[] = Array.from(ADAPTIVE_REVIEW_DECISION_STATUSES) as AdaptiveReviewDecisionStatus[];

const STATUS_LABEL: Record<AdaptiveReviewDecisionStatus, string> = {
  approved: "Approved",
  approved_with_conditions: "Approved with Conditions",
  changes_requested: "Changes Requested",
  rejected: "Rejected",
};

const MAX_JUSTIFICATION_LENGTH = MAX_REVIEW_COMMENT_LENGTH;

type OverrideResponse = { ok: true; override: { status: string; finalizedAt: string }; panelRevision: number };

export default function AdaptivePanelOverrideForm({
  runId,
  expectedPanelRevision,
  expectedGovernanceUpdatedAt,
  onSuccess,
  onRequestReload,
}: {
  runId: string;
  expectedPanelRevision: number;
  expectedGovernanceUpdatedAt: string;
  onSuccess: (override: { status: string; finalizedAt: string }) => void;
  onRequestReload: () => void;
}) {
  const { user, authReady, canMutate } = useAuth();
  const [status, setStatus] = useState<AdaptiveReviewDecisionStatus | "">("");
  const [justification, setJustification] = useState("");
  const [conditions, setConditions] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AdaptivePanelActionOutcome<OverrideResponse> | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement | null>(null);

  const trimmedJustification = justification.trim();
  const validation = (() => {
    if (status === "") return { ok: false as const, message: "Select an override status." };
    const conditionsResult = validateConditionsForStatus(status, conditions.filter((c) => c.trim().length > 0));
    if (!conditionsResult.ok) return { ok: false as const, message: messageForConditionsFailure(conditionsResult.reason) };
    if (!trimmedJustification) return { ok: false as const, message: "A justification is required to override this panel." };
    if (trimmedJustification.length > MAX_JUSTIFICATION_LENGTH) {
      return { ok: false as const, message: `Justification must be ${MAX_JUSTIFICATION_LENGTH} characters or fewer.` };
    }
    if (!confirmed) return { ok: false as const, message: "Confirm that you understand this bypasses the panel's own vote." };
    return { ok: true as const, value: { status, justification: trimmedJustification, conditions: conditionsResult.conditions } };
  })();

  useEffect(() => {
    if (touched && !validation.ok && errorSummaryRef.current) {
      errorSummaryRef.current.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touched, validation.ok]);

  // Auth Lifecycle Hardening, Step 6.3/6.9 — see AdaptivePanelVoteForm.tsx.
  const locked = submitting || !canMutate || result?.kind === "success" || result?.kind === "terminal" || result?.kind === "stale";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!validation.ok || submitting) return;

    const payload = {
      expectedPanelRevision,
      expectedGovernanceUpdatedAt,
      status: validation.value.status,
      justification: validation.value.justification,
      conditions: validation.value.conditions,
    };
    setSubmitting(true);
    setResult(null);
    try {
      const outcome = await postAdaptivePanelAction<OverrideResponse>(
        `/api/teams/adaptive-runs/${encodeURIComponent(runId)}/review-panel/override`,
        payload,
        async (url, body) => {
          const { authedFetch } = await import("@/lib/client/authedFetch");
          return authedFetch(url, { user, authReady, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
        }
      );
      setResult(outcome);
      if (outcome.kind === "success") {
        onSuccess(outcome.data.override);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const conditionsAllowed = status === "approved_with_conditions";

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Owner override"
      className="space-y-4 rounded-lg border border-amber-700/40 bg-amber-900/10 p-4"
    >
      <div>
        <h3 className="text-sm font-bold text-cp-text">Owner Override</h3>
        <p className="mt-1 text-xs text-cp-muted">
          This bypasses the panel&rsquo;s own vote and immediately finalizes the review with the status you choose below. Reviewer votes remain
          visible and unchanged — they are never edited or deleted.
        </p>
      </div>

      <fieldset className="space-y-1" disabled={locked}>
        <legend className="text-sm font-medium text-cp-text">Final status</legend>
        <label className="sr-only" htmlFor="adaptive-panel-override-status">
          Final status
        </label>
        <select
          id="adaptive-panel-override-status"
          value={status}
          disabled={locked}
          onChange={(e) => setStatus(e.target.value as AdaptiveReviewDecisionStatus)}
          className="w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent disabled:opacity-60"
        >
          <option value="">Select a status…</option>
          {OVERRIDE_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </fieldset>

      {conditionsAllowed ? (
        <AdaptiveReviewConditionsEditor conditions={conditions} disabled={locked} onChange={setConditions} />
      ) : null}

      <div>
        <label htmlFor="adaptive-panel-override-justification" className="block text-sm font-medium text-cp-text">
          Justification (required)
        </label>
        <textarea
          id="adaptive-panel-override-justification"
          rows={4}
          value={justification}
          disabled={locked}
          onChange={(e) => setJustification(e.target.value)}
          className="mt-1 w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent disabled:opacity-60"
          placeholder="Explain why you are overriding this panel…"
        />
        <p className="mt-1 text-xs text-cp-muted">
          {justification.length}/{MAX_JUSTIFICATION_LENGTH}
        </p>
      </div>

      <label className="flex cursor-pointer items-start gap-2 text-xs text-cp-text">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={locked}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
        />
        I understand this overrides the panel&rsquo;s aggregation and immediately finalizes this review.
      </label>

      {touched && !validation.ok ? (
        <div
          ref={errorSummaryRef}
          tabIndex={-1}
          role="alert"
          aria-live="assertive"
          className="rounded-lg border border-red-700/40 bg-red-900/20 p-3 text-sm font-medium text-red-400 focus:outline-none"
        >
          {validation.message}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={locked || (touched && !validation.ok)}
        aria-busy={submitting}
        className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50"
      >
        {submitting ? "Overriding…" : "Override and Finalize"}
      </button>

      {result ? (
        <div aria-live="polite">
          {result.kind === "success" ? (
            <p className="rounded-lg bg-emerald-900/20 px-3 py-2 text-xs font-medium text-emerald-400" role="status">
              This review has been finalized by owner override.
            </p>
          ) : result.kind === "stale" || result.kind === "terminal" ? (
            <div className="rounded-lg bg-cp-raised px-3 py-2 text-xs text-cp-muted" role="status">
              <p>{result.message}</p>
              <button type="button" onClick={onRequestReload} className="mt-2 font-semibold text-cp-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
                Reload
              </button>
            </div>
          ) : (
            <p className="rounded-lg border border-red-700/40 bg-red-900/20 px-3 py-2 text-xs font-medium text-red-400" role="alert">
              {result.message}
            </p>
          )}
        </div>
      ) : null}
    </form>
  );
}

function messageForConditionsFailure(reason: string): string {
  switch (reason) {
    case "conditions_required":
      return "At least one condition is required for Approved with Conditions.";
    case "conditions_not_allowed":
      return "Conditions are only allowed for Approved with Conditions.";
    case "too_many_conditions":
      return "Too many conditions.";
    case "condition_too_long":
      return "One or more conditions are too long.";
    default:
      return "Please check your input and try again.";
  }
}
