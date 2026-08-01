/**
 * Pure Multi-Reviewer Aggregation Engine and Quorum Truth Tables, Part D
 * (docs/governance-decision-receipts-design.md §29-§32). A pure,
 * deterministic, versioned function that consumes a panel configuration
 * and its current-revision votes and reports quorum/majority status. No
 * I/O, no Firestore, no route wiring, no canonical `governanceRecord`
 * write, no panel finalization — this module only ever COMPUTES a result;
 * it never persists anything, and nothing in this codebase calls it from
 * a route yet.
 *
 * Deliberately imports ONLY pure domain types/validators — no Firebase
 * Admin, no route modules, no React, no fetch, no team auth, no logging,
 * no environment variables. `parseAdaptiveHumanReviewPanel` and
 * `parseAdaptiveHumanReviewVote` (both already pure, zero-I/O modules,
 * confirmed in Parts B/C) are reused here as the input-validity layer,
 * exactly as they already are by the Firestore-layer transactions —
 * reused, not reimplemented a third time — with a handful of additional,
 * genuinely aggregation-specific checks (panel `status === "open"`,
 * `quorum` formula, cross-referencing each vote against the PANEL rather
 * than an external "expected" context, duplicate-reviewer detection
 * across the vote SET) layered on top, since those are not — and should
 * not be — a single stored document's own self-consistency concern.
 */

import {
  AdaptiveHumanReviewPanelV1,
  deriveAdaptivePanelQuorum,
  parseAdaptiveHumanReviewPanel,
} from "./adaptiveHumanReviewPanel";
import { AdaptiveHumanReviewVoteV1, parseAdaptiveHumanReviewVote } from "./adaptiveHumanReviewVote";
import { AdaptiveReviewDecisionStatus } from "./adaptiveHumanReviewRequest";

// ============================================
// Policy contract (§D2)
// ============================================

export const ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION = 1;

export type AdaptiveReviewAggregationPolicyV1 = {
  version: 1;
  mode: "majority_quorum";
  approvalGroupStatuses: readonly ["approved", "approved_with_conditions"];
  blockingGroupStatuses: readonly ["changes_requested", "rejected"];
};

/**
 * The one fixed, exported policy constant for v1 — not user-configurable,
 * not accepted as a function parameter (§D2: "prefer constants over
 * user-configurable policy objects"). Genuinely load-bearing, not
 * decorative: group classification below reads FROM these two arrays
 * rather than duplicating the status literals inline, so a hypothetical
 * future policy version would only need to change this constant's shape,
 * not the classification logic itself.
 */
export const ADAPTIVE_REVIEW_AGGREGATION_POLICY_V1: AdaptiveReviewAggregationPolicyV1 = {
  version: 1,
  mode: "majority_quorum",
  approvalGroupStatuses: ["approved", "approved_with_conditions"],
  blockingGroupStatuses: ["changes_requested", "rejected"],
};

// ============================================
// Input contract (§D3)
// ============================================

export type AggregateAdaptiveReviewVotesInput = {
  panel: AdaptiveHumanReviewPanelV1;
  votes: readonly AdaptiveHumanReviewVoteV1[];
};

// ============================================
// Result contract (§D4)
// ============================================

export type AdaptiveReviewAggregationInvalidReason =
  | "invalid_panel"
  | "unsupported_panel_version"
  | "invalid_panel_status"
  | "invalid_panel_mode"
  | "invalid_quorum"
  | "invalid_vote"
  | "unsupported_vote_version"
  | "vote_team_mismatch"
  | "vote_run_mismatch"
  | "vote_revision_mismatch"
  | "reviewer_not_in_panel"
  | "duplicate_reviewer_vote";

