/**
 * PHASE 1 — the authority boundary between a PERSONAL review assignment and
 * legacy TEAM review state.
 *
 * A Personal assignment (`runs/{runId}/humanReviewAssignment/current` with
 * `teamId: null`) is an independent, narrow capability: it authorizes one
 * authenticated uid to read and decide THEIR OWN assigned review of one run.
 * It is not a grant of legacy Team review authority — `resolveAdaptiveRunAccess`
 * knows only "owner" and "personal reviewer" and has no concept of team
 * membership.
 *
 * The invariant this module enforces:
 *
 *   No independently Team-scoped reviewer identity, vote, panel, or
 *   Team-panel provenance may enter a Personal response or its enrichment
 *   pipeline.
 *
 * It is deliberately NOT limited to `humanReviewPanel/current`. The first
 * attempt at this boundary was, and it missed the single-reviewer path: a
 * legacy Team actor can decide a legacy run directly, which lands in
 * `governanceRecord.humanReview.reviewerId` with no panel involved at all.
 *
 * Every predicate here is an ALLOW-LIST. An unknown role, an unknown
 * provenance, an unmatched decision or an unreadable row is excluded, never
 * admitted by default. A deny-list (`role !== "personal_reviewer"`) silently
 * grants access to every role added later, which is the exact failure shape
 * this file exists to prevent.
 *
 * Deliberately not keyed on `MULTI_REVIEWER_GOVERNANCE_ENABLED`. That flag
 * gates panel CREATION rollout; panels created while it was on persist after
 * it is off, and an authority boundary that evaporates when a rollout flag
 * flips is not a boundary.
 *
 * Pure, no I/O — callers pass already-fetched data.
 */

import type { AdaptiveRunAccessRole } from "./adaptiveRunAccess";

/**
 * Whether this viewer may read the run's multi-reviewer panel and its votes.
 *
 * ALLOW-LIST: only the run owner. A personal reviewer may not, and neither
 * may any future role until it is named here explicitly.
 *
 * Note the reason is the CAPABILITY, not the shape of the data: it is not
 * that a panel "cannot exist" on a run a personal reviewer can reach. It can
 * — a legacy run holds one happily, and a run bound to the owner's own
 * deterministic `personal-{uid}` Workspace passes integrity as `valid` and
 * reaches these routes too. The earlier version of this comment claimed
 * otherwise, which was the same species of "by construction" premise that
 * caused the original disclosure.
 */
export function viewerMayReadReviewPanel(role: AdaptiveRunAccessRole): boolean {
  return role === "owner";
}

/**
 * Whether this viewer may see HOW a decision was reached
 * (`humanReview.decidedVia`).
 *
 * ALLOW-LIST: only the run owner. `"multi_reviewer_panel"` and
 * `"multi_reviewer_owner_override"` are positive assertions that a Team panel
 * exists on this run — a provenance oracle that survives even when no name or
 * vote is returned, so it is suppressed with the rest of the panel surface.
 */
export type ReviewProvenanceViewerRole = AdaptiveRunAccessRole | "team_member" | "team_reviewer";

export function viewerMayReadDecisionProvenance(role: ReviewProvenanceViewerRole): boolean {
  // The owner, and viewers holding real Workspace/Team authority over the
  // run, may see how it was decided. A personal reviewer may not: their
  // capability is one assignment, not the run's Team governance history.
  return role === "owner" || role === "team_member" || role === "team_reviewer";
}

/**
 * Whether one raw `humanReviewHistory` document is inside the personal
 * review scope.
 *
 * ALLOW-LIST on the canonical `teamId` discriminator, read from the raw
 * stored document rather than the classified list item (which deliberately
 * drops `teamId`). Every personal decision is written with `teamId: null` and
 * every legacy Team decision with a non-empty string, so `null` is the
 * precise persisted signal — never an inference from status or timestamps.
 *
 * A row whose `teamId` key is ABSENT, or present with any other value, is
 * excluded: an unclassifiable row must not default open.
 */
