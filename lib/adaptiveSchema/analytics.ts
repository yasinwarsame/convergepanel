/**
 * Query-Routing Redesign, Milestone 1.5 — server-side analytics events.
 *
 * Six events, tracked separately so product can answer specific questions
 * (how often Claim/Video Verification handoffs fire from Deep Research, how
 * often each disabled schema is requested, how many model calls are
 * avoided) rather than inferring them from one generic "run" event.
 *
 * Never sends raw question/claim text — only classification metadata
 * (queryType, kind, riskLevel, etc.) per the "don't send sensitive query
 * content to analytics by default" rule. Never throws; a PostHog outage
 * must not block or fail a panel run.
 */

import "server-only";
import { getPostHogClient } from "@/lib/posthog-server";
import { logger } from "@/lib/logger";
import { QueryClassification } from "./types";
import { RoutedQuery } from "./routeClassifiedQuery";

function safeCapture(uid: string, event: string, properties: Record<string, unknown>): void {
  try {
    const ph = getPostHogClient();
    ph.capture({ distinctId: uid, event, properties });
    // Fire-and-forget flush — Vercel Fluid Compute reuses instances, but we
    // still don't want to block the response on network I/O to PostHog.
    void ph.flush().catch((err) => {
      logger.warn("[adaptiveSchema/analytics] PostHog flush failed (non-critical)", { event, error: err?.message });
    });
  } catch (err: any) {
    logger.warn("[adaptiveSchema/analytics] PostHog capture failed (non-critical)", { event, error: err?.message });
  }
}

function baseProperties(classification: QueryClassification) {
  return {
    queryType: classification.queryType,
    riskLevel: classification.riskLevel,
    evidenceRequirement: classification.evidenceRequirement,
    freshness: classification.freshness,
    inputType: classification.inputType,
    confidence: classification.confidence,
    fallbackReason: classification.fallbackReason ?? null,
  };
}

export function trackQueryClassified(uid: string, classification: QueryClassification): void {
  safeCapture(uid, "query_classified", baseProperties(classification));
}

/** One event per non-active routing kind — called once, right after routing, before the early return. */
export function trackRoutingOutcome(uid: string, classification: QueryClassification, routing: Exclude<RoutedQuery, { kind: "active" }>): void {
  const props = { ...baseProperties(classification) };
  switch (routing.kind) {
    case "handoff":
      safeCapture(uid, "query_handoff_shown", { ...props, handoffTarget: routing.handoffTarget });
      return;
    case "disabled":
      safeCapture(uid, "query_capability_blocked", { ...props, capabilityReason: routing.capabilityReason });
      return;
    case "clarification":
      safeCapture(uid, "query_clarification_requested", props);
      return;
    case "unanswerable":
      safeCapture(uid, "query_capability_blocked", { ...props, capabilityReason: "unanswerable" });
      return;
    case "invalid":
      safeCapture(uid, "query_capability_blocked", { ...props, capabilityReason: "invalid_state" });
      return;
  }
}

export type PanelExecutionStatus = "completed" | "partial" | "failed";

export interface PanelExecutionOutcome {
  status: PanelExecutionStatus;
  successfulModels: number;
  failedModels: number;
  totalTokens: number;
}

export function trackPanelExecutionStarted(uid: string, classification: QueryClassification, modelCount: number): void {
  safeCapture(uid, "panel_execution_started", { ...baseProperties(classification), modelCount });
}

/** Fires once, per run, only when ranked_enumeration couldn't responsibly produce the requested count — lets product see how often "top N" requests fall short and by how much. */
export function trackRankedListShortfall(uid: string, classification: QueryClassification, requestedCount: number, actualCount: number): void {
  safeCapture(uid, "ranked_list_shortfall", { ...baseProperties(classification), requestedCount, actualCount });
}

/** Fires once, per run, only when comparison_matrix's panel couldn't converge on at least 2 comparable subjects — a comparison with fewer than 2 subjects is a degenerate outcome worth tracking, the two-axis equivalent of ranked_list_shortfall. */
export function trackComparisonMatrixGap(uid: string, classification: QueryClassification, subjectCount: number, attributeCount: number): void {
  safeCapture(uid, "comparison_matrix_gap", { ...baseProperties(classification), subjectCount, attributeCount });
}

/** Fires once, per run, only when definition_explanation's panel produced more than one materially different interpretation of the term — lets product see how often a question is genuinely ambiguous (multiple accepted meanings, or panel disagreement) rather than converging on one answer. */
export function trackDefinitionAmbiguity(uid: string, classification: QueryClassification, interpretationCount: number): void {
  safeCapture(uid, "definition_ambiguity_detected", { ...baseProperties(classification), interpretationCount });
}

/** Fires once, per run, only when causal_explanation's panel produced a genuinely weak result — no direct causes survived, or materially conflicting causal interpretations remain unresolved. Never implies the underlying question was unanswerable, only that this run's causal account was thin — metadata only, never raw question text. */
export function trackCausalExplanationGap(
  uid: string,
  classification: QueryClassification,
  reason: "no_direct_causes" | "unresolved_disputed_interpretations"
): void {
  safeCapture(uid, "causal_explanation_gap", { ...baseProperties(classification), reason });
}

