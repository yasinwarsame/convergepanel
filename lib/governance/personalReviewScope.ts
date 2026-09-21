/**
 * PHASE 1 — the authority boundary between a PERSONAL review assignment and
 * a legacy TEAM review panel.
 *
 * A Personal assignment (`runs/{runId}/humanReviewAssignment/current` with
 * `teamId: null`) is an independent, narrow capability: it authorizes one
 * authenticated uid to read and decide THEIR OWN assigned review of one run.
 * It is not a grant of legacy Team review authority, and it never was
 * intended to be — see `resolveAdaptiveRunAccess`, which knows only "owner"
 * and "personal reviewer" and has no concept of team membership at all.
 *
 * The two records are structurally independent. A legacy run (no
 * `workspaceId` field at all) passes Workspace integrity as `legacy` and can
 * carry BOTH a legacy Team `humanReviewPanel/current` and a Personal
 * assignment, because `submitAdaptiveHumanReviewPanel` never reads or writes
 * the assignment document. The Personal governance route previously asserted
 * the opposite in a comment — "a panel is team-only by construction (personal
 * runs never have one)" — and used document co-location as if it were
 * authorization, which handed an unrelated Personal reviewer the Team panel's
 * reviewer identities, per-reviewer vote states, quorum and aggregate counts.
 *
 * Deliberately NOT keyed on `MULTI_REVIEWER_GOVERNANCE_ENABLED`. That flag
 * gates panel CREATION rollout; it is not a read-authorization input, panels
 * created while it was on persist after it is off, and an authority boundary
 * that evaporates when a rollout flag flips is not a boundary. The same
 * principle the Workspace/legacy-Team read guard was built on.
 *
 * Pure predicates, no I/O — the callers already hold everything needed.
 */

import type { AdaptiveRunAccessRole } from "./adaptiveRunAccess";

/**
 * Whether this viewer may read the run's multi-reviewer panel and the votes
 * cast into it.
 *
 * A personal reviewer may not. There is no such thing as a "personal panel":
 * the personal propagation path only ever writes a single-reviewer
 * assignment, and a Workspace-created panel can only exist on a
 * Workspace-bound run, which never reaches these Personal routes (Workspace
 * integrity rejects any `workspaceId` that is not the owner's own
 * deterministic `personal-{uid}`). So on any run that gets this far, a panel
 * is by elimination a legacy Team artifact — outside this capability.
 *
 * The owner is unchanged: this correction narrows the personal REVIEWER's
 * reach, not the run owner's view of their own run.
 */
export function viewerMayReadReviewPanel(role: AdaptiveRunAccessRole): boolean {
  return role !== "personal_reviewer";
}

/**
 * Whether one raw `humanReviewHistory` document is inside the personal
 * review scope.
 *
 * An ALLOW-LIST on the canonical `teamId` discriminator, taken from the raw
 * stored document rather than the classified list item (which deliberately
 * drops `teamId`). Every personal decision is written with `teamId: null`
 * and every legacy Team decision with a non-empty string, so `null` is the
 * precise, persisted signal — not an inference from status or timestamps.
 *
 * A row whose `teamId` key is ABSENT, or present with any other value, is
 * excluded rather than admitted: an unclassifiable row is exactly the case
 * that must not default open.
 */
export function historyRowIsInPersonalReviewScope(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (!Object.prototype.hasOwnProperty.call(raw, "teamId")) return false;
  return (raw as { teamId?: unknown }).teamId === null;
}
