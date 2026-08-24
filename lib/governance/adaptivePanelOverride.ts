/**
 * Multi-Reviewer Owner Override, Part F
 * (docs/governance-decision-receipts-design.md §34). Pure model: request
 * validation, the deterministic override-decision identity, and the
 * canonical `humanReview` provenance builder for the OWNER OVERRIDE path.
 * No I/O — Firestore reads/writes live in `lib/firestore/runs.ts`.
 *
 * Deliberately parallel to `adaptivePanelFinalization.ts` (the aggregation
 * finalization path) rather than a fork of it — same shape, same
 * discipline (pure builders, metadata-only broad artifacts, deterministic
 * idempotency-key-as-ID), but override has no votes/aggregation as input:
 * its entire "outcome" IS the owner's validated request (status,
 * justification, conditions), which is why (unlike the aggregation
 * decision ID) the override decision ID's hash material includes the
 * justification and conditions content — an identical retry of the exact
 * same request must produce the exact same ID (idempotent), while a
 * changed retry (different status/justification/conditions) must produce a
 * DIFFERENT id, which the transaction layer then recognizes as a conflict
 * against an already-finalized panel rather than a silent overwrite (§F7).
 */

import { createHash } from "crypto";
import { AdaptiveReviewFinalStatus } from "./adaptiveHumanReviewPanel";
import {
  ADAPTIVE_REVIEW_DECISION_STATUSES,
  AdaptiveReviewDecisionStatus,
  MAX_REVIEW_COMMENT_LENGTH,
  validateConditionsForStatus,
  ConditionsForStatusFailureReason,
} from "./adaptiveHumanReviewRequest";
import { isValidTimestamp } from "../adaptiveSchema/governanceRecordParser";
import { GovernanceRecordV1 } from "../adaptiveSchema/governanceRecord";

// ============================================
// Request validation (§F2/§F4)
// ============================================

export type SubmitAdaptiveReviewOverrideRequest = {
  expectedPanelRevision: number;
  expectedGovernanceUpdatedAt: string;
  status: AdaptiveReviewFinalStatus;
  justification: string;
  conditions?: string[];
};

export type SubmitAdaptiveReviewOverrideValidationFailureReason =
  | "malformed_body"
  | "missing_expected_panel_revision"
  | "invalid_expected_panel_revision"
  | "missing_expected_governance_updated_at"
  | "invalid_expected_governance_updated_at"
  | "invalid_status"
  | "missing_justification"
  | "invalid_justification"
  | "justification_too_long"
  | ConditionsForStatusFailureReason;

export type SubmitAdaptiveReviewOverrideValidationResult =
  | { ok: true; value: SubmitAdaptiveReviewOverrideRequest }
  | { ok: false; reason: SubmitAdaptiveReviewOverrideValidationFailureReason };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deliberately does NOT accept or read `teamId`, any actor/reviewer
 * identity, `finalDecisionId`, any timestamp other than
 * `expectedGovernanceUpdatedAt` (a CONCURRENCY TOKEN, not a decision
 * timestamp — never used as `finalizedAt`), vote IDs, quorum, or any
 * aggregation result from the raw body — none of those keys are ever read
 * here, so there is nothing that could accidentally trust a client-supplied
 * value for any of them (mirrors `parseAdaptiveReviewDecisionRequest`'s own
 * documented non-goals).
 */
export function parseSubmitAdaptiveReviewOverrideRequest(raw: unknown): SubmitAdaptiveReviewOverrideValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "malformed_body" };
  }

  if (raw.expectedPanelRevision === undefined || raw.expectedPanelRevision === null) {
    return { ok: false, reason: "missing_expected_panel_revision" };
  }
  if (typeof raw.expectedPanelRevision !== "number" || !Number.isInteger(raw.expectedPanelRevision) || raw.expectedPanelRevision < 1) {
    return { ok: false, reason: "invalid_expected_panel_revision" };
  }
  const expectedPanelRevision = raw.expectedPanelRevision;

  if (raw.expectedGovernanceUpdatedAt === undefined || raw.expectedGovernanceUpdatedAt === null || raw.expectedGovernanceUpdatedAt === "") {
    return { ok: false, reason: "missing_expected_governance_updated_at" };
  }
  if (!isValidTimestamp(raw.expectedGovernanceUpdatedAt)) {
    return { ok: false, reason: "invalid_expected_governance_updated_at" };
  }
  const expectedGovernanceUpdatedAt = raw.expectedGovernanceUpdatedAt;

  if (typeof raw.status !== "string" || !ADAPTIVE_REVIEW_DECISION_STATUSES.has(raw.status)) {
    return { ok: false, reason: "invalid_status" };
  }
  const status = raw.status as AdaptiveReviewDecisionStatus;

  if (raw.justification === undefined || raw.justification === null) {
    return { ok: false, reason: "missing_justification" };
  }
  if (typeof raw.justification !== "string") {
    return { ok: false, reason: "invalid_justification" };
  }
  const trimmedJustification = raw.justification.trim();
  if (trimmedJustification.length === 0) {
    return { ok: false, reason: "missing_justification" };
  }
  if (trimmedJustification.length > MAX_REVIEW_COMMENT_LENGTH) {
    return { ok: false, reason: "justification_too_long" };
  }

  const conditionsResult = validateConditionsForStatus(status, raw.conditions);
  if (!conditionsResult.ok) {
    return { ok: false, reason: conditionsResult.reason };
  }

  return {
    ok: true,
    value: {
      expectedPanelRevision,
      expectedGovernanceUpdatedAt,
      status,
      justification: trimmedJustification,
      conditions: conditionsResult.conditions,
    },
  };
}

