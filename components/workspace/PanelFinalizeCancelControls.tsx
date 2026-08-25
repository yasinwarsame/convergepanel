"use client";

/**
 * Approval Workflow, Phase 9C.3 — panel finalize + cancel manager
 * controls. Two visually and semantically distinct risk categories kept
 * in one file for scope discipline, but never merged into one button row
 * (§107/§109): finalize commits a governance outcome, cancel abandons the
 * panel review (never a review decision itself, never "Reject").
 *
 * OCC: finalize uses `panel.revision` AND `review.governanceUpdatedAt`
 * (the backend's own two-domain finalize contract); cancel uses only
 * `panel.revision`. Neither ever uses `assignmentRevision`.
 *
 * MUTATION EXCLUSION (Phase 9C.3-R1C): finalize and cancel are two
 * independent triggers in this one file but must never fire concurrently
 * with EACH OTHER or with a create/reconfigure/vote elsewhere in the
 * section — `finalizeDisabled`/`cancelDisabled` reflect whether the OTHER
 * action (or a sibling component's mutation) currently holds
 * `WorkspacePanelReviewSection`'s shared lock; `onBeginMutation("finalize"
 * | "cancel")`/`onEndMutation()` guard each request identically.
 */

import { useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  finalizePanel,
  deletePanel,
  buildPanelFinalizeRequest,
  buildPanelDeleteRequest,
  PANEL_CONFLICT_MESSAGE,
  GENERIC_MUTATION_ERROR_MESSAGE,
  type ReviewContextReviewInfo,
} from "@/lib/client/workspaceReviewClient";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";
import type { PanelMutationKind } from "@/lib/workspaces/panelPresentation";

export default function PanelFinalizeCancelControls({
  workspaceId,
  runId,
  panelRevision,
  review,
  canFinalize,
  canCancelPanel,
  onMutated,
  finalizeDisabled,
  cancelDisabled,
  onBeginMutation,
  onEndMutation,
}: {
  workspaceId: string;
  runId: string;
  panelRevision: number;
  review: Pick<ReviewContextReviewInfo, "governanceUpdatedAt">;
  canFinalize: boolean;
  canCancelPanel: boolean;
  onMutated: () => void;
  /** Phase 9C.3-R1C — true when a different panel mutation holds the shared lock. */
  finalizeDisabled: boolean;
  cancelDisabled: boolean;
  onBeginMutation: (kind: PanelMutationKind) => boolean;
  onEndMutation: () => void;
}) {
  const { user, authReady } = useAuth();

  const [finalizeConfirmOpen, setFinalizeConfirmOpen] = useState(false);
  const [finalizePending, setFinalizePending] = useState(false);
  const [finalizeNotice, setFinalizeNotice] = useState<string | null>(null);
  const finalizeTriggerRef = useRef<HTMLButtonElement>(null);

  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);

  async function handleFinalize() {
    if (finalizePending || finalizeDisabled) return;
    if (!onBeginMutation("finalize")) return;
    setFinalizePending(true);
    setFinalizeNotice(null);
    const body = buildPanelFinalizeRequest({ revision: panelRevision }, review);
    const result = await finalizePanel({ workspaceId, runId, user, authReady, body });
    setFinalizePending(false);
    setFinalizeConfirmOpen(false);
    onEndMutation();
    if (result.status === "ok") {
      onMutated();
      return;
    }
    if (result.status === "conflict") {
      setFinalizeNotice(PANEL_CONFLICT_MESSAGE);
      onMutated();
      return;
    }
    setFinalizeNotice(GENERIC_MUTATION_ERROR_MESSAGE);
  }

  async function handleCancel() {
    if (cancelPending || cancelDisabled) return;
    if (!onBeginMutation("cancel")) return;
    setCancelPending(true);
    setCancelNotice(null);
    const body = buildPanelDeleteRequest({ revision: panelRevision });
    const result = await deletePanel({ workspaceId, runId, user, authReady, body });
    setCancelPending(false);
    setCancelConfirmOpen(false);
    onEndMutation();
    if (result.status === "ok") {
      onMutated();
      return;
    }
    if (result.status === "conflict") {
      setCancelNotice(PANEL_CONFLICT_MESSAGE);
      onMutated();
      return;
    }
    setCancelNotice(GENERIC_MUTATION_ERROR_MESSAGE);
  }

  if (!canFinalize && !canCancelPanel) return null;

  return (
    <div className="flex flex-wrap items-start gap-4 border-t border-cp-border-soft pt-4">
      {canFinalize && (
        <div>
          {finalizeNotice && (
            <p role="status" aria-live="polite" className="mb-2 rounded-lg border border-cp-orange bg-cp-orange-soft px-3 py-2 text-xs text-cp-text">
              {finalizeNotice}
            </p>
          )}
          <button
            ref={finalizeTriggerRef}
            type="button"
            onClick={() => setFinalizeConfirmOpen(true)}
            disabled={finalizePending || finalizeDisabled}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
          >
            Finalize panel
          </button>
        </div>
      )}

      {canCancelPanel && (
        <div>
          {cancelNotice && (
            <p role="status" aria-live="polite" className="mb-2 rounded-lg border border-cp-orange bg-cp-orange-soft px-3 py-2 text-xs text-cp-text">
              {cancelNotice}
            </p>
          )}
          <button
            ref={cancelTriggerRef}
            type="button"
            onClick={() => setCancelConfirmOpen(true)}
            disabled={cancelPending || cancelDisabled}
            className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
          >
            Cancel panel review
          </button>
        </div>
      )}

      {finalizeConfirmOpen && (
        <ProjectDialogFrame title="Finalize panel review?" triggerRef={finalizeTriggerRef} onClose={() => setFinalizeConfirmOpen(false)}>
          {() => (
            <div className="mt-4">
              <p className="text-sm text-cp-muted">This closes the current panel review and applies the panel&rsquo;s decision. If the outcome requires changes, the item can still be resubmitted and reviewed normally afterward.</p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setFinalizeConfirmOpen(false)} className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
                  Cancel
                </button>
                <button type="button" onClick={handleFinalize} disabled={finalizePending || finalizeDisabled} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50">
                  {finalizePending ? "Finalizing…" : "Finalize"}
                </button>
              </div>
            </div>
          )}
        </ProjectDialogFrame>
      )}

      {cancelConfirmOpen && (
        <ProjectDialogFrame title="Cancel panel review?" triggerRef={cancelTriggerRef} onClose={() => setCancelConfirmOpen(false)}>
          {() => (
            <div className="mt-4">
              <p className="text-sm text-cp-muted">This cancels the panel review only — the research itself is unaffected, and the run can still be reviewed through the usual process afterward.</p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setCancelConfirmOpen(false)} className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
                  Keep panel
                </button>
                <button type="button" onClick={handleCancel} disabled={cancelPending || cancelDisabled} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50">
                  {cancelPending ? "Cancelling…" : "Cancel panel review"}
                </button>
              </div>
            </div>
          )}
        </ProjectDialogFrame>
      )}
    </div>
  );
}
