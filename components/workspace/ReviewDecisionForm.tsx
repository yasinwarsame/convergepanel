"use client";

/**
 * Approval Workflow, Phase 9C.2 — ordinary (single-reviewer, non-panel)
 * decision form. Rendered ONLY when `viewer.canSubmitDecision === true`
 * (checked by the parent) — this component never infers eligibility from
 * `reviews.submit`, role, or creator status itself (Phase 9C.2 §36/§37).
 *
 * OCC: every submission sources `expectedUpdatedAt` from
 * `review.governanceUpdatedAt` via `buildDecisionRequest` — never
 * `assignmentRevision`. See `lib/client/workspaceReviewClient.ts`.
 */

import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { submitDecision, buildDecisionRequest, CONFLICT_MESSAGE, GENERIC_MUTATION_ERROR_MESSAGE, type AdaptiveReviewDecisionStatus, type ReviewContextReviewInfo } from "@/lib/client/workspaceReviewClient";

const DECISION_OPTIONS: { value: AdaptiveReviewDecisionStatus; label: string }[] = [
  { value: "approved", label: "Approve" },
  { value: "approved_with_conditions", label: "Approve with conditions" },
  { value: "changes_requested", label: "Request changes" },
  { value: "rejected", label: "Reject" },
];

export default function ReviewDecisionForm({
  workspaceId,
  runId,
  review,
  canSubmitDecision,
  onMutated,
}: {
  workspaceId: string;
  runId: string;
  review: ReviewContextReviewInfo;
  canSubmitDecision: boolean;
  onMutated: () => void;
}) {
  const { user, authReady } = useAuth();
  const [status, setStatus] = useState<AdaptiveReviewDecisionStatus | "">("");
  const [comment, setComment] = useState("");
  const [conditions, setConditions] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // §44: if canSubmitDecision flips false after a conflict refetch, the
  // parent stops rendering this component — the draft is not preserved
  // across that specific transition (a genuinely rare edge: the review
  // became ineligible for THIS caller between the 409 and the refetch).
  // No blind retry either way; this is a simplification of the "may
  // remain recoverable" soft language, not a violation of it.
  if (!canSubmitDecision) return null;

  const commentRequired = status === "changes_requested" || status === "rejected";
  const conditionsRequired = status === "approved_with_conditions";
  const conditionsList = conditions
    .split("\n")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  function handleStatusChange(next: AdaptiveReviewDecisionStatus) {
    setStatus(next);
    if (next !== "approved_with_conditions") setConditions("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!status || pending) return;
    if (commentRequired && comment.trim().length === 0) return;
    if (conditionsRequired && conditionsList.length === 0) return;
    setPending(true);
    setNotice(null);
    const trimmedComment = comment.trim();
    const body = buildDecisionRequest(
      { review },
      {
        status,
        ...(trimmedComment.length > 0 ? { comment: trimmedComment } : {}),
        ...(status === "approved_with_conditions" ? { conditions: conditionsList } : {}),
      }
    );
    const result = await submitDecision({ workspaceId, runId, user, authReady, body });
    setPending(false);
    if (result.status === "ok") {
      setStatus("");
      setComment("");
      setConditions("");
      onMutated();
      return;
    }
    if (result.status === "conflict") {
      setNotice(CONFLICT_MESSAGE);
      onMutated();
      return;
    }
    setNotice(GENERIC_MUTATION_ERROR_MESSAGE);
  }

  return (
    <div className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-cp-text">Your review</h3>

      {notice && (
        <p role="status" aria-live="polite" className="mt-3 rounded-lg border border-cp-orange bg-cp-orange-soft px-3 py-2 text-xs text-cp-text">
          {notice}
        </p>
      )}
      <form onSubmit={handleSubmit} className="mt-4 space-y-3">
        <fieldset>
          <legend className="text-xs font-medium text-cp-text">Decision</legend>
          <div className="mt-2 space-y-2">
            {DECISION_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm text-cp-text">
                <input type="radio" name="review-decision-status" value={opt.value} checked={status === opt.value} onChange={() => handleStatusChange(opt.value)} className="h-4 w-4 border-cp-border text-cp-accent focus:ring-cp-accent" />
                {opt.label}
              </label>
            ))}
          </div>
        </fieldset>

        {status === "approved_with_conditions" && (
          <div>
            <label htmlFor="review-decision-conditions" className="block text-xs font-medium text-cp-text">
              Conditions <span className="font-normal text-cp-muted">(one per line, required)</span>
            </label>
            <textarea
              id="review-decision-conditions"
              value={conditions}
              onChange={(e) => setConditions(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent"
            />
          </div>
        )}

        <div>
          <label htmlFor="review-decision-comment" className="block text-xs font-medium text-cp-text">
            Comment {commentRequired && <span className="font-normal text-cp-muted">(required)</span>}
          </label>
          <textarea
            id="review-decision-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent"
          />
        </div>

        <button
          type="submit"
          disabled={!status || pending || (commentRequired && comment.trim().length === 0) || (conditionsRequired && conditionsList.length === 0)}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
        >
          {pending ? "Submitting…" : "Submit decision"}
        </button>
      </form>
    </div>
  );
}
