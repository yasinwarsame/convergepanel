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
import { buildPersonalReviewDecisionId } from "./adaptiveHumanReviewHistory";

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
 * ALLOW-LIST on the stored `teamId`, read from the raw document rather than
 * the classified list item (which deliberately drops `teamId`).
 *
 * IMPORTANT — `teamId: null` is NOT by itself proof of Personal origin. It
 * separates a row from the LEGACY TEAM writers (which always store a
 * non-empty string) and nothing more: three Workspace writers also store
 * `null` (`workspaceReviewMutations.ts` single review,
 * `workspaceReviewPanelMutations.ts` panel finalization and owner override).
 * An earlier version of this comment claimed otherwise, which was false.
 * Authority-grade provenance comes from the namespaced decision id — see
 * `classifyDecisionScopeFromPersonalDoc` — and this predicate is only the
 * secondary legacy-Team check applied to a row already located that way, or
 * the row filter for the review-history list.
 *
 * A row whose `teamId` key is ABSENT, or present with any other value, is
 * excluded: an unclassifiable row must not default open.
 */
export function historyRowIsInPersonalReviewScope(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (!Object.prototype.hasOwnProperty.call(raw, "teamId")) return false;
  return (raw as { teamId?: unknown }).teamId === null;
}

export type CanonicalDecisionScope = "personal" | "team" | "workspace" | "unknown";

/**
 * The exact `humanReviewHistory` document id a PERSONAL decision on this run
 * would have been written under, or `null` when the canonical record cannot
 * produce one.
 *
 * This is an exact, derivable relation, not a heuristic:
 * `app/api/user/runs/[runId]/decision/route.ts` derives ONE
 * `new Date().toISOString()` per request, passes it to the canonical writer
 * as `now` (so `humanReview.reviewedAt` IS that string) and to
 * `buildPersonalReviewDecisionId(runId, reviewedAt, newStatusForHistory)`,
 * where `newStatusForHistory` is `updatedRecord.humanReview.status`. The
 * document is then created at `runs/{runId}/humanReviewHistory/{decisionId}`.
 * That route has used this id form since the commit that introduced it, so
 * there is no legacy personal-decision id variant to be compatible with.
 *
 * The id is a CANDIDATE SELECTOR, not authentication. The namespaces are
 * `:`-joined string prefixes, so the id alone is not proof of origin: the
 * team builder produces byte-identical material whenever its `teamId` is
 * literally `"personal"` (and colon-bearing inputs can realign the segments
 * too). What denies an aliased document is the BODY validation below — the
 * Personal discriminator plus agreement with the canonical decision — not an
 * assumed impossibility. (The `workspace:` form cannot alias `personal:`,
 * since the literal prefixes differ; that one IS a property of the strings.)
 */
export function expectedPersonalDecisionId(args: {
  runId: string;
  reviewedAt: string | undefined;
  status: string | undefined;
}): string | null {
  if (typeof args.runId !== "string" || args.runId.trim().length === 0) return null;
  if (typeof args.reviewedAt !== "string" || args.reviewedAt.trim().length === 0) return null;
  if (typeof args.status !== "string" || args.status.trim().length === 0) return null;
  try {
    return buildPersonalReviewDecisionId(args.runId, args.reviewedAt, args.status);
  } catch {
    return null;
  }
}

