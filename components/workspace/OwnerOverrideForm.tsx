"use client";

/**
 * Approval Workflow, Phase 9C.4 — Owner Override. Rendered ONLY when
 * `viewer.canOverride === true` (parent-checked; never inferred from role,
 * capabilities, `ownerUserId`, or creator status — verified from
 * `reviewContext.ts` source: `canOverride = panelOpen && canOverrideCapability
 * && reviewable`, unrelated to `isCreator`).
 *
 * Deliberately, visually, and semantically distinct from peer review (panel
 * vote) and from ordinary single-review decision: this is NOT another vote,
 * NOT panel consensus, NOT a substitute for self-assignment. Backend
 * (`overrideWorkspaceReviewPanel`) deliberately does not check the
 * self-review guard — the whole point of this path is that an Owner may act
 * on their own artifact, but ONLY through this explicit, justified action.
 *
 * OCC: dual token, read from the actual override route/service before
 * writing this component (`app/api/workspaces/[workspaceId]/runs/[runId]/review-override/route.ts`
 * + `lib/governance/adaptivePanelOverride.ts`) — `expectedPanelRevision`
 * (`panel.revision`) AND `expectedGovernanceUpdatedAt`
 * (`review.governanceUpdatedAt`), the SAME dual-OCC shape as finalize, never
 * `assignmentRevision`.
 *
 * MUTATION EXCLUSION (Phase 9C.4): participates in
 * `WorkspacePanelReviewSection`'s SAME shared ref-backed lock as
 * vote/finalize/cancel — verified from `reviewContext.ts` that Override can
 * coexist on screen with those three (all require `panelOpen`; none of them
 * mutually exclude Override the way assignment/decision/resubmit do, which
 * all require `!panelOpen`). The lock is held through the awaited
 * `onMutated()` canonical refresh on both success and conflict, exactly
 * like every other 9C.3/9C.4 panel mutation.
 */

import { useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  overridePanel,
  buildOverrideRequest,
  OVERRIDE_CONFLICT_MESSAGE,
  GENERIC_MUTATION_ERROR_MESSAGE,
  type AdaptiveReviewDecisionStatus,
  type ReviewContextReviewInfo,
} from "@/lib/client/workspaceReviewClient";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";

const MAX_JUSTIFICATION_LENGTH = 4000;

const OVERRIDE_OUTCOME_OPTIONS: { value: AdaptiveReviewDecisionStatus; label: string }[] = [
  { value: "approved", label: "Approve" },
  { value: "approved_with_conditions", label: "Approve with conditions" },
  { value: "changes_requested", label: "Request changes" },
  { value: "rejected", label: "Reject" },
];

