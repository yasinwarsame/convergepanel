"use client";

/**
 * Approval Workflow, Phase 9C.3 — accessible reviewer multi-select shared
 * by panel creation and reconfiguration. Backend-authoritative candidate
 * list (`reviewer-candidates`, run-qualified, panel-safe per its own
 * module doc — see `WorkspacePanelReviewSection.tsx`'s backend-audit
 * comment); this component never recomputes eligibility (creator/Viewer/
 * removed/capability) itself (§30/§32).
 *
 * Client-side count/duplicate validation (2–9) is UX-only — the server
 * (`validateWorkspacePanelReviewerUserIds`) remains authoritative and may
 * reject for reasons this component cannot see (§31).
 */

import { computeQuorum, validatePanelReviewerSelection, MAX_PANEL_REVIEWERS } from "@/lib/workspaces/panelPresentation";
import { NO_ELIGIBLE_REVIEWERS_MESSAGE, GENERIC_CANDIDATES_ERROR_MESSAGE, type ReviewerCandidate } from "@/lib/client/workspaceReviewClient";

export default function PanelReviewerSelector({
  legend,
  candidates,
  candidatesStatus,
  onRetryCandidates,
  selectedUids,
  onToggle,
  selectionInvalidated,
}: {
  legend: string;
  candidates: ReviewerCandidate[] | null;
  candidatesStatus: "idle" | "loading" | "ready" | "error";
  onRetryCandidates: () => void;
  selectedUids: string[];
  onToggle: (uid: string) => void;
  selectionInvalidated: boolean;
}) {
  const validation = validatePanelReviewerSelection(selectedUids);

  if (candidatesStatus === "loading") {
    return (
      <p role="status" className="text-xs text-cp-muted">
        Loading eligible reviewers…
      </p>
    );
  }
  if (candidatesStatus === "error") {
    return (
      <div className="text-xs">
        <p className="text-cp-muted">{GENERIC_CANDIDATES_ERROR_MESSAGE}</p>
        <button type="button" onClick={onRetryCandidates} className="mt-1 font-medium text-cp-accent underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
          Retry
        </button>
      </div>
    );
  }
  if (candidatesStatus !== "ready" || !candidates) return null;
  if (candidates.length === 0) return <p className="text-xs text-cp-muted">{NO_ELIGIBLE_REVIEWERS_MESSAGE}</p>;

  return (
    <div className="space-y-2">
      <fieldset>
        <legend className="text-xs font-medium text-cp-text">{legend}</legend>
        {selectionInvalidated && <p className="mt-1 text-xs text-cp-orange">One or more previously selected reviewers are no longer eligible — review your selection.</p>}
        <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
          {candidates.map((c) => (
            <label key={c.uid} className="flex items-center gap-2 text-sm text-cp-text">
              <input
                type="checkbox"
                checked={selectedUids.includes(c.uid)}
                onChange={() => onToggle(c.uid)}
                disabled={!selectedUids.includes(c.uid) && selectedUids.length >= MAX_PANEL_REVIEWERS}
                className="h-4 w-4 rounded border-cp-border text-cp-accent focus:ring-cp-accent"
              />
              {c.displayName}
            </label>
          ))}
        </div>
      </fieldset>

      <p className="text-xs text-cp-muted">
        {selectedUids.length} selected{validation.valid && `, ${computeQuorum(selectedUids.length)} votes required`}
      </p>
      {!validation.valid && selectedUids.length > 0 && (
        <p className="text-xs text-cp-orange">{validation.reason === "too_few" ? "Select at least 2 reviewers." : validation.reason === "too_many" ? `Select at most ${MAX_PANEL_REVIEWERS} reviewers.` : "Duplicate reviewer selected."}</p>
      )}
    </div>
  );
}
