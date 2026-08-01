/**
 * Query-Routing Redesign, Phase 2A, Step 2 — the versioned, additive
 * governance contract for persisted adaptive runs (`runs/{runId}.governanceRecord`).
 *
 * Mirrors persistedOutput.ts's own precedent deliberately: a dedicated file
 * for a versioned top-level contract, rather than folding these types into
 * types.ts alongside the schema-specific result shapes they describe but
 * are conceptually separate from.
 *
 * Per docs/governance-decision-receipts-design.md: this is entirely
 * additive and NEVER touches System A (evaluateGovernance.ts's
 * governanceStatus/governanceReasons/governanceMeta) or System B
 * (teamGovernancePipeline.ts's teamRuns collection / the existing
 * single-reviewer governanceReviewedBy/At/Comment fields). Those keep
 * governing the 10 legacy-active schemas and Claim/Video Verification
 * exactly as they do today. `governanceRecord` only ever exists for a run
 * that also has a Phase 1 `adaptiveOutput` — the 9 active Milestone 2
 * schemas.
 *
 * Two deliberate corrections to the originally proposed shape, made after
 * verifying actual repository conventions (not just following the
 * suggested structure verbatim):
 *   - `automatedGovernance.policyVersion` is `number`, not `string` —
 *     `evaluateGovernance.ts`'s own `GovernancePolicy.policyVersion` and
 *     every write site that persists it (`governanceEvents`,
 *     `admin_audit_logs`) use `number` throughout; introducing a `string`
 *     here would be a new, inconsistent convention for the same concept.
 *   - No `Source[]`/structured source type exists anywhere in this
 *     codebase — every one of the 9 schemas' own result types uses plain
 *     `sources: string[]` (verified directly against types.ts). This
 *     contract's `decisionReceipt.sources` does the same, not a new
 *     structured type invented for this one contract.
 *
 * One deliberate omission from the earlier draft `decisionReceipt` shape:
 * `humanDecision`/`conditions` are NOT repeated inside `AdaptiveDecisionReceipt`
 * — `GovernanceRecordV1.humanReview` already owns the review OUTCOME
 * (status/reviewerId/reviewedAt/comment/conditions). `AdaptiveDecisionReceipt`
 * is deliberately scoped to the SCHEMA'S OWN deterministic content only
 * (what the result concluded, rested on, assumed, left uncertain, and drew
 * on) — never the review decision made about it. Keeping these in one
 * place each avoids two fields that could silently disagree about
 * "conditions" if a receipt were ever rebuilt after a review was recorded.
 */

import { AnswerShape, QueryType } from "./types";
import { PersistedAdaptiveSchemaId } from "./persistedOutput";

/**
 * Deterministic, schema-specific summary of what a persisted adaptive
 * result concluded — built once, from already-computed data
 * (`adaptiveOutput`/`CommonResponseMeta`), never by calling a model. One
 * uniform shape; the CONTENT populating it differs per schema (a later
 * step's job, mirroring commonResponseMeta.ts's one-builder-per-schema
 * pattern), per the mapping already agreed for each of the 9 schemas:
 *
 *   - ranked_enumeration: final list (basis), ranking basis, shortfall, source limitations
 *   - comparison_matrix: compared subjects, criteria, missing cells, scenario recommendation
 *   - definition_explanation: accepted interpretation, ambiguity, source support
 *   - causal_explanation: principal factors, alternatives, confounders, evidence limits
 *   - checklist_taxonomy: final checklist/taxonomy, critical items, low-confidence items
 *   - deep_research: executive summary, findings, disagreements, gaps, boundaries
 *   - evidence_review: overall assessment, quality dimensions, red flags, applicability caveats
 *   - bias_blindspot_audit: attributed findings, panel omissions, structural diagnostics
 *   - decision_support: recommendation, criteria, risks, assumptions, uncertainties, reversible step
 */
export interface AdaptiveDecisionReceipt {
  /** One plain-language sentence stating what the result concluded — e.g. decision_support's recommendation rationale, deep_research's executive summary, evidence_review's overall assessment. */
  conclusion: string;
  /** What the conclusion rests on, schema-specific (see the mapping above) — never a generic restatement of the whole result. */
  basis: string[];
  /** What the result assumes without independent confirmation. */
  assumptions: string[];
  /** What remains genuinely uncertain or unresolved — the schema's own semantic uncertainty content, distinct from `limitations` below (a different concern — see commonResponseMeta.ts). */
  uncertainties: string[];
  /**
   * Query-Routing Redesign, Phase 2A, Step 3 addition — preserved verbatim
   * from `CommonResponseMeta.limitations`, never re-derived independently
   * (a receipt rebuilt from the same `adaptiveOutput` must always agree
   * with `meta` on this). Added during Step 3 implementation because the
   * original 5-field shape had no home for it — a real incompatibility
   * discovered while wiring the builder, not a speculative change. See
   * `decisionReceiptBuilder.ts` for the "why this differs from
   * `uncertainties`" reasoning: `limitations` is about the RESULT's own
   * completeness/provenance (e.g. "2 of 5 models did not produce usable
   * output"); `uncertainties` is the schema's own semantic content (e.g.
   * decision_support's own self-reported open questions).
   */
  limitations: string[];
  /** Plain source labels the result draws on — empty, not omitted, when the schema/run has none (mirrors every schema's own `sources: string[]` convention). */
  sources: string[];
  /** Preserved verbatim from `CommonResponseMeta.sourceBacked` — never independently re-derived. Added alongside `limitations` for the same reason (Step 3 needed a home for it). */
  sourceBacked: boolean;
  /** Preserved verbatim from `CommonResponseMeta.humanReviewNeeded` (which itself, for decision_support, already reuses that schema's OWN `humanReviewNeeded` field — see commonResponseMeta.ts) — never recomputed from receipt content or model vote count. */
  humanReviewNeeded: boolean;
}