export default function OwnerOverrideForm({
  workspaceId,
  runId,
  panelRevision,
  review,
  onMutated,
  disabled,
  onBeginMutation,
  onEndMutation,
}: {
  workspaceId: string;
  runId: string;
  panelRevision: number;
  review: Pick<ReviewContextReviewInfo, "governanceUpdatedAt">;
  /** Phase 9C.4 — MUST be genuinely awaitable; see `WorkspaceRunReviewSection.tsx`'s `refreshContext` doc comment. */
  onMutated: () => Promise<void>;
  /** true when a DIFFERENT panel mutation currently holds the shared lock. */
  disabled: boolean;
  onBeginMutation: () => boolean;
  onEndMutation: () => void;
}) {
  const { user, authReady } = useAuth();
  const [status, setStatus] = useState<AdaptiveReviewDecisionStatus | "">("");
  const [conditions, setConditions] = useState("");
  const [justification, setJustification] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const conditionsRequired = status === "approved_with_conditions";
  const conditionsList = conditions
    .split("\n")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const trimmedJustification = justification.trim();
  const justificationValid = trimmedJustification.length > 0 && trimmedJustification.length <= MAX_JUSTIFICATION_LENGTH;
  const formValid = !!status && justificationValid && (!conditionsRequired || conditionsList.length > 0);

  function handleStatusChange(next: AdaptiveReviewDecisionStatus) {
    setStatus(next);
    if (next !== "approved_with_conditions") setConditions("");
  }

  function openConfirm() {
    if (!formValid || pending || disabled) return;
    setConfirmOpen(true);
  }

  async function handleConfirm() {
    if (!status || pending || disabled) return;
    if (!onBeginMutation()) return;
    setPending(true);
    setNotice(null);
    const body = buildOverrideRequest(
      { revision: panelRevision },
      review,
      {
        status,
        justification: trimmedJustification,
        ...(status === "approved_with_conditions" ? { conditions: conditionsList } : {}),
      }
    );
    const result = await overridePanel({ workspaceId, runId, user, authReady, body });
    if (result.status === "ok") {
      // Phase 9C.4 — hold the lock through the awaited canonical refresh,
      // not merely until the HTTP response. Clear the draft only on
      // confirmed success.
      await onMutated();
      setStatus("");
      setConditions("");
      setJustification("");
      setPending(false);
      setConfirmOpen(false);
      onEndMutation();
      return;
    }
    if (result.status === "conflict") {
      // Preserve the draft (outcome + justification) — the caller refetches
      // canonical state; if still eligible, the user may explicitly retry
      // with the refreshed OCC tokens. Never a blind/automatic retry.
      setNotice(OVERRIDE_CONFLICT_MESSAGE);
      await onMutated();
      setPending(false);
      setConfirmOpen(false);
      onEndMutation();
      return;
    }
    // Generic (non-conflict) failure — canonical state never changed
    // server-side, so no refresh is needed before releasing.
    setPending(false);
    setConfirmOpen(false);
    onEndMutation();
    setNotice(GENERIC_MUTATION_ERROR_MESSAGE);
  }

  return (
    <div className="rounded-xl border border-cp-orange bg-cp-orange-soft p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-cp-text">Owner override</h3>
      <p className="mt-1 text-xs text-cp-muted">Owner override records an exceptional governance decision outside the normal peer-review path. A written justification is required.</p>

      {notice && (
        <p role="status" aria-live="polite" className="mt-3 rounded-lg border border-cp-orange bg-cp-surface px-3 py-2 text-xs text-cp-text">
          {notice}
        </p>
      )}

      <div className="mt-4 space-y-3">
        <fieldset>
          <legend className="text-xs font-medium text-cp-text">Outcome</legend>
          <div className="mt-2 space-y-2">
            {OVERRIDE_OUTCOME_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm text-cp-text">
                <input type="radio" name="owner-override-status" value={opt.value} checked={status === opt.value} onChange={() => handleStatusChange(opt.value)} disabled={pending || disabled} className="h-4 w-4 border-cp-border text-cp-accent focus:ring-cp-accent" />
                {opt.label}
              </label>
            ))}
          </div>
        </fieldset>

        {status === "approved_with_conditions" && (
          <div>
            <label htmlFor="owner-override-conditions" className="block text-xs font-medium text-cp-text">
              Conditions <span className="font-normal text-cp-muted">(one per line, required)</span>
            </label>
            <textarea
              id="owner-override-conditions"
              value={conditions}
              onChange={(e) => setConditions(e.target.value)}
              disabled={pending || disabled}
              rows={3}
              className="mt-1 w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent"
            />
          </div>
        )}

        <div>
          <label htmlFor="owner-override-justification" className="block text-xs font-medium text-cp-text">
            Justification <span className="font-normal text-cp-muted">(required)</span>
          </label>
          <textarea
            id="owner-override-justification"
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            disabled={pending || disabled}
            maxLength={MAX_JUSTIFICATION_LENGTH}
            rows={4}
            aria-describedby="owner-override-justification-count"
            className="mt-1 w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent"
          />
          <p id="owner-override-justification-count" className="mt-1 text-xs text-cp-muted">
            {trimmedJustification.length}/{MAX_JUSTIFICATION_LENGTH}
          </p>
        </div>

        <button
          ref={triggerRef}
          type="button"
          onClick={openConfirm}
          disabled={!formValid || pending || disabled}
          className="rounded-lg border border-cp-orange bg-cp-surface px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-orange-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
        >
          Override review
        </button>
      </div>

      {confirmOpen && (
        <ProjectDialogFrame title="Confirm owner override?" triggerRef={triggerRef} onClose={() => setConfirmOpen(false)}>
          {() => (
            <div className="mt-4">
              <p className="text-sm text-cp-muted">This is an owner override, outside the normal peer-review path. Your justification will be recorded as part of this review&rsquo;s governance record.</p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmOpen(false)} disabled={pending} className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50">
                  Cancel
                </button>
                <button type="button" onClick={handleConfirm} disabled={pending || disabled} className="rounded-lg bg-cp-orange px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50">
                  {pending ? "Submitting…" : "Confirm override"}
                </button>
              </div>
            </div>
          )}
        </ProjectDialogFrame>
      )}
    </div>
  );
}
