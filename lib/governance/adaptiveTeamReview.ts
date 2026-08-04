/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part C — adaptive team-review
 * routing, projection contract, and deterministic projection identity.
 * Implements docs/governance-decision-receipts-design.md §21 exactly —
 * that document is the source of truth wherever this prompt's own
 * shorthand differs from it.
 *
 * This module is entirely pure and I/O-free. It never calls
 * `policyEngine.ts`/`applyTeamGovernancePipeline` (legacy System B, §20.5:
 * every legacy team-policy rule requires a `ConsensusSummary` no adaptive
 * schema produces) and is never called by them either. Firestore
 * persistence for the projection itself lives in `lib/firestore/teamRuns.ts`,
 * deliberately separate from this pure module.
 */

import { AnswerShape } from "../adaptiveSchema/types";
import { PersistedAdaptiveSchemaId } from "../adaptiveSchema/persistedOutput";
import { AdaptiveReviewMode, AdaptiveReviewSettings, AdaptiveMultiReviewerMode, AdaptiveMultiReviewerSettings } from "./teamTypes";

const VALID_MODES: ReadonlySet<AdaptiveReviewMode> = new Set(["flagged_only", "human_review_needed", "all"]);

const VALID_MULTI_REVIEWER_MODES: ReadonlySet<AdaptiveMultiReviewerMode> = new Set(["majority_quorum"]);

/**
 * Multi-Reviewer Panel Foundation, Part B — mirrors `parseAdaptiveReviewSettings`
 * below exactly: fails closed to fully disabled on anything absent or
 * malformed, never a silent permissive fallback, never throws. A team that
 * has never configured this setting (every existing team, today) parses
 * identically to a team that explicitly set `enabled: false` — there is no
 * third state. `mode` only ever accepts `"majority_quorum"` in Part B; any
 * other string (including a hypothetical future `"unanimous"`) parses as
 * disabled, never silently coerced to the one supported mode.
 */
export function parseAdaptiveMultiReviewerSettings(raw: unknown): AdaptiveMultiReviewerSettings {
  const disabled: AdaptiveMultiReviewerSettings = { enabled: false, mode: "majority_quorum" };
  if (!raw || typeof raw !== "object") return disabled;
  const data = raw as Record<string, unknown>;
  if (typeof data.enabled !== "boolean") return disabled;
  if (typeof data.mode !== "string" || !VALID_MULTI_REVIEWER_MODES.has(data.mode as AdaptiveMultiReviewerMode)) return disabled;
  return { enabled: data.enabled, mode: data.mode as AdaptiveMultiReviewerMode };
}

/**
 * Fails closed to fully disabled on anything malformed — absent, wrong
 * types, or an unrecognized `mode` value all resolve to
 * `{enabled: false, mode: "flagged_only"}` (the `mode` value is irrelevant
 * once `enabled` is false, but a concrete value is still returned rather
 * than `undefined`, so callers never need a second null-check). Never a
 * silent permissive fallback — a malformed setting can only ever result in
 * LESS eligibility, never more.
 */
export function parseAdaptiveReviewSettings(raw: unknown): AdaptiveReviewSettings {
  const disabled: AdaptiveReviewSettings = { enabled: false, mode: "flagged_only" };
  if (!raw || typeof raw !== "object") return disabled;
  const data = raw as Record<string, unknown>;
  if (typeof data.enabled !== "boolean") return disabled;
  if (typeof data.mode !== "string" || !VALID_MODES.has(data.mode as AdaptiveReviewMode)) return disabled;
  return { enabled: data.enabled, mode: data.mode as AdaptiveReviewMode };
}

export type AdaptiveTeamReviewRoutingResult = {
  shouldCreateProjection: boolean;
  reason: "disabled" | "flagged" | "blocked" | "human_review_needed" | "all_runs" | "not_eligible";
};

/**
 * Pure, synchronous, zero I/O, zero model/classifier calls, never reads
 * receipt content or the user question — only the 3 already-computed,
 * non-sensitive signals listed below. `settings` absent is handled
 * identically to `settings.enabled === false` (both are "disabled") —
 * callers may pass the raw, possibly-absent team setting directly rather
 * than needing their own extra branch.
 */
export function routeAdaptiveTeamReview(args: {
  humanReviewNeeded: boolean;
  automatedGovernanceStatus?: "passed" | "flagged" | "blocked" | "not_evaluated" | "error";
  settings?: AdaptiveReviewSettings;
}): AdaptiveTeamReviewRoutingResult {
  if (!args.settings || !args.settings.enabled) {
    return { shouldCreateProjection: false, reason: "disabled" };
  }

  const { mode } = args.settings;

  if (mode === "all") {
    return { shouldCreateProjection: true, reason: "all_runs" };
  }

  if (mode === "flagged_only") {
    if (args.automatedGovernanceStatus === "flagged") {
      return { shouldCreateProjection: true, reason: "flagged" };
    }
    if (args.automatedGovernanceStatus === "blocked") {
      return { shouldCreateProjection: true, reason: "blocked" };
    }
    // "passed" | "not_evaluated" | "error" | undefined — none qualify.
    // An evaluation ERROR is deliberately NOT treated as "flagged" — a
    // failure to evaluate is not evidence the run needs review, and
    // treating it that way would fabricate a signal from an absence of one.
    return { shouldCreateProjection: false, reason: "not_eligible" };
  }

  // mode === "human_review_needed" — per §21.3, this mode checks ONLY
  // decisionReceipt.humanReviewNeeded, independent of automatedGovernanceStatus
  // entirely (not "flagged/blocked also qualifies") — this is the one mode
  // that can route a run to review even when automated governance errored
  // or was never evaluated, since humanReviewNeeded comes from the receipt,
  // not from automated governance.
  return args.humanReviewNeeded
    ? { shouldCreateProjection: true, reason: "human_review_needed" }
    : { shouldCreateProjection: false, reason: "not_eligible" };
}