export type AggregateAdaptiveReviewVotesResult =
  | {
      status: "waiting";
      policyVersion: 1;
      reason: "quorum_not_met";
      reviewerCount: number;
      quorum: number;
      submittedCount: number;
      remainingToQuorum: number;
      approvalGroupCount: number;
      blockingGroupCount: number;
    }
  | {
      // §D10: under policy v1's conservative exact-status rules, an
      // exact-status tie within an already-won group can never occur
      // (any approved_with_conditions vote escalates the approval
      // result; any rejected vote escalates the blocking result — see
      // §D7) — so `"winning_group_status_tie"` is deliberately NOT part
      // of this union. There is exactly one deadlock reason in v1.
      status: "deadlocked";
      policyVersion: 1;
      reason: "no_strict_group_majority";
      reviewerCount: number;
      quorum: number;
      submittedCount: number;
      approvalGroupCount: number;
      blockingGroupCount: number;
    }
  | {
      status: "ready";
      policyVersion: 1;
      finalStatus: AdaptiveReviewDecisionStatus;
      reviewerCount: number;
      quorum: number;
      submittedCount: number;
      approvalGroupCount: number;
      blockingGroupCount: number;
      supportingReviewerUserIds: string[];
      conditionsSummary: {
        contributingVoteCount: number;
        uniqueConditionCount: number;
        hasConditions: boolean;
      };
    }
  | {
      status: "invalid";
      policyVersion: 1;
      reason: AdaptiveReviewAggregationInvalidReason;
    };

function invalidResult(reason: AdaptiveReviewAggregationInvalidReason): AggregateAdaptiveReviewVotesResult {
  return { status: "invalid", policyVersion: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION, reason };
}

/**
 * Pure, synchronous, zero I/O. Never mutates `input`, `input.panel`,
 * `input.panel.reviewerUserIds`, `input.votes`, any vote object, or any
 * comment/conditions value. The result is identical regardless of the
 * order of `input.votes` — votes are processed in an internally
 * re-derived deterministic order (sorted by `reviewerUserId`), never the
 * caller-supplied array order, specifically so even the INVALID branch's
 * chosen `reason` (when multiple issues exist simultaneously) never
 * depends on input ordering.
 */