// ============================================
// Deterministic override decision ID (§F7)
// ============================================

/**
 * Distinct prefix (`panel_override_dec_`) from BOTH the single-reviewer
 * path's `dec_` and the aggregation path's `panel_dec_` — no collision risk
 * across the same `humanReviewHistory` collection. Unlike
 * `buildAdaptivePanelFinalDecisionId`, the hash material here DOES include
 * the request's own content (`status`, `justification`, `conditions`) —
 * NOT because those are timestamps (they aren't), but because for an
 * override the request itself IS the entire decision outcome; there is no
 * separate, independently-computed "aggregation result" the way the
 * aggregation path has. Excludes any wall-clock timestamp, so the ID
 * remains a pure function of WHAT was decided, not WHEN — a byte-identical
 * retry (down to `justification`/`conditions`) always yields the same ID.
 */
export function buildAdaptivePanelOverrideDecisionId(args: {
  teamId: string;
  runId: string;
  panelRevision: number;
  status: string;
  justification: string;
  conditions?: string[];
}): string {
  if (!args.teamId || !args.teamId.trim()) throw new Error("buildAdaptivePanelOverrideDecisionId: teamId must not be empty");
  if (!args.runId || !args.runId.trim()) throw new Error("buildAdaptivePanelOverrideDecisionId: runId must not be empty");
  if (!Number.isInteger(args.panelRevision) || args.panelRevision < 1) {
    throw new Error("buildAdaptivePanelOverrideDecisionId: panelRevision must be a positive integer");
  }
  if (!args.status || !args.status.trim()) throw new Error("buildAdaptivePanelOverrideDecisionId: status must not be empty");
  if (!args.justification || !args.justification.trim()) {
    throw new Error("buildAdaptivePanelOverrideDecisionId: justification must not be empty");
  }

  const conditionsPart = args.conditions && args.conditions.length > 0 ? args.conditions.join("␟") : "";
  const material = `owner_override:${args.teamId}:${args.runId}:${args.panelRevision}:${args.status}:${args.justification}:${conditionsPart}`;
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  return `panel_override_dec_${digest}`;
}

/**
 * Phase 9B.5.2 — Workspace-scoped sibling of `buildAdaptivePanelOverrideDecisionId`,
 * exactly mirroring `buildWorkspaceReviewDecisionId`'s (Phase 9B.5.1) and
 * `buildWorkspacePanelFinalDecisionId`'s (this phase) own precedent: purely
 * additive, keyed on `workspaceId` (required non-empty — a Workspace-bound
 * panel always has one once it exists), distinct prefix
 * (`panel_workspace_override_dec_`), zero changes to
 * `buildAdaptivePanelOverrideDecisionId` itself or any existing legacy Team
 * caller.
 */
export function buildWorkspacePanelOverrideDecisionId(args: {
  workspaceId: string;
  runId: string;
  panelRevision: number;
  status: string;
  justification: string;
  conditions?: string[];
}): string {
  if (!args.workspaceId || !args.workspaceId.trim()) throw new Error("buildWorkspacePanelOverrideDecisionId: workspaceId must not be empty");
  if (!args.runId || !args.runId.trim()) throw new Error("buildWorkspacePanelOverrideDecisionId: runId must not be empty");
  if (!Number.isInteger(args.panelRevision) || args.panelRevision < 1) {
    throw new Error("buildWorkspacePanelOverrideDecisionId: panelRevision must be a positive integer");
  }
  if (!args.status || !args.status.trim()) throw new Error("buildWorkspacePanelOverrideDecisionId: status must not be empty");
  if (!args.justification || !args.justification.trim()) {
    throw new Error("buildWorkspacePanelOverrideDecisionId: justification must not be empty");
  }

  const conditionsPart = args.conditions && args.conditions.length > 0 ? args.conditions.join("␟") : "";
  const material = `owner_override:workspace:${args.workspaceId}:${args.runId}:${args.panelRevision}:${args.status}:${args.justification}:${conditionsPart}`;
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  return `panel_workspace_override_dec_${digest}`;
}

