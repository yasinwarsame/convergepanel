"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — the adaptive review
 * decision form (docs/governance-decision-receipts-design.md §26). Submits
 * exactly one POST per click, never retries automatically, and always
 * sends the caller-supplied canonical `expectedUpdatedAt` — never a value
 * read from `teamRuns`.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  AdaptiveReviewFormState,
  EMPTY_ADAPTIVE_REVIEW_FORM_STATE,
  MAX_REVIEW_COMMENT_LENGTH,
  ADAPTIVE_REVIEW_DECISION_STATUS_OPTIONS,
  AdaptiveReviewDecisionStatus,
  validateAdaptiveReviewForm,
  fieldForValidationFailure,
  messageForValidationFailure,
  statusAllowsConditions,
  statusRequiresComment,
} from "@/lib/governance/adaptiveReviewFormContract";
import { submitAdaptiveReviewDecision, AdaptiveReviewSubmissionResult as SubmissionResult } from "@/lib/client/adaptiveReviewSubmission";
import AdaptiveReviewDecisionOption from "./AdaptiveReviewDecisionOption";
import AdaptiveReviewConditionsEditor from "./AdaptiveReviewConditionsEditor";
import AdaptiveReviewSubmissionResult from "./AdaptiveReviewSubmissionResult";

const STATUS_META: Record<AdaptiveReviewDecisionStatus, { label: string; description: string }> = {
  approved: { label: "Approve", description: "Accept this result as-is." },
  approved_with_conditions: { label: "Approve with Conditions", description: "Accept, with one or more caveats attached." },
  changes_requested: { label: "Request Changes", description: "Ask for revisions before this can be approved." },
  rejected: { label: "Reject", description: "This result should not be used." },
};

export default function AdaptiveReviewDecisionForm({
  runId,
  expectedUpdatedAt,
  onSuccess,
  onRequestReload,
}: {
  runId: string;
  expectedUpdatedAt: string;
  onSuccess: (result: Extract<SubmissionResult, { kind: "success" }>) => void;
  onRequestReload: () => void;
}) {
  const { user, authReady, canMutate } = useAuth();
  const [form, setForm] = useState<AdaptiveReviewFormState>(EMPTY_ADAPTIVE_REVIEW_FORM_STATE);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement | null>(null);

  const validation = validateAdaptiveReviewForm(form, expectedUpdatedAt);

  useEffect(() => {
    if (touched && !validation.ok && errorSummaryRef.current) {
      errorSummaryRef.current.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touched, validation.ok]);

  const showFieldError = (field: "status" | "comment" | "conditions" | "expectedUpdatedAt"): string | null => {
    if (!touched || validation.ok) return null;
    if (fieldForValidationFailure(validation.reason) !== field) return null;
    return messageForValidationFailure(validation.reason);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!validation.ok || submitting) return;

    // Freeze the exact payload before disabling controls and sending —
    // never recomputed after this point for this submission attempt.
    const payload = validation.value;
    setSubmitting(true);
    setResult(null);

    try {
      const outcome = await submitAdaptiveReviewDecision({
        runId,
        request: payload,
        postJson: async (url, body) => {
          const { authedFetch } = await import("@/lib/client/authedFetch");
          return authedFetch(url, {
            user,
            authReady,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            cache: "no-store",
          });
        },
      });
      setResult(outcome);
      if (outcome.kind === "success") {
        onSuccess(outcome);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const conditionsAllowed = statusAllowsConditions(form.status);
  const commentRequired = statusRequiresComment(form.status);

  // Once a terminal/stale/committed outcome is known, the form itself is
  // done — the parent (AdaptiveReviewDetail) is responsible for hiding it
  // entirely once canonical state confirms it. While `result` is a
  // non-success terminal/stale conflict, disable further edits until the
  // user explicitly reloads (handled by the parent via onRequestReload).
  // Auth Lifecycle Hardening, Step 6.3/6.9 — see AdaptivePanelVoteForm.tsx.
  const locked = submitting || !canMutate || result?.kind === "success" || result?.kind === "terminal" || result?.kind === "stale";

  return (
    <form onSubmit={handleSubmit} aria-label="Submit review decision" className="space-y-5">
      <h2 className="text-base font-bold text-cp-text">Submit a Decision</h2>

      <fieldset className="space-y-2" disabled={locked}>
        <legend className="text-sm font-medium text-cp-text">Decision</legend>
        <div className="space-y-2">
          {ADAPTIVE_REVIEW_DECISION_STATUS_OPTIONS.map((status) => (
            <AdaptiveReviewDecisionOption
              key={status}
              name="adaptive-review-decision-status"
              value={status}
              label={STATUS_META[status].label}
              description={STATUS_META[status].description}
              checked={form.status === status}
              disabled={locked}
              onChange={(value) => setForm((f) => ({ ...f, status: value as AdaptiveReviewDecisionStatus }))}
            />
          ))}
        </div>
        {showFieldError("status") ? (
          <p className="text-xs font-medium text-red-400" id="adaptive-review-status-error">
            {showFieldError("status")}
          </p>
        ) : null}
      </fieldset>

      {form.status !== "" ? (
        <div>
          <label htmlFor="adaptive-review-comment" className="block text-sm font-medium text-cp-text">
            Comment{commentRequired ? " (required)" : " (optional)"}
          </label>
          <textarea
            id="adaptive-review-comment"
            rows={4}
            value={form.comment}
            disabled={locked}
            onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))}
            aria-describedby="adaptive-review-comment-count adaptive-review-comment-error"
            className="mt-1 w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent disabled:opacity-60"
            placeholder="Explain this decision…"
          />
          <p id="adaptive-review-comment-count" className="mt-1 text-xs text-cp-muted">
            {form.comment.length}/{MAX_REVIEW_COMMENT_LENGTH}
          </p>
          {showFieldError("comment") ? (
            <p id="adaptive-review-comment-error" className="mt-1 text-xs font-medium text-red-400">
              {showFieldError("comment")}
            </p>
          ) : null}
        </div>
      ) : null}

      {conditionsAllowed ? (
        <div>
          <AdaptiveReviewConditionsEditor
            conditions={form.conditions}
            disabled={locked}
            onChange={(next) => setForm((f) => ({ ...f, conditions: next }))}
          />
          {showFieldError("conditions") ? (
            <p className="mt-1 text-xs font-medium text-red-400">{showFieldError("conditions")}</p>
          ) : null}
        </div>
      ) : null}

      {touched && !validation.ok ? (
        <div
          ref={errorSummaryRef}
          tabIndex={-1}
          role="alert"
          aria-live="assertive"
          className="rounded-lg border border-red-700/40 bg-red-900/20 p-3 text-sm font-medium text-red-400 focus:outline-none"
        >
          {messageForValidationFailure(validation.reason)}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={locked || (touched && !validation.ok)}
        aria-busy={submitting}
        className="rounded-lg bg-cp-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "Submit Decision"}
      </button>

      {result ? (
        <div aria-live="polite">
          <AdaptiveReviewSubmissionResult result={result} onReload={onRequestReload} />
        </div>
      ) : null}
    </form>
  );
}