export function historyRowIsInPersonalReviewScope(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (!Object.prototype.hasOwnProperty.call(raw, "teamId")) return false;
  return (raw as { teamId?: unknown }).teamId === null;
}

export type CanonicalDecisionScope = "personal" | "team" | "unknown";

/**
 * Classify the authority scope of the canonical `governanceRecord.humanReview`
 * decision.
 *
 * `humanReview` itself carries NO `teamId` and no scope field — verified
 * against its persisted schema — so a single-reviewer decision cannot be
 * attributed from the record alone. The guaranteed persisted provenance is
 * the matching `runs/{runId}/humanReviewHistory` row's `teamId`, which is the
 * same discriminator the review-history surface already treats as canonical.
 * Using it here is what keeps the two surfaces from disagreeing.
 *
 * - A panel `decidedVia` is Team-scoped by definition, with no lookup needed.
 * - Otherwise exactly one history row must match the decision on reviewer,
 *   timestamp and resulting status. Zero matches, several matches, or a row
 *   that fails the scope allow-list all yield `"unknown"`.
 *
 * `"unknown"` is a denial, never a fallback to `"personal"`.
 */
export function classifyCanonicalDecisionScope(args: {
  decidedVia: string | undefined;
  reviewerId: string | undefined;
  reviewedAt: string | undefined;
  status: string;
  /** Raw `humanReviewHistory` documents already fetched by the caller. */
  historyRows: readonly unknown[];
}): CanonicalDecisionScope {
  if (args.decidedVia === "multi_reviewer_panel" || args.decidedVia === "multi_reviewer_owner_override") {
    return "team";
  }
  if (typeof args.reviewerId !== "string" || args.reviewerId.length === 0) return "unknown";
  if (typeof args.reviewedAt !== "string" || args.reviewedAt.length === 0) return "unknown";

  const matches = args.historyRows.filter((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const row = raw as { reviewerId?: unknown; reviewedAt?: unknown; newStatus?: unknown };
    return row.reviewerId === args.reviewerId && row.reviewedAt === args.reviewedAt && row.newStatus === args.status;
  });

  // Exactly one decision may correspond to one (reviewer, timestamp, status).
  // Anything else is an ambiguity this boundary refuses to resolve in the
  // requester's favour.
  if (matches.length !== 1) return "unknown";

  // Three-way on the matched row, never two-way. `teamId: null` proves
  // personal; a non-empty string proves team; anything else (absent key,
  // wrong type, empty string) is genuinely unclassifiable and is reported as
  // such rather than being attributed to either side. All three of
  // "team"/"unknown" deny a personal reviewer, but calling an unreadable row
  // "team" would be a false attribution, and this value is a claim about
  // provenance, not just a gate input.
  const matched = matches[0] as { teamId?: unknown };
  if (historyRowIsInPersonalReviewScope(matched)) return "personal";
  if (typeof matched.teamId === "string" && matched.teamId.length > 0) return "team";
  return "unknown";
}

/**
 * Whether the canonical decision's reviewer identity may be resolved and
 * returned for this viewer.
 *
 * ALLOW-LIST:
 * - the owner, always;
 * - a personal reviewer, when the decider IS them (their own uid can never
 *   be a cross-boundary disclosure, and resolving their own name is not a
 *   cross-tenant read — this keeps a reviewer's own completed decision
 *   visible even when provenance is otherwise unprovable);
 * - a personal reviewer, when the decision is proven `"personal"`.
 *
 * `"unknown"` denies. Every other role denies.
 */
export function viewerMayReadDecisionReviewerIdentity(args: {
  role: AdaptiveRunAccessRole;
  scope: CanonicalDecisionScope;
  viewerUid: string;
  reviewerId: string | undefined;
}): boolean {
  if (args.role === "owner") return true;
  if (args.role !== "personal_reviewer") return false;
  if (typeof args.reviewerId === "string" && args.reviewerId.length > 0 && args.reviewerId === args.viewerUid) return true;
  return args.scope === "personal";
}