// ============================================
// Canonical humanReview provenance (§F6)
// ============================================

const SYSTEM_GENERATED_OVERRIDE_COMMENT = "Finalized by owner override.";

/**
 * Mirrors `buildFinalSystemComment` — no free-text "comment" field exists
 * on the override request (only `justification`, a distinct field), so a
 * fixed system-generated string is used for the two statuses that require
 * SOME comment under the existing shared status-rule vocabulary, exactly
 * as the aggregation path does for its own system-generated comment.
 */
export function buildOverrideSystemComment(finalStatus: AdaptiveReviewFinalStatus): string | undefined {
  if (finalStatus === "changes_requested" || finalStatus === "rejected") {
    return SYSTEM_GENERATED_OVERRIDE_COMMENT;
  }
  return undefined;
}

/**
 * Pure. Builds the exact `GovernanceRecordV1["humanReview"]` value the
 * override transaction writes. `reviewerId` is the OVERRIDING OWNER's
 * uid — never a voter's uid (there may be zero votes at all when an owner
 * overrides a deadlocked or still-waiting panel). The full `justification`
 * text IS stored here (this is the canonical decision record, not a broad
 * artifact) — but this builder's output must never be copied verbatim into
 * history/event/audit artifacts, which store only `overrideJustificationPresent`
 * (see `buildAdaptivePanelOverrideHistoryEntry`-style broad builders in the
 * Firestore layer, §F8).
 */
export function buildOverriddenMultiReviewerHumanReview(args: {
  finalStatus: AdaptiveReviewFinalStatus;
  overridingOwnerUid: string;
  reviewedAt: string;
  justification: string;
  conditions?: string[];
  panelRevision: number;
}): GovernanceRecordV1["humanReview"] {
  return {
    status: args.finalStatus,
    reviewerId: args.overridingOwnerUid,
    reviewedAt: args.reviewedAt,
    comment: buildOverrideSystemComment(args.finalStatus),
    conditions: args.finalStatus === "approved_with_conditions" ? args.conditions : undefined,
    decidedVia: "multi_reviewer_owner_override",
    panelRevision: args.panelRevision,
    overrideJustification: args.justification,
  };
}

// ============================================
// Immutable panel override history (§F8)
// ============================================

/**
 * Metadata only — mirrors `AdaptivePanelFinalizationHistoryV1`'s own
 * discipline exactly, but NEVER the full justification text, only
 * `overrideJustificationPresent`/`conditionsCount`. No reviewer/vote counts
 * at all — an override has no votes as input, so there is nothing
 * analogous to `reviewerCount`/`submittedCount`/`supportingReviewerCount`
 * to record here. `eventId` follows the SAME
 * `${revision}:${eventType}` convention as the aggregation path's own
 * history entry, in the SAME `humanReviewPanelHistory` subcollection — a
 * distinct `eventType` string keeps the two kinds of entries
 * non-colliding and uniformly readable through the one existing history
 * collection.
 */
export type AdaptivePanelOverrideHistoryV1 = {
  schemaVersion: 1;
  eventId: string;
  eventType: "panel_owner_overridden";
  /** Phase 9B.5.2 — `null` for a Workspace-bound panel's override, mirroring `AdaptiveHumanReviewPanelV1.teamId`'s own widening. */
  teamId: string | null;
  runId: string;
  preOverridePanelRevision: number;
  overriddenPanelRevision: number;
  finalStatus: AdaptiveReviewFinalStatus;
  finalDecisionId: string;
  overrideByUserId: string;
  overrideJustificationPresent: true;
  conditionsCount: number;
  finalizedAt: string;
};

export function buildAdaptivePanelOverrideHistoryEntry(args: {
  teamId: string | null;
  runId: string;
  preOverridePanelRevision: number;
  overriddenPanelRevision: number;
  finalStatus: AdaptiveReviewFinalStatus;
  finalDecisionId: string;
  overrideByUserId: string;
  conditionsCount: number;
  finalizedAt: string;
}): AdaptivePanelOverrideHistoryV1 {
  return {
    schemaVersion: 1,
    eventId: `${args.overriddenPanelRevision}:panel_owner_overridden`,
    eventType: "panel_owner_overridden",
    teamId: args.teamId,
    runId: args.runId,
    preOverridePanelRevision: args.preOverridePanelRevision,
    overriddenPanelRevision: args.overriddenPanelRevision,
    finalStatus: args.finalStatus,
    finalDecisionId: args.finalDecisionId,
    overrideByUserId: args.overrideByUserId,
    overrideJustificationPresent: true,
    conditionsCount: args.conditionsCount,
    finalizedAt: args.finalizedAt,
  };
}
