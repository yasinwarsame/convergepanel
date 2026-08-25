"use client";

/**
 * Approval Workflow, Phase 9C.3 — the panel review section, composed
 * alongside (never inside) `WorkspaceRunReviewSection`'s single-review
 * controls. This section owns NO independent canonical state — it is
 * handed `panel`/`assignmentRevision-adjacent viewer.can*` fields and a
 * shared `onMutated` (== the parent's `refreshContext`) from the SAME
 * `review-context` fetch the single-review controls already use (§13/§14:
 * one canonical review-context, not two competing sources of truth).
 *
 * BACKEND-SUFFICIENCY AUDIT (Phase 9C.3 §4/§5, performed before writing
 * any of this UI — recorded here for the eventual reviewer, not just the
 * final report):
 *
 *   1. reviewer-candidates (§5) — `lib/workspaces/reviewerCandidates.ts`'s
 *      own module doc literally states it is "for assignment/panel
 *      selectors," and its eligibility check (`isValidAssignmentTarget`,
 *      `workspaceReviewEligibility.ts`) is independently documented as
 *      "a valid NEW assignment/panel target." `putWorkspaceReviewPanel`
 *      itself calls the SAME `isValidAssignmentTarget` for every proposed
 *      panel reviewer. This is a genuinely shared, generically panel-safe
 *      eligibility source — not an assumption, not a repurposing.
 *
 *   2. Vote/quorum read model (§4) — `reviewContext.ts`'s
 *      `voteSummary.submittedCount` is computed ONLY from votes fetched by
 *      deterministic, REVISION-NAMESPACED document IDs
 *      (`buildAdaptiveHumanReviewVoteId(panel.revision, reviewerUid)`) —
 *      a vote cast against an older panel revision has a different
 *      document ID and is structurally never included. This is an
 *      unambiguous current-revision-only read model, not a collection this
 *      UI would need to filter itself. Sufficient.
 *
 *   3. Quorum itself — `reviewContext.ts` does not expose a `quorum`
 *      field (only the dedicated `workspaceReviewPanelMutations.ts` panel
 *      DTO does). Rather than introduce a second, independently-refreshed
 *      panel fetch racing the canonical review-context (exactly the
 *      "two sources of truth" problem §13 warns against), this phase
 *      derives quorum client-side via `computeQuorum()`
 *      (`lib/workspaces/panelPresentation.ts`) — explicitly sanctioned for
 *      presentation by §23, tested for reviewer counts 2–9 (§24).
 *
 *   4. Final panel outcome — NOT re-derived here. `review.status` /
 *      `review.decidedVia` (already rendered by the single-review summary
 *      box in `WorkspaceRunReviewSection`) already reflect the finalized
 *      decision the moment `finalizeWorkspaceReviewPanel` writes
 *      `governanceRecord.humanReview` — no duplicate rendering needed.
 *
 * PANEL OCC: `panel === null` is unambiguous ("never created") — unlike
 * the Phase 9B.7 assignment fix, there is no "cleared but still exists"
 * panel state (cancel/finalize are terminal STATUS transitions on the
 * same document, never a delete — see `workspaceReviewClient.ts`'s
 * `currentPanelRevision()` doc comment). `expectedRevision`/
 * `expectedPanelRevision` are ALWAYS sourced from the live `panel` prop —
 * never a local counter, never incremented after a mutation (every
 * success/conflict triggers `onMutated()`, a canonical refetch).
 *
 * MUTATION EXCLUSION (Phase 9C.3-R1C, extended Phase 9C.4): this section is
 * the single owner of `activeMutation` — only ONE panel governance mutation
 * (create/reconfigure/vote/finalize/cancel/override) may be in flight at a
 * time for this run's panel UI, per the frozen 9C.3 UX concurrency
 * contract. This is a client-side coordination lock only; it never touches
 * `workspaceReviewPanelMutations.ts`, panel authorization, or OCC
 * semantics — the backend remains independently authoritative regardless
 * of what this lock permits. `beginMutation()`/`endMutation()` are passed
 * down to `PanelVoteForm`/`PanelFinalizeCancelControls`/
 * `OwnerOverrideForm`; `endMutation()` is always called on every exit path
 * (success, 409, generic error) so a failed request can never leave panel
 * controls permanently disabled.
 *
 * OWNER OVERRIDE (Phase 9C.4): `viewer.canOverride` is verified from
 * `reviewContext.ts` source to require `panelOpen` (same precondition as
 * vote/finalize/cancel) and is NEVER mutually exclusive with them by
 * construction — an Owner with `reviews.manage` can see Override alongside
 * Finalize/Cancel, or alongside Vote if also a panel reviewer — so Override
 * shares this SAME lock rather than a second one. Override is never
 * mode-gated here (drain vs. normal availability already falls out of
 * `panelOpen`/`reviewable` in `viewer.canOverride` itself, mirroring how
 * `canVote`/`canFinalize`/`canCancelPanel` are already drain-eligible
 * without local mode branching).
 */

import { useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  getReviewerCandidates,
  putPanel,
  buildPanelPutRequest,
  PANEL_CONFLICT_MESSAGE,
  GENERIC_MUTATION_ERROR_MESSAGE,
  type ReviewContextPanelInfo,
  type ReviewContextReviewInfo,
  type ReviewerCandidate,
  type WorkspaceReviewContext,
} from "@/lib/client/workspaceReviewClient";
import { getPanelStatusLabel, getQuorumProgressText, getReviewerCountLabel, computeQuorum, validatePanelReviewerSelection, type PanelMutationKind } from "@/lib/workspaces/panelPresentation";
import PanelReviewerSelector from "./PanelReviewerSelector";
import PanelVoteForm from "./PanelVoteForm";
import PanelFinalizeCancelControls from "./PanelFinalizeCancelControls";
import OwnerOverrideForm from "./OwnerOverrideForm";

type PanelViewerFlags = Pick<WorkspaceReviewContext["viewer"], "canCreatePanel" | "canReconfigurePanel" | "canCancelPanel" | "canVote" | "hasVoted" | "canFinalize" | "canOverride">;

export default function WorkspacePanelReviewSection({
  workspaceId,
  runId,
  panel,
  review,
  viewer,
  onMutated,
}: {
  workspaceId: string;
  runId: string;
  panel: ReviewContextPanelInfo | null;
  review: Pick<ReviewContextReviewInfo, "governanceUpdatedAt">;
  viewer: PanelViewerFlags;
  /** Phase 9C.3-R2C — MUST be genuinely awaitable; see `WorkspaceRunReviewSection.tsx`'s `refreshContext` doc comment. */
  onMutated: () => Promise<void>;
}) {
  const { user, authReady } = useAuth();

  const [editorOpen, setEditorOpen] = useState(false);
  const [candidates, setCandidates] = useState<ReviewerCandidate[] | null>(null);
  const [candidatesStatus, setCandidatesStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [selectedUids, setSelectedUids] = useState<string[]>([]);
  const [selectionInvalidated, setSelectionInvalidated] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Phase 9C.3-R2C — the single shared mutation lock for this panel's
  // create/reconfigure/vote/finalize/cancel controls. See module doc.
  //
  // AUTHORITATIVE ACQUISITION is the REF, never React state: two handlers
  // invoked back-to-back within the same JS tick (before React commits a
  // `setState`) would both observe a stale `activeMutation === null`
  // closure value if state were the guard — R2 empirically reproduced
  // exactly this with a same-tick vote+finalize probe. `activeMutationRef`
  // is a plain mutable ref, written and read synchronously with a normal
  // property access — its correctness does not depend on React's render/
  // commit scheduling at all. `activeMutation` (state) exists ONLY to
  // drive `disabled`/pending presentation; it is never consulted by
  // `beginMutation`.
  //
  // `endMutation` only clears the lock if it currently holds the SAME kind
  // it is asked to release — a defensive compare-and-clear so a stray/
  // reordered completion callback can never clear a different mutation's
  // lock.
  const activeMutationRef = useRef<PanelMutationKind | null>(null);
  const [activeMutation, setActiveMutation] = useState<PanelMutationKind | null>(null);
  function beginMutation(kind: PanelMutationKind): boolean {
    if (activeMutationRef.current !== null) return false;
    activeMutationRef.current = kind;
    setActiveMutation(kind);
    return true;
  }
  function endMutation(kind: PanelMutationKind) {
    if (activeMutationRef.current !== kind) return;
    activeMutationRef.current = null;
    setActiveMutation(null);
  }

  const isReconfigure = panel !== null;
  const ownEditorKind: PanelMutationKind = isReconfigure ? "reconfigure" : "create";
  const editorLocked = activeMutation !== null && activeMutation !== ownEditorKind;

  async function loadCandidates() {
    setCandidatesStatus("loading");
    const result = await getReviewerCandidates({ workspaceId, runId, user, authReady });
    if (result.status === "ok") {
      setCandidates(result.candidates);
      setCandidatesStatus("ready");
    } else {
      setCandidatesStatus("error");
    }
  }

  function openEditor() {
    setEditorOpen(true);
    setSelectionInvalidated(false);
    setSelectedUids(isReconfigure ? panel!.reviewers.map((r) => r.uid) : []);
    if (candidatesStatus === "idle") loadCandidates();
  }

  function toggleUid(uid: string) {
    setSelectedUids((prev) => (prev.includes(uid) ? prev.filter((u) => u !== uid) : [...prev, uid]));
  }

  async function handleSave() {
    const validation = validatePanelReviewerSelection(selectedUids);
    if (!validation.valid || pending || editorLocked) return;
    if (!beginMutation(ownEditorKind)) return;
    setPending(true);
    setNotice(null);
    setSelectionInvalidated(false);
    const body = buildPanelPutRequest({ panel }, selectedUids);
    const result = await putPanel({ workspaceId, runId, user, authReady, body });
    if (result.status === "ok") {
      setEditorOpen(false);
      // Phase 9C.3-R2C — hold the lock through canonical reconciliation:
      // release only after `onMutated()` has actually applied the refreshed
      // context, never merely after the HTTP response.
      await onMutated();
      setPending(false);
      endMutation(ownEditorKind);
      return;
    }
    if (result.status === "conflict") {
      setNotice(PANEL_CONFLICT_MESSAGE);
      // Phase 9C.3-R2C — await BOTH the canonical context refresh AND the
      // candidate revalidation before releasing; a stale-candidate
      // selection must be invalidated before the form becomes submittable
      // again (§17/§18 of the corrective spec).
      await onMutated();
      const refreshed = await getReviewerCandidates({ workspaceId, runId, user, authReady });
      if (refreshed.status === "ok") {
        setCandidates(refreshed.candidates);
        const stillEligible = new Set(refreshed.candidates.map((c) => c.uid));
        const survivors = selectedUids.filter((uid) => stillEligible.has(uid));
        if (survivors.length !== selectedUids.length) {
          setSelectedUids(survivors);
          setSelectionInvalidated(true);
        }
      }
      setPending(false);
      endMutation(ownEditorKind);
      return;
    }
    // Generic (non-conflict) failure — canonical state never changed
    // server-side, so no refresh is needed before releasing.
    setPending(false);
    endMutation(ownEditorKind);
    setNotice(GENERIC_MUTATION_ERROR_MESSAGE);
  }

  // No panel at all.
  if (panel === null) {
    if (!viewer.canCreatePanel) return null;
    return (
      <div className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-cp-text">Panel review</h3>
        {!editorOpen ? (
          <button
            type="button"
            onClick={openEditor}
            disabled={editorLocked}
            className="mt-3 rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
          >
            Start panel review
          </button>
        ) : (
          <PanelEditorForm
            candidates={candidates}
            candidatesStatus={candidatesStatus}
            onRetryCandidates={loadCandidates}
            selectedUids={selectedUids}
            onToggle={toggleUid}
            selectionInvalidated={selectionInvalidated}
            notice={notice}
            pending={pending}
            disabled={editorLocked}
            onSave={handleSave}
            onCancel={() => setEditorOpen(false)}
            saveLabel="Start panel review"
            legend="Reviewers"
            warning={null}
          />
        )}
      </div>
    );
  }

  const reviewerCount = panel.reviewers.length;
  const quorum = computeQuorum(reviewerCount);
  const submittedCount = panel.voteSummary?.submittedCount ?? 0;
  const progress = getQuorumProgressText(submittedCount, reviewerCount, quorum);
  const statusLabel = getPanelStatusLabel(panel.status);

  return (
    <>
    <div className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-cp-text">Panel review</h3>
        <span className="text-xs font-medium text-cp-muted">{statusLabel}</span>
      </div>

      <p className="mt-2 text-xs text-cp-muted">{getReviewerCountLabel(reviewerCount)}</p>
      <ul className="mt-1 list-inside list-disc text-sm text-cp-text">
        {panel.reviewers.map((r) => (
          <li key={r.uid}>{r.displayName}</li>
        ))}
      </ul>

      {panel.status === "open" && (
        <>
          <div className="mt-3 text-xs text-cp-muted">
            <p>{progress.primary}</p>
            <p>{progress.secondary}</p>
          </div>

          {viewer.canVote && !viewer.hasVoted && (
            <div className="mt-4">
              <PanelVoteForm
                workspaceId={workspaceId}
                runId={runId}
                panelRevision={panel.revision}
                onMutated={onMutated}
                disabled={activeMutation !== null && activeMutation !== "vote"}
                onBeginMutation={() => beginMutation("vote")}
                onEndMutation={() => endMutation("vote")}
              />
            </div>
          )}
          {viewer.canVote && viewer.hasVoted && <p className="mt-3 text-xs text-cp-muted">You already voted.</p>}

          {viewer.canReconfigurePanel && (
            <div className="mt-4 border-t border-cp-border-soft pt-4">
              {!editorOpen ? (
                <button
                  type="button"
                  onClick={openEditor}
                  disabled={editorLocked}
                  className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                >
                  Change reviewers
                </button>
              ) : (
                <PanelEditorForm
                  candidates={candidates}
                  candidatesStatus={candidatesStatus}
                  onRetryCandidates={loadCandidates}
                  selectedUids={selectedUids}
                  onToggle={toggleUid}
                  selectionInvalidated={selectionInvalidated}
                  notice={notice}
                  pending={pending}
                  disabled={editorLocked}
                  onSave={handleSave}
                  onCancel={() => setEditorOpen(false)}
                  saveLabel="Save reviewers"
                  legend="Reviewers"
                  warning="Changing the reviewer panel starts a new panel revision. Existing votes will not count toward the updated panel."
                />
              )}
            </div>
          )}

          {(viewer.canFinalize || viewer.canCancelPanel) && (
            <div className="mt-4">
              <PanelFinalizeCancelControls
                workspaceId={workspaceId}
                runId={runId}
                panelRevision={panel.revision}
                review={review}
                canFinalize={viewer.canFinalize}
                canCancelPanel={viewer.canCancelPanel}
                onMutated={onMutated}
                finalizeDisabled={activeMutation !== null && activeMutation !== "finalize"}
                cancelDisabled={activeMutation !== null && activeMutation !== "cancel"}
                onBeginMutation={beginMutation}
                onEndMutation={endMutation}
              />
            </div>
          )}
        </>
      )}
    </div>

    {/*
     * Phase 9C.4 — Owner Override renders as its OWN top-level card,
     * sibling to (never nested inside) the "Panel review" card above,
     * matching the established one-card-per-governance-concept convention
     * ("Assignment", "Panel review") and satisfying the required visual/
     * semantic separation from peer review. It participates in the SAME
     * shared lock as vote/finalize/cancel (see module doc comment).
     */}
    {panel.status === "open" && viewer.canOverride && (
      <OwnerOverrideForm
        workspaceId={workspaceId}
        runId={runId}
        panelRevision={panel.revision}
        review={review}
        onMutated={onMutated}
        disabled={activeMutation !== null && activeMutation !== "override"}
        onBeginMutation={() => beginMutation("override")}
        onEndMutation={() => endMutation("override")}
      />
    )}
    </>
  );
}

function PanelEditorForm({
  candidates,
  candidatesStatus,
  onRetryCandidates,
  selectedUids,
  onToggle,
  selectionInvalidated,
  notice,
  pending,
  disabled,
  onSave,
  onCancel,
  saveLabel,
  legend,
  warning,
}: {
  candidates: ReviewerCandidate[] | null;
  candidatesStatus: "idle" | "loading" | "ready" | "error";
  onRetryCandidates: () => void;
  selectedUids: string[];
  onToggle: (uid: string) => void;
  selectionInvalidated: boolean;
  notice: string | null;
  pending: boolean;
  /** Phase 9C.3-R1C — true when a DIFFERENT panel mutation currently holds the shared lock. */
  disabled: boolean;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
  legend: string;
  warning: string | null;
}) {
  const validation = validatePanelReviewerSelection(selectedUids);
  return (
    <div className="mt-3 space-y-3">
      {warning && <p className="text-xs text-cp-orange">{warning}</p>}
      {notice && (
        <p role="status" aria-live="polite" className="rounded-lg border border-cp-orange bg-cp-orange-soft px-3 py-2 text-xs text-cp-text">
          {notice}
        </p>
      )}
      <PanelReviewerSelector
        legend={legend}
        candidates={candidates}
        candidatesStatus={candidatesStatus}
        onRetryCandidates={onRetryCandidates}
        selectedUids={selectedUids}
        onToggle={onToggle}
        selectionInvalidated={selectionInvalidated}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={!validation.valid || pending || disabled}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
        >
          {pending ? "Saving…" : saveLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  );
}
