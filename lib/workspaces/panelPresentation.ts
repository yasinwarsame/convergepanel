/**
 * Approval Workflow, Phase 9C.3 — pure presentation helpers for the
 * Workspace panel review UI. No React, no I/O, mirrors
 * `reviewQueuePresentation.ts`'s own isomorphic-pure-mapping precedent.
 *
 * QUORUM: the frozen formula (Phase 9B.5.2, `adaptiveHumanReviewPanel.ts`)
 * is `floor(reviewerCount / 2) + 1`. `workspaceReviewPanelMutations.ts`'s
 * dedicated panel DTO exposes a server-computed `quorum` field, but
 * `reviewContext.ts` (the single canonical read model this phase composes
 * against — see `WorkspacePanelReviewSection.tsx`'s own doc comment for
 * why a second panel-specific fetch is deliberately NOT introduced) does
 * not. Deriving it client-side is explicitly sanctioned for presentation
 * purposes (Phase 9C.3 §23) provided it exactly matches the frozen
 * formula — `computeQuorum()` below is that single, tested
 * implementation, never duplicated elsewhere.
 */

export const MIN_PANEL_REVIEWERS = 2;
export const MAX_PANEL_REVIEWERS = 9;

/**
 * Phase 9C.3-R1C — the single set of panel governance mutations that may
 * never overlap in flight for one run's panel UI (create/reconfigure share
 * one editor and are mutually exclusive by construction; vote/finalize/
 * cancel are independent controls that previously had no shared lock).
 * `WorkspacePanelReviewSection` owns the single `activeMutation` state this
 * type describes; this is UX concurrency control only — it never changes
 * `viewer.can*` authorization presentation, and the backend remains the
 * sole authority (each mutation still reauthorizes and OCC-checks inside
 * its own transaction regardless of what the client permits).
 *
 * Phase 9C.4 — `"override"` added. Verified from `reviewContext.ts` source
 * that `canOverride` requires `panelOpen` (same precondition as vote/
 * finalize/cancel) and, unlike assignment/decision/resubmit, is never
 * mutually exclusive with them by construction — an Owner with
 * `reviews.manage` can simultaneously see Override alongside Finalize/
 * Cancel, or alongside Vote if also a panel reviewer. Override therefore
 * participates in this SAME shared lock rather than a second one.
 */
export type PanelMutationKind = "create" | "reconfigure" | "vote" | "finalize" | "cancel" | "override";

/** The one authoritative quorum formula — floor(N/2)+1. Never reimplemented elsewhere. */
export function computeQuorum(reviewerCount: number): number {
  return Math.floor(reviewerCount / 2) + 1;
}

export type PanelStatus = "open" | "cancelled" | "finalized";

const PANEL_STATUS_LABELS: Record<PanelStatus, string> = {
  open: "In progress",
  cancelled: "Cancelled",
  finalized: "Finalized",
};

export function getPanelStatusLabel(status: PanelStatus): string {
  return PANEL_STATUS_LABELS[status];
}

/**
 * Text-and-number progress copy — never color-only (Phase 9C.3 §102).
 * `submittedCount` is the current-panel-revision vote count already
 * scoped server-side (`ReviewContextPanelVoteSummary`, computed from
 * revision-namespaced vote document IDs — see `reviewContext.ts`); this
 * function never re-derives or re-scopes it.
 */
export function getQuorumProgressText(submittedCount: number, reviewerCount: number, quorum: number): { primary: string; secondary: string } {
  return {
    primary: `${submittedCount} of ${reviewerCount} reviewer${reviewerCount === 1 ? "" : "s"} have voted`,
    secondary: `${quorum} vote${quorum === 1 ? "" : "s"} required for quorum`,
  };
}

export function getReviewerCountLabel(count: number): string {
  return `${count} reviewer${count === 1 ? "" : "s"}`;
}

export interface PanelReviewerSelectionValidation {
  valid: boolean;
  reason: "too_few" | "too_many" | "duplicate" | null;
}

/** Mirror-only client validation (2–9, no duplicates) — server (`validateWorkspacePanelReviewerUserIds`) remains authoritative; this never invents a stricter rule. */
export function validatePanelReviewerSelection(uids: readonly string[]): PanelReviewerSelectionValidation {
  const unique = new Set(uids);
  if (unique.size !== uids.length) return { valid: false, reason: "duplicate" };
  if (uids.length < MIN_PANEL_REVIEWERS) return { valid: false, reason: "too_few" };
  if (uids.length > MAX_PANEL_REVIEWERS) return { valid: false, reason: "too_many" };
  return { valid: true, reason: null };
}