/**
 * Classify the authority scope of the canonical `governanceRecord.humanReview`
 * decision from a POINT READ of the expected personal history document.
 *
 * `humanReview` itself carries no `teamId` and no scope field, so the decision
 * cannot be attributed from the record alone. This replaces an earlier
 * `(reviewerId, reviewedAt, newStatus)` scan of the whole history collection.
 * The tuple scan failed closed in every case tested, but it was weaker in two
 * ways that matter: it could not distinguish a Personal decision from a
 * WORKSPACE one (both store `teamId: null`), and duplicate tuples produced an
 * ambiguity class that the keyed lookup does not have — a document id is
 * unique by definition.
 *
 * - A panel `decidedVia` is Team-scoped by definition; no lookup is needed.
 * - Otherwise the expected personal document must EXIST, parse as a history
 *   row, carry the Personal discriminator (`teamId: null`), and AGREE with
 *   the canonical record on reviewer, timestamp and resulting status. The id
 *   only selects a candidate; the body is what establishes provenance, which
 *   is why an aliased id from another authority family is rejected here
 *   rather than earlier.
 *
 * Anything else — absent document, unreadable body, disagreement — is
 * `"unknown"`, which denies. `"unknown"` is never a fallback to `"personal"`.
 */
export function classifyDecisionScopeFromPersonalDoc(args: {
  decidedVia: string | undefined;
  reviewerId: string | undefined;
  reviewedAt: string | undefined;
  status: string;
  /** The point-read of `humanReviewHistory/{expectedPersonalDecisionId}`. */
  personalDoc: { exists: boolean; data: unknown } | null;
}): CanonicalDecisionScope {
  if (args.decidedVia === "multi_reviewer_panel" || args.decidedVia === "multi_reviewer_owner_override") {
    return "team";
  }
  if (typeof args.reviewerId !== "string" || args.reviewerId.length === 0) return "unknown";
  if (typeof args.reviewedAt !== "string" || args.reviewedAt.length === 0) return "unknown";
  if (!args.personalDoc || args.personalDoc.exists !== true) return "unknown";

  const raw = args.personalDoc.data;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "unknown";
  if (!historyRowIsInPersonalReviewScope(raw)) return "unknown";

  const row = raw as { reviewerId?: unknown; reviewedAt?: unknown; newStatus?: unknown };
  if (row.reviewerId !== args.reviewerId) return "unknown";
  if (row.reviewedAt !== args.reviewedAt) return "unknown";
  if (row.newStatus !== args.status) return "unknown";

  return "personal";
}

/**
 * Whether the canonical decision's reviewer identity may be resolved and
 * returned for this viewer.
 *
 * ALLOW-LIST:
 * - the owner, always;
 * - a personal reviewer, when the recorded decider IS them. The only value
 *   this releases is the caller's own uid resolved to their own display
 *   name, so it discloses nothing they do not already hold, and it keeps
 *   their own completed decision legible when provenance is unprovable.
 *   It authorizes IDENTITY ONLY — see `viewerMayReadDecisionContent`, which
 *   has no self case, for why that distinction is load-bearing: on a
 *   panel-finalized decision the recorded reviewer is the finalizing actor,
 *   not the author of the attached content;
 * - a personal reviewer, when the decision is proven `"personal"`.
 *
 * `"unknown"` denies. Every other role denies.
 */
/**
 * Whether the DECISION'S CONTENT — the reviewer-authored material attached to
 * it, currently `conditions` — may be read by this viewer.
 *
 * Deliberately SEPARATE from `viewerMayReadDecisionReviewerIdentity`, and
 * deliberately WITHOUT that function's self case. Identity equality and
 * content authority are different questions, and conflating them was a real
 * defect: on a panel-finalized decision `humanReview.reviewerId` is the actor
 * who pressed Finalize (`adaptivePanelFinalization.ts`) or the overriding
 * owner — NOT a voter — while `conditions` is the union of the OTHER
 * supporting panelists' `approved_with_conditions` vote text. "It is their
 * own decision" therefore does not make it their own content.
 *
 * ALLOW-LIST: the owner always; a personal reviewer only for a decision
 * proven `"personal"`. `"team"`, `"workspace"` and `"unknown"` all deny.
 */
export function viewerMayReadDecisionContent(args: { role: AdaptiveRunAccessRole; scope: CanonicalDecisionScope }): boolean {
  if (args.role === "owner") return true;
  if (args.role !== "personal_reviewer") return false;
  return args.scope === "personal";
}

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