export interface GovernanceRecordV1 {
  version: 1;

  schemaId: QueryType;
  answerShape: AnswerShape;
  /** The Phase 1 envelope version this record was built from — lets a future reader detect drift between the two versioned contracts independently, without assuming they always move in lockstep. */
  adaptiveOutputVersion: 1;

  /**
   * Absent (not a zero-value status) when automated evaluation never ran at
   * all for this run — distinct from `status: "not_evaluated"`, which means
   * evaluation WAS attempted but the policy engine couldn't meaningfully
   * assess this answer shape (see `notEvaluatedReason`).
   */
  automatedGovernance?: {
    status: "passed" | "flagged" | "blocked" | "not_evaluated" | "error";
    reasons: string[];
    evaluatedAt?: string;
    /** Matches evaluateGovernance.ts's own GovernancePolicy.policyVersion — a number, not a version string. */
    policyVersion?: number;
    /** Required in practice when status is "not_evaluated" (enforced by the runtime validator once one exists, not by the type system — TypeScript can't conditionally require a field only for one value of a sibling union). */
    notEvaluatedReason?: string;
  };

  /**
   * Always present (not optional) — every governed adaptive run has SOME
   * review state, even if it's just "unreviewed". Reuses the current
   * single-reviewer model exactly as verified in
   * docs/governance-decision-receipts-design.md §6: one reviewer, one
   * decision, overwritten on re-review — Phase 2A does not add reviewer
   * arrays, comment threads, or history.
   */
  humanReview: {
    status: "unreviewed" | "pending" | "approved" | "approved_with_conditions" | "changes_requested" | "rejected";
    reviewerId?: string;
    reviewerName?: string;
    reviewedAt?: string;
    /** Current single-reviewer comment — overwritten on re-review, same as the existing governanceReviewComment field elsewhere in the system. */
    comment?: string;
    /** Populated only when status is "approved_with_conditions". */
    conditions?: string[];
    /**
     * Transactional Multi-Reviewer Finalization, Part E
     * (docs/governance-decision-receipts-design.md §33) — additive,
     * optional provenance fields. Absent for every decision made before
     * this step and for every single-reviewer decision going forward
     * (`applyHumanReviewUpdate()`, the single-reviewer decision route's
     * own builder, is completely UNCHANGED and never sets these — a
     * separate, purpose-built pure function used only by the multi-reviewer
     * finalization transaction populates them). `decidedVia` absent is
     * therefore the correct, permanent signal for "single-reviewer (or
     * pre-this-feature)" — never backfilled retroactively.
     *
     * Multi-Reviewer Owner Override, Part F
     * (docs/governance-decision-receipts-design.md §34) — additively widens
     * this union with `"multi_reviewer_owner_override"`, reached only
     * through the override transaction, never through the aggregation
     * finalization path or the single-reviewer route. `overrideJustification`
     * is populated if and only if `decidedVia === "multi_reviewer_owner_override"`
     * — the full justification text IS stored here (this is the canonical
     * decision record, not a broad/shared artifact), but never copied into
     * history/event/audit artifacts, which store only a boolean presence
     * flag (see `overrideJustificationPresent` on
     * `AdaptiveHumanReviewPanelV1`).
     */
    decidedVia?: "single_reviewer" | "multi_reviewer_panel" | "multi_reviewer_owner_override";
    panelRevision?: number;
    aggregationPolicyVersion?: number;
    supportingReviewerCount?: number;
    overrideJustification?: string;
  };

  decisionReceipt: AdaptiveDecisionReceipt;

  /** ISO strings, matching CommonResponseMeta.generatedAt / PersistedAdaptiveOutputV1.generatedAt's established convention — never a raw Firestore Timestamp, which is reserved for the run document's own top-level createdAt/completedAt fields (see lib/firestore/runs.ts). */
  createdAt: string;
  updatedAt: string;
}

/** Schema coverage for this contract is identical to the Phase 1 envelope's — one record per active Milestone 2 schema, never the 10 legacy-active schemas. */
export type GovernanceRecordSchemaId = PersistedAdaptiveSchemaId;