export function aggregateAdaptiveReviewVotes(input: AggregateAdaptiveReviewVotesInput): AggregateAdaptiveReviewVotesResult {
  const { panel, votes } = input;

  // ---- Panel validity (§D3, §D12) ----
  // Order: the two checks the shared parser CANNOT express on its own
  // (mode as a distinct reason, "open" as an aggregation-specific
  // requirement — the parser itself accepts "cancelled" as structurally
  // valid) are checked first and independently; the quorum-formula check
  // is also independent so it can be reported as its own distinct reason
  // rather than folded into the parser's single generic "malformed"
  // bucket; the full parser is reused last for everything else
  // (schemaVersion, kind, teamId/runId non-empty, reviewer count bounds,
  // duplicate reviewers, requiredReviewerCount match, revision, timestamps,
  // actor IDs).
  if (panel.mode !== "majority_quorum") {
    return invalidResult("invalid_panel_mode");
  }
  if (panel.status !== "open") {
    return invalidResult("invalid_panel_status");
  }
  if (panel.quorum !== deriveAdaptivePanelQuorum(panel.requiredReviewerCount)) {
    return invalidResult("invalid_quorum");
  }
  const panelParse = parseAdaptiveHumanReviewPanel(panel);
  if (panelParse.status === "unsupported_version") {
    return invalidResult("unsupported_panel_version");
  }
  if (panelParse.status !== "valid") {
    return invalidResult("invalid_panel");
  }

  // ---- Vote validity (§D3) — deterministic order, never the caller's array order ----
  const sortedVotes = [...votes].sort((a, b) => a.reviewerUserId.localeCompare(b.reviewerUserId));
  for (let i = 0; i < sortedVotes.length; i++) {
    const vote = sortedVotes[i];
    if (i > 0 && vote.reviewerUserId === sortedVotes[i - 1].reviewerUserId) {
      return invalidResult("duplicate_reviewer_vote");
    }
    const voteParse = parseAdaptiveHumanReviewVote(vote);
    if (voteParse.status === "unsupported_version") {
      return invalidResult("unsupported_vote_version");
    }
    if (voteParse.status !== "valid") {
      return invalidResult("invalid_vote");
    }
    if (vote.teamId !== panel.teamId) {
      return invalidResult("vote_team_mismatch");
    }
    if (vote.runId !== panel.runId) {
      return invalidResult("vote_run_mismatch");
    }
    if (vote.panelRevision !== panel.revision) {
      return invalidResult("vote_revision_mismatch");
    }
    if (!panel.reviewerUserIds.includes(vote.reviewerUserId)) {
      return invalidResult("reviewer_not_in_panel");
    }
  }

  // ---- Quorum (§D5, §D13) ----
  const reviewerCount = panel.requiredReviewerCount;
  const quorum = panel.quorum;
  const submittedCount = sortedVotes.length;

  const approvalVotes = sortedVotes.filter((v) => (ADAPTIVE_REVIEW_AGGREGATION_POLICY_V1.approvalGroupStatuses as readonly string[]).includes(v.status));
  const blockingVotes = sortedVotes.filter((v) => (ADAPTIVE_REVIEW_AGGREGATION_POLICY_V1.blockingGroupStatuses as readonly string[]).includes(v.status));
  const approvalGroupCount = approvalVotes.length;
  const blockingGroupCount = blockingVotes.length;

  if (submittedCount < quorum) {
    return {
      status: "waiting",
      policyVersion: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION,
      reason: "quorum_not_met",
      reviewerCount,
      quorum,
      submittedCount,
      remainingToQuorum: quorum - submittedCount,
      approvalGroupCount,
      blockingGroupCount,
    };
  }

  // ---- Group majority (§D6) — strict majority of SUBMITTED votes only,
  // never of total assigned reviewers or the quorum value. ----
  const approvalWins = approvalGroupCount > submittedCount / 2;
  const blockingWins = blockingGroupCount > submittedCount / 2;

  if (!approvalWins && !blockingWins) {
    return {
      status: "deadlocked",
      policyVersion: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION,
      reason: "no_strict_group_majority",
      reviewerCount,
      quorum,
      submittedCount,
      approvalGroupCount,
      blockingGroupCount,
    };
  }

  // ---- Exact status resolution within the winning group (§D7) ----
  // Minority-group votes never override the winning group's outcome —
  // only the winning group's OWN votes are ever consulted below.
  if (approvalWins) {
    const anyConditions = approvalVotes.some((v) => v.status === "approved_with_conditions");
    const finalStatus: AdaptiveReviewDecisionStatus = anyConditions ? "approved_with_conditions" : "approved";
    const supportingReviewerUserIds = approvalVotes.map((v) => v.reviewerUserId).sort();

    // ---- Condition aggregation metadata (§D9) — metadata only, never
    // the condition text itself; only contributes when the winning group's
    // exact status is approved_with_conditions. ----
    let conditionsSummary = { contributingVoteCount: 0, uniqueConditionCount: 0, hasConditions: false };
    if (finalStatus === "approved_with_conditions") {
      const contributing = approvalVotes.filter((v) => v.status === "approved_with_conditions");
      const uniqueConditions = new Set(contributing.flatMap((v) => v.conditions ?? []));
      conditionsSummary = {
        contributingVoteCount: contributing.length,
        uniqueConditionCount: uniqueConditions.size,
        hasConditions: uniqueConditions.size > 0,
      };
    }

    return {
      status: "ready",
      policyVersion: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION,
      finalStatus,
      reviewerCount,
      quorum,
      submittedCount,
      approvalGroupCount,
      blockingGroupCount,
      supportingReviewerUserIds,
      conditionsSummary,
    };
  }

  // blockingWins
  const anyRejected = blockingVotes.some((v) => v.status === "rejected");
  const finalStatus: AdaptiveReviewDecisionStatus = anyRejected ? "rejected" : "changes_requested";
  const supportingReviewerUserIds = blockingVotes.map((v) => v.reviewerUserId).sort();

  return {
    status: "ready",
    policyVersion: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION,
    finalStatus,
    reviewerCount,
    quorum,
    submittedCount,
    approvalGroupCount,
    blockingGroupCount,
    supportingReviewerUserIds,
    conditionsSummary: { contributingVoteCount: 0, uniqueConditionCount: 0, hasConditions: false },
  };
}
