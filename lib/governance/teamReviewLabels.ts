/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — centralized
 * presentation label helpers for the adaptive team-review UI
 * (docs/governance-decision-receipts-design.md §25). Pure string mapping
 * only — no React, no I/O. Never renames the underlying persisted enum
 * values themselves; these are display labels only.
 */

import { PersistedAdaptiveSchemaId } from "../adaptiveSchema/persistedOutput";
import { AnswerShape } from "../adaptiveSchema/types";
import { AutomatedGovernanceStatusValue } from "./teamRunListContract";
import { HumanReviewStatus } from "../adaptiveSchema/governanceRecordParser";

/** Rendered whenever an incoming value isn't one of the known, mapped enum values — never guessed or partially rendered. */
export const UNKNOWN_LABEL = "Unknown";

const SCHEMA_LABELS: Record<PersistedAdaptiveSchemaId, string> = {
  ranked_enumeration: "Ranked List",
  comparison_matrix: "Comparison",
  definition_explanation: "Explanation",
  causal_explanation: "Cause and Effect",
  checklist_taxonomy: "Checklist",
  deep_research: "Deep Research",
  evidence_review: "Evidence Review",
  bias_blindspot_audit: "Bias and Blind-Spot Audit",
  decision_support: "Decision Support",
};

export function schemaLabel(schemaId: string | undefined | null): string {
  if (!schemaId) return UNKNOWN_LABEL;
  return SCHEMA_LABELS[schemaId as PersistedAdaptiveSchemaId] ?? UNKNOWN_LABEL;
}

const ANSWER_SHAPE_LABELS: Partial<Record<AnswerShape, string>> = {
  ranked_list: "Ranked List",
  comparison_grid: "Comparison Grid",
  definition_card: "Definition Card",
  causal_map: "Causal Map",
  checklist_taxonomy_view: "Checklist View",
  deep_research_view: "Deep Research View",
  evidence_review_view: "Evidence Review View",
  bias_blindspot_audit_view: "Bias & Blind-Spot Audit View",
  decision_support_view: "Decision Support View",
};

export function answerShapeLabel(answerShape: string | undefined | null): string {
  if (!answerShape) return UNKNOWN_LABEL;
  return ANSWER_SHAPE_LABELS[answerShape as AnswerShape] ?? UNKNOWN_LABEL;
}

const AUTOMATED_GOVERNANCE_STATUS_LABELS: Record<AutomatedGovernanceStatusValue, string> = {
  passed: "Passed",
  flagged: "Flagged",
  blocked: "Blocked",
  not_evaluated: "Not Evaluated",
  error: "Evaluation Error",
};

export function automatedGovernanceStatusLabel(status: string | undefined | null): string {
  if (!status) return UNKNOWN_LABEL;
  return AUTOMATED_GOVERNANCE_STATUS_LABELS[status as AutomatedGovernanceStatusValue] ?? UNKNOWN_LABEL;
}

const HUMAN_REVIEW_STATUS_LABELS: Record<HumanReviewStatus, string> = {
  unreviewed: "Unreviewed",
  pending: "Pending",
  approved: "Approved",
  approved_with_conditions: "Approved with Conditions",
  changes_requested: "Changes Requested",
  rejected: "Rejected",
};

export function humanReviewStatusLabel(status: string | undefined | null): string {
  if (!status) return UNKNOWN_LABEL;
  return HUMAN_REVIEW_STATUS_LABELS[status as HumanReviewStatus] ?? UNKNOWN_LABEL;
}

/** True for any of the 4 terminal humanReview statuses — used for display copy ("This review is final") independent of the canonical `reviewable` boolean already on the item/detail response. */
export function isTerminalHumanReviewStatusLabel(status: string | undefined | null): boolean {
  return status === "approved" || status === "approved_with_conditions" || status === "changes_requested" || status === "rejected";
}
