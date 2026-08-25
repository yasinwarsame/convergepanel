"use client";

/**
 * Approval Workflow, Phase 9C.3 — panel vote form. Rendered ONLY when
 * `viewer.canVote === true` (parent-checked; never inferred from
 * `reviews.submit`, list membership, or role — §43/§44).
 *
 * Votes are cast-once, not replaceable: `submitWorkspaceReviewPanelVote`
 * treats a semantically-identical resubmission as a no-op success
 * (`already_submitted`) and a DIFFERING resubmission as a `vote_conflict`
 * 409 (verified from `workspaceReviewPanelMutations.ts` source before
 * building this component — §49). So once `hasVoted` is true, the parent
 * simply stops rendering this form; there is no "replace your vote" UX to
 * build.
 *
 * Vote status values are the exact SAME enum as ordinary single-review
 * decisions (`AdaptiveReviewDecisionStatus`, verified from
 * `parseSubmitAdaptiveReviewVoteRequest`'s shared validator — §45), so the
 * same four labels are reused here (kept as a small local literal, not an
 * import from `ReviewDecisionForm.tsx`, to avoid touching that protected
 * 9C.2 file at all).
 *
 * OCC: `panelRevision` is sourced from the caller's already-non-null
 * current panel via `buildPanelVoteRequest` — never `assignmentRevision`,
 * never `governanceUpdatedAt`.
 *
 * MUTATION EXCLUSION (Phase 9C.3-R1C/R2C): `disabled` is true whenever a
 * DIFFERENT panel mutation (create/reconfigure/finalize/cancel) currently
 * holds `WorkspacePanelReviewSection`'s shared, ref-backed lock — the
 * submit button is disabled and `onBeginMutation()`/`onEndMutation()`
 * guard the request exactly like every other panel mutation. The lock is
 * held through the awaited `onMutated()` canonical refresh on both
 * success and conflict — never released merely because the HTTP request
 * settled (R2C).
 */

import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { submitPanelVote, buildPanelVoteRequest, PANEL_CONFLICT_MESSAGE, GENERIC_MUTATION_ERROR_MESSAGE, type AdaptiveReviewDecisionStatus } from "@/lib/client/workspaceReviewClient";

const VOTE_OPTIONS: { value: AdaptiveReviewDecisionStatus; label: string }[] = [
  { value: "approved", label: "Approve" },
  { value: "approved_with_conditions", label: "Approve with conditions" },
  { value: "changes_requested", label: "Request changes" },
  { value: "rejected", label: "Reject" },
];

export default function PanelVoteForm({
  workspaceId,
  runId,
  panelRevision,
  onMutated,
  disabled,
  onBeginMutation,
  onEndMutation,
}: {
  workspaceId: string;
  runId: string;
  panelRevision: number;
  /** Phase 9C.3-R2C — MUST be genuinely awaitable; see `WorkspaceRunReviewSection.tsx`'s `refreshContext` doc comment. */
  onMutated: () => Promise<void>;
  /** Phase 9C.3-R1C — true when a different panel mutation holds the shared lock. */
  disabled: boolean;
  /** Attempts to acquire the shared panel mutation lock; returns false if another mutation is already active. */
  onBeginMutation: () => boolean;
  onEndMutation: () => void;
}) {
  const { user, authReady } = useAuth();
  const [status, setStatus] = useState<AdaptiveReviewDecisionStatus | "">("");
  const [comment, setComment] = useState("");
  const [conditions, setConditions] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
    if (!status || pending || disabled) return;
    if (commentRequired && comment.trim().length === 0) return;
    if (conditionsRequired && conditionsList.length === 0) return;
    if (!onBeginMutation()) return;
    setPending(true);
    setNotice(null);
    const trimmedComment = comment.trim();
    const body = buildPanelVoteRequest(
      { revision: panelRevision },
      {
        status,
        ...(trimmedComment.length > 0 ? { comment: trimmedComment } : {}),
        ...(status === "approved_with_conditions" ? { conditions: conditionsList } : {}),
      }
    );
    const result = await submitPanelVote({ workspaceId, runId, user, authReady, body });
    if (result.status === "ok") {
      // Phase 9C.3-R2C — hold the lock (and the visible "Submitting…"
      // pending state) through the awaited canonical refresh, not merely
      // until the HTTP response.
      await onMutated();
      setStatus("");
      setComment("");
      setConditions("");
      setPending(false);
      onEndMutation();
      return;
    }
    if (result.status === "conflict") {
      setNotice(PANEL_CONFLICT_MESSAGE);
      await onMutated();
      setPending(false);
      onEndMutation();
      return;
    }
    // Generic (non-conflict) failure — canonical state never changed
    // server-side, so no refresh is needed before releasing.
    setPending(false);
    onEndMutation();
    setNotice(GENERIC_MUTATION_ERROR_MESSAGE);
  }

  return (
    <div className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <h4 className="text-sm font-semibold text-cp-text">Your vote</h4>

      {notice && (
        <p role="status" aria-live="polite" className="mt-3 rounded-lg border border-cp-orange bg-cp-orange-soft px-3 py-2 text-xs text-cp-text">
          {notice}
        </p>
      )}
      <form onSubmit={handleSubmit} className="mt-4 space-y-3">
        <fieldset>
          <legend className="text-xs font-medium text-cp-text">Vote</legend>
          <div className="mt-2 space-y-2">
            {VOTE_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm text-cp-text">
                <input type="radio" name="panel-vote-status" value={opt.value} checked={status === opt.value} onChange={() => handleStatusChange(opt.value)} className="h-4 w-4 border-cp-border text-cp-accent focus:ring-cp-accent" />
                {opt.label}
              </label>
            ))}
          </div>
        </fieldset>

        {status === "approved_with_conditions" && (
          <div>
            <label htmlFor="panel-vote-conditions" className="block text-xs font-medium text-cp-text">
              Conditions <span className="font-normal text-cp-muted">(one per line, required)</span>
            </label>
            <textarea
              id="panel-vote-conditions"
              value={conditions}
              onChange={(e) => setConditions(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent"
            />
          </div>
        )}

        <div>
          <label htmlFor="panel-vote-comment" className="block text-xs font-medium text-cp-text">
            Comment {commentRequired && <span className="font-normal text-cp-muted">(required)</span>}
          </label>
          <textarea
            id="panel-vote-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent"
          />
        </div>

        <button
          type="submit"
          disabled={!status || pending || disabled || (commentRequired && comment.trim().length === 0) || (conditionsRequired && conditionsList.length === 0)}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
        >
          {pending ? "Submitting…" : "Submit vote"}
        </button>
      </form>
    </div>
  );
}