/** Fires once, per run, only when checklist_taxonomy's panel couldn't converge on any well-supported item — every item the panel raised ended up in the low-confidence bucket. Metadata only (counts), never raw question text. */
export function trackChecklistTaxonomyGap(uid: string, classification: QueryClassification, lowConfidenceItemCount: number): void {
  safeCapture(uid, "checklist_taxonomy_gap", { ...baseProperties(classification), lowConfidenceItemCount });
}

/** Fires once, per run, only when deep_research's synthesis came back genuinely thin — no finding has source support, or panel coverage/source diversity is very low. Metadata only (counts/ratios), never raw question text. */
export function trackDeepResearchGap(
  uid: string,
  classification: QueryClassification,
  reason: "no_sourced_findings" | "low_source_coverage"
): void {
  safeCapture(uid, "deep_research_gap", { ...baseProperties(classification), reason });
}

/** Fires once, per run, only when evidence_review's overall verdict is weak or contested — lets product see how often the panel flags genuinely shaky evidence rather than converging on a confident read. Metadata only, never raw question text. */
export function trackEvidenceReviewGap(uid: string, classification: QueryClassification, overallStrength: string): void {
  safeCapture(uid, "evidence_review_gap", { ...baseProperties(classification), overallStrength });
}

/** Fires once, per run, only when bias_blindspot_audit's Tier 1 came back empty — lets product see how often no model-specific bias was confidently attributable, distinct from a genuine "no bias found" claim. Metadata only (the reason enum), never raw excerpts. */
export function trackBiasAuditNoAttribution(uid: string, classification: QueryClassification, reason: string): void {
  safeCapture(uid, "bias_audit_no_attribution", { ...baseProperties(classification), reason });
}

/** Fires once, per run, only when Tier 2 found at least one panel-level omission. Metadata only (a count), never raw dimension text. */
export function trackBiasAuditPanelGapFound(uid: string, classification: QueryClassification, gapCount: number): void {
  safeCapture(uid, "bias_audit_panel_gap_found", { ...baseProperties(classification), gapCount });
}

/** Fires once, per run, only when Tier 3's homogeneity check flagged unusually uniform agreement. Metadata only (a boolean flag, implicit in the event itself), never raw content. */
export function trackBiasAuditHomogeneityFlagged(uid: string, classification: QueryClassification): void {
  safeCapture(uid, "bias_audit_homogeneity_flagged", baseProperties(classification));
}

/** Fires once, per run, only when decision_support's aggregated recommendation is genuinely contested — contributing models' own recommended actions (or, for choose_option, their chosen options) didn't converge, so the aggregate fell back to a conservative action rather than a vote-counted winner. Metadata only (the resulting action), never raw rationale text. */
export function trackDecisionSupportContested(uid: string, classification: QueryClassification, action: string): void {
  safeCapture(uid, "decision_support_contested", { ...baseProperties(classification), action });
}

/** Fires once, per run, only when decision_support produced at least one sensitivity finding — lets product see how often "the recommendation depends on what you weight" is the honest answer rather than a single confident pick. Metadata only (a count), never raw finding text. */
export function trackDecisionSupportHighSensitivity(uid: string, classification: QueryClassification, sensitivityFindingCount: number): void {
  safeCapture(uid, "decision_support_high_sensitivity", { ...baseProperties(classification), sensitivityFindingCount });
}

/** Fires once, per run, only when decision_support flagged genuinely missing decision-critical information (uncertainties) — distinct from the pre-execution requiresClarification path (tracked generically by query_clarification_requested), this covers a run that still executed but surfaced a real gap rather than silently deciding for the user. Metadata only (a count), never raw uncertainty text. */
export function trackDecisionSupportMissingCriteria(uid: string, classification: QueryClassification, uncertaintyCount: number): void {
  safeCapture(uid, "decision_support_missing_criteria", { ...baseProperties(classification), uncertaintyCount });
}

/**
 * Fires once runPanel() returns — status reflects whether every model
 * actually produced usable output, not just that the call didn't throw
 * (runPanel absorbs per-model failures via Promise.allSettled, so a
 * "successful" call can still carry all-failed results).
 */
export function trackPanelExecutionCompleted(uid: string, classification: QueryClassification, outcome: PanelExecutionOutcome): void {
  safeCapture(uid, "panel_execution_completed", { ...baseProperties(classification), ...outcome });
}

/** Fires only when runPanel() itself throws (an orchestration failure, not a per-model one) — pairs with panel_execution_started so a start event is never left orphaned without a terminal event. */
export function trackPanelExecutionFailed(uid: string, classification: QueryClassification, errorMessage: string): void {
  safeCapture(uid, "panel_execution_failed", { ...baseProperties(classification), errorMessage });
}
