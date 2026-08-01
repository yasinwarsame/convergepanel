"use client";

/**
 * Multi-Reviewer Owner Override, Part F (§F13/§F14/§F18/§F19) — vote
 * submission form. Shown only by the parent when the current user is a
 * panel reviewer who has not yet voted and the canonical review is
 * reviewable (this component trusts its caller for that gate — it does
 * not re-derive eligibility). One POST per click, never auto-retried;
 * `panelRevision` is always the caller-supplied, most-recently-fetched
 * value — never a value this form invents. A submitted vote is immutable
 * — once `result.kind === "success"`, the form locks permanently (no
 * edit/withdraw control exists anywhere in this codebase).
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  ADAPTIVE_REVIEW_DECISION_STATUSES,
  AdaptiveReviewDecisionStatus,
  MAX_REVIEW_COMMENT_LENGTH,
  validateAdaptiveReviewCommentAndConditions,
} from "@/lib/governance/adaptiveHumanReviewRequest";
import { postAdaptivePanelAction, AdaptivePanelActionOutcome } from "@/lib/client/adaptivePanelSubmission";
import AdaptiveReviewDecisionOption from "./AdaptiveReviewDecisionOption";
import AdaptiveReviewConditionsEditor from "./AdaptiveReviewConditionsEditor";

const VOTE_STATUS_OPTIONS: readonly AdaptiveReviewDecisionStatus[] = Array.from(ADAPTIVE_REVIEW_DECISION_STATUSES) as AdaptiveReviewDecisionStatus[];

const STATUS_META: Record<AdaptiveReviewDecisionStatus, { label: string; description: string }> = {
  approved: { label: "Approve", description: "Accept this result as-is." },
  approved_with_conditions: { label: "Approve with Conditions", description: "Accept, with one or more caveats attached." },
  changes_requested: { label: "Request Changes", description: "Ask for revisions before this can be approved." },
  rejected: { label: "Reject", description: "This result should not be used." },
};

type VoteResponse = { ok: true; version: 1; submissionStatus: string; vote: { status: string; submittedAt: string } };

export default function AdaptivePanelVoteForm({
  runId,
  panelRevision,
  onSuccess,
  onRequestReload,
}: {
  runId: string;
  panelRevision: number;
  onSuccess: (vote: { status: string; submittedAt: string }) => void;
  onRequestReload: () => void;
}) {
  const { user, authReady, canMutate } = useAuth();
  const [status, setStatus] = useState<AdaptiveReviewDecisionStatus | "">("");
  const [comment, setComment] = useState("");
  const [conditions, setConditions] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AdaptivePanelActionOutcome<VoteResponse> | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement | null>(null);

  const validation =
    status === ""
      ? { ok: false as const, message: "Select a vote." }
      : (() => {
          const core = validateAdaptiveReviewCommentAndConditions(status, comment, conditions.filter((c) => c.trim().length > 0));
          if (!core.ok) return { ok: false as const, message: messageForCoreFailure(core.reason) };
          return { ok: true as const, value: core.value };
        })();

  useEffect(() => {
    if (touched && !validation.ok && errorSummaryRef.current) {
      errorSummaryRef.current.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touched, validation.ok]);

  // Auth Lifecycle Hardening, Step 6.3/6.9 — `canMutate` is only true once
  // AuthProvider has confirmed the Firebase client uid and the server
  // `__session` cookie uid match; disable submission outside that state
  // rather than relying solely on `authedFetch`'s own user/authReady check.
  const locked = submitting || !canMutate || result?.kind === "success" || result?.kind === "terminal" || result?.kind === "stale";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!validation.ok || submitting) return;

    const payload = { panelRevision, status, comment: validation.value.comment, conditions: validation.value.conditions };
    setSubmitting(true);
    setResult(null);
    try {
      const outcome = await postAdaptivePanelAction<VoteResponse>(
        `/api/teams/adaptive-runs/${encodeURIComponent(runId)}/votes`,
        payload,
        async (url, body) => {
          const { authedFetch } = await import("@/lib/client/authedFetch");
          return authedFetch(url, { user, authReady, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
        }
      );
      setResult(outcome);
      if (outcome.kind === "success") {
        onSuccess(outcome.data.vote);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const conditionsAllowed = status === "approved_with_conditions";
  const commentRequired = status === "changes_requested" || status === "rejected";

  return (
    <form onSubmit={handleSubmit} aria-label="Submit your vote" className="space-y-4">
      <h3 className="text-sm font-bold text-cp-text">Cast your vote</h3>

      <fieldset className="space-y-2" disabled={locked}>
        <legend className="text-sm font-medium text-cp-text">Vote</legend>
        <div className="space-y-2">
          {VOTE_STATUS_OPTIONS.map((s) => (
            <AdaptiveReviewDecisionOption
              key={s}
              name="adaptive-panel-vote-status"
              value={s}
              label={STATUS_META[s].label}
              description={STATUS_META[s].description}
              checked={status === s}
              disabled={locked}
              onChange={(value) => setStatus(value as AdaptiveReviewDecisionStatus)}
            />
          ))}
        </div>
      </fieldset>

      {status !== "" ? (
        <div>
          <label htmlFor="adaptive-panel-vote-comment" className="block text-sm font-medium text-cp-text">
            Comment{commentRequired ? " (required)" : " (optional)"}
          </label>
          <textarea
            id="adaptive-panel-vote-comment"
            rows={3}
            value={comment}
            disabled={locked}
            onChange={(e) => setComment(e.target.value)}
            className="mt-1 w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent disabled:opacity-60"
            placeholder="Only you can see this comment."
          />
          <p className="mt-1 text-xs text-cp-muted">
            {comment.length}/{MAX_REVIEW_COMMENT_LENGTH} — visible only to you.
          </p>
        </div>
      ) : null}

      {conditionsAllowed ? (
        <AdaptiveReviewConditionsEditor conditions={conditions} disabled={locked} onChange={setConditions} />
      ) : null}

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
        className="rounded-lg bg-cp-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "Submit Vote"}
      </button>

      {result ? (
        <div aria-live="polite">
          {result.kind === "success" ? (
            <p className="rounded-lg bg-emerald-900/20 px-3 py-2 text-xs font-medium text-emerald-400" role="status">
              Your vote was recorded and cannot be changed.
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

function messageForCoreFailure(reason: string): string {
  switch (reason) {
    case "comment_too_long":
      return `Comment must be ${MAX_REVIEW_COMMENT_LENGTH} characters or fewer.`;
    case "comment_required":
      return "A comment is required for this vote.";
    case "conditions_required":
      return "At least one condition is required for Approve with Conditions.";
    case "conditions_not_allowed":
      return "Conditions are only allowed for Approve with Conditions.";
    case "too_many_conditions":
      return "Too many conditions.";
    case "condition_too_long":
      return "One or more conditions are too long.";
    default:
      return "Please check your input and try again.";
  }
}