/** Maximum stored length for the projection's copy of the receipt conclusion — a queue-display field, not the canonical content (which remains governanceRecord.decisionReceipt.conclusion, unbounded). Not specified in §21; established here as a conservative, deterministic limit consistent with this codebase's own existing queue-field truncation precedents (writeAuditEvent's 200-char question truncation, teamGovernancePipeline's 5000-char query truncation) — 300 chars is enough for a one-line queue summary without approaching either precedent's scale. */
export const RECEIPT_CONCLUSION_PROJECTION_LIMIT = 300;

/** Truncates only — never rewrites or summarizes semantically. Deterministic: identical input always produces identical output. */
export function truncateReceiptConclusionForProjection(conclusion: string): string {
  if (conclusion.length <= RECEIPT_CONCLUSION_PROJECTION_LIMIT) return conclusion;
  return `${conclusion.slice(0, RECEIPT_CONCLUSION_PROJECTION_LIMIT - 1)}…`;
}

/**
 * The compact adaptive queue-projection contract (§21.1). Deliberately
 * excludes: full decisionReceipt, sources, basis, assumptions,
 * uncertainties, limitations, raw model output, question text, comment,
 * conditions, and reviewer identity — none of those are ever read by this
 * module or by the builder below. `humanReview`'s full richness (comment,
 * conditions, reviewerId/reviewerName) stays canonical ONLY on
 * governanceRecord — teamRuns never becomes a second source of truth for
 * any of it (§21, non-negotiable).
 *
 * Uses `adaptive: true` as the discriminator (not `kind: "adaptive"`) —
 * matching the exact field name already established in §21.1 rather than
 * switching to an equivalent-but-different name for no functional reason.
 */
export interface AdaptiveTeamRunProjection {
  projectionVersion: 1;

  teamId: string;
  userId: string;
  runId: string;

  adaptive: true;

  schemaId: PersistedAdaptiveSchemaId;
  answerShape: AnswerShape;

  receiptConclusion: string;
  sourceBacked: boolean;
  humanReviewNeeded: boolean;

  automatedGovernanceStatus?: "passed" | "flagged" | "blocked" | "not_evaluated" | "error";

  humanReviewStatus: "unreviewed" | "pending" | "approved" | "approved_with_conditions" | "changes_requested" | "rejected";
  /**
   * Query-Routing Redesign, Phase 2A, Step 7, Part D — additive. Absent at
   * creation time (Part C never set it, since no review capability existed
   * yet); populated only by `syncAdaptiveTeamRunProjectionAfterReview()`
   * (`lib/firestore/teamRuns.ts`) after the canonical review transaction
   * commits. Mirrors `governanceRecord.humanReview.reviewedAt` — synced
   * only, never written directly by the review route itself.
   */
  reviewedAt?: string;

  createdAt: string;
  updatedAt: string;
}

/**
 * Builds the projection object (no I/O) from already-validated inputs —
 * the caller (route wiring, Part C9) is responsible for having already
 * confirmed a `"valid"` `GovernanceRecordV1` exists before calling this.
 */
export function buildAdaptiveTeamRunProjection(args: {
  teamId: string;
  userId: string;
  runId: string;
  schemaId: PersistedAdaptiveSchemaId;
  answerShape: AnswerShape;
  receiptConclusion: string;
  sourceBacked: boolean;
  humanReviewNeeded: boolean;
  automatedGovernanceStatus?: "passed" | "flagged" | "blocked" | "not_evaluated" | "error";
  humanReviewStatus: "unreviewed" | "pending" | "approved" | "approved_with_conditions" | "changes_requested" | "rejected";
  now: string;
}): AdaptiveTeamRunProjection {
  return {
    projectionVersion: 1,
    teamId: args.teamId,
    userId: args.userId,
    runId: args.runId,
    adaptive: true,
    schemaId: args.schemaId,
    answerShape: args.answerShape,
    receiptConclusion: truncateReceiptConclusionForProjection(args.receiptConclusion),
    sourceBacked: args.sourceBacked,
    humanReviewNeeded: args.humanReviewNeeded,
    automatedGovernanceStatus: args.automatedGovernanceStatus,
    humanReviewStatus: args.humanReviewStatus,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/**
 * Deterministic, collision-safe projection ID — `${teamId}:${runId}`.
 * Verified (not assumed) collision-safe against the ACTUAL ID domains in
 * this codebase: `teamId` is always server-generated as
 * `team_${uid.slice(0,8)}_${Date.now()}` (`app/api/teams/route.ts`) and
 * `runId` is always `run-${randomUUID()}` (`app/api/run-panel/route.ts`)
 * — neither ever contains a `:` character, so splitting the composite
 * string on its FIRST `:` unambiguously recovers `teamId`, meaning no two
 * distinct (teamId, runId) pairs can ever produce the same composite
 * string. This is a real proof against the real ID formats, not a
 * generically "probably fine" assumption.
 */
export function buildAdaptiveTeamRunProjectionId(teamId: string, runId: string): string {
  if (!teamId || !teamId.trim()) {
    throw new Error("buildAdaptiveTeamRunProjectionId: teamId must not be empty");
  }
  if (!runId || !runId.trim()) {
    throw new Error("buildAdaptiveTeamRunProjectionId: runId must not be empty");
  }
  if (teamId.includes("/") || runId.includes("/")) {
    throw new Error("buildAdaptiveTeamRunProjectionId: teamId/runId must not contain '/'");
  }
  return `${teamId}:${runId}`;
}
