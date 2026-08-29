/**
 * Adaptive Result Schema System — Core Types
 *
 * Two-stage design:
 * 1. classifyQuery() tags a query with a QueryClassification (epistemic type).
 * 2. SCHEMA_REGISTRY maps each QueryType to a ResultSchema that drives both
 *    the per-model prompt (promptBuilder.ts) and the comparison renderer
 *    (components/adaptive/*).
 *
 * Sections are never optional within a schema — optionality is resolved by
 * choosing a different schema, not by letting models emit empty headers.
 */

import { ModelId } from "@/lib/types";

export type QueryType =
  // Existing production schemas — unchanged, still fully active.
  | "contested_empirical"
  | "legal_regulatory"
  | "financial_valuation"
  | "factual_lookup"
  | "procedural"
  | "medical_health"
  | "forecast_speculative"
  | "creative_generative"
  | "generic"
  // Query-routing redesign, Milestone 1 — active.
  | "graceful_limitation"
  // Query-routing redesign — handoff-only (no schema body; see
  // SchemaImplementationStatus). Exist purely so the classifier has a
  // precise label to detect before the router redirects to the dedicated
  // Claim Verification / Video Verification workflow.
  | "claim_verification"
  | "media_authenticity_review"
  // Query-routing redesign — disabled, missing capability (see
  // docs/technical-documentation.md "Query Routing" section for the audit
  // findings behind each of these).
  | "document_qa"
  | "document_comparison"
  | "data_analysis"
  | "current_live_information"
  // Query-routing redesign — disabled, not yet implemented (future milestones).
  | "definition_explanation"
  | "causal_explanation"
  | "ranked_enumeration"
  | "checklist_taxonomy"
  | "comparison_matrix"
  | "deep_research"
  | "evidence_review"
  | "bias_blindspot_audit"
  | "decision_support"
  | "scenario_analysis"
  | "step_by_step_plan"
  | "transformation";

export type AnswerShape =
  | "consensus_map"
  | "rule_application"
  | "metrics_grid"
  | "verdict_card"
  | "step_diff"
  | "evidence_tiers"
  | "scenario_tree"
  | "gallery"
  | "generic_sections"
  // Query-routing redesign, Milestone 1.
  | "direct_answer"
  // Query-routing redesign, Milestone 2.
  | "ranked_list"
  | "comparison_grid"
  | "definition_card"
  | "causal_map"
  | "checklist_taxonomy_view"
  | "deep_research_view"
  | "evidence_review_view"
  | "bias_blindspot_audit_view"
  | "decision_support_view"
  | "limitation_notice";

/** Why the classifier fell back to the defensive "generic" default instead of a genuine model classification. */
export type QueryClassificationFallbackReason =
  | "timeout"
  | "connector_error"
  | "malformed_json"
  | "schema_invalid"
  | "low_confidence"
  | "empty_query";

// ─── Cross-cutting classification metadata (query-routing redesign, Milestone 1) ──
// Orthogonal to QueryType: e.g. a "high_stakes" question can be
// factual_lookup, medical_health, or claim_verification alike. Populated for
// EVERY classification, including the 9 pre-existing types — this is metadata
// added around them, not a change to their own behavior.

export type RiskLevel = "casual" | "professional" | "high_stakes" | "safety_critical";
export type EvidenceRequirement = "low" | "medium" | "high" | "regulated";
export type FreshnessRequirement = "timeless" | "date_sensitive" | "recent" | "live";
export type ClassificationInputType =
  | "text"
  | "url"
  | "document"
  | "documents"
  | "image"
  | "video"
  | "audio"
  | "dataset"
  | "mixed";
export type VerificationMethod =
  | "cross_model_consistency"
  | "claim_stance_agreement"
  | "semantic_item_overlap"
  | "rank_correlation"
  | "source_support"
  | "numerical_consistency"
  | "document_alignment"
  | "visual_signal_comparison"
  | "human_review"
  | "none";
/** Which dedicated, non-adaptive-registry feature a handoff classification should point the user at. */
export type HandoffTarget = "claim_verification" | "video_verification";

export interface QueryClassification {
  queryType: QueryType;
  domain: string;
  /**
   * Self-reported by the classifier for logging/rationale only. RENDERING
   * authority is the registry's `schema.renderHint`, reached via
   * routeClassifiedQuery() — never this field directly. Kept so the debug
   * panel can show what the model itself thought the shape should be,
   * even when the router overrides it (e.g. any non-"active" queryType).
   */
  answerShape: AnswerShape;
  quantExpected: boolean;
  timeSensitivity: "low" | "medium" | "high";
  userIntent:
    | "understand_debate"
    | "get_answer"
    | "make_decision"
    | "learn_process"
    | "generate_content";
  confidence: number;
  /**
   * Set ONLY when this classification is the defensive "generic" fallback,
   * not a genuine model classification (which may itself legitimately be
   * "generic"). Lets the debug panel distinguish "generic (classifier
   * timeout)" — a silent failure — from "generic (classified)" — the
   * classifier ran fine and generic was the right call.
   */
  fallbackReason?: QueryClassificationFallbackReason;

  // ── Cross-cutting metadata (Milestone 1) ──
  riskLevel: RiskLevel;
  evidenceRequirement: EvidenceRequirement;
  freshness: FreshnessRequirement;
  inputType: ClassificationInputType;
  verificationMethod: VerificationMethod;
  /** Extracted from phrasing like "top 20"/"list 50". Null when no count was requested. */
  requestedCount?: number | null;
  requiresClarification: boolean;
  /** One focused question, populated only when requiresClarification is true. */
  clarificationQuestion?: string | null;
  /** One-sentence explanation of why this classification was chosen — surfaced in the dev debug panel, not to end users. */
  rationale: string;
  /** Populated only when queryType is "claim_verification" or "media_authenticity_review". */
  handoffTarget?: HandoffTarget;
}

// ─── Atomic comparable units ───────────────────────────────────────────────

export type ClaimStance = "asserts" | "disputes" | "uncertain";
export type ClaimConfidence = "settled" | "majority_view" | "contested" | "speculative";
export type ClaimEvidenceType = "empirical" | "theoretical" | "anecdotal" | "authoritative";

export interface Claim {
  /** Short kebab-case slug generated by the model, e.g. "demand-pull-driver". */
  id: string;
  /** One sentence, max 25 words. */
  claim: string;
  stance: ClaimStance;
  confidence: ClaimConfidence;
  evidenceType: ClaimEvidenceType;
  /** For contested claims: the competing positions. */
  camps?: { label: string; position: string }[];
}

export interface Metric {
  label: string;
  value: number | null;
  unit: string;
  /** ISO date or "unknown". */
  asOf: string;
  source: string;
}

export interface Step {
  order: number;
  /** Max 20 words. */
  action: string;
  prerequisite?: string;
  failureMode?: string;
}

/** One model's own entry in a ranked list — the atomic unit for ranked_enumeration (Milestone 2). Deliberately NOT a Claim: its identity is rank/category, not stance/evidenceType. */
export interface EnumItem {
  /** Short kebab-case slug from the item's label, e.g. "chatgpt" — same convention as Claim.id, used for cross-model clustering. */
  id: string;
  label: string;
  category?: string;
  /** 1-indexed — 1 is the top of this model's own list. */
  rank: number;
  rationale?: string;
  /** Plain source labels this model cited for the item, if any — not required. */
  sources?: string[];
}

/**
 * One item after merging paraphrases/near-duplicates across every model's
 * own EnumItem[] list — the ranked_enumeration equivalent of AlignedClaim.
 * Client-safe (rendered directly by RankedListView.tsx).
 */
export interface AggregatedEnumItem {
  id: string;
  label: string;
  category?: string;
  /** Mean rank across the models that included this item — lower is better. */
  panelRank: number;
  /** Distinct models whose own list included a near-duplicate of this item. */
  coverageCount: number;
  totalModels: number;
  /** coverageCount / totalModels. */
  coverageRatio: number;
  /** This item's rank as given by each model that included it. */
  sourceRanks: Record<ModelId, number>;
  /** Population variance of sourceRanks' values — undefined when covered by fewer than 2 models (variance is undefined for a single point). */
  rankVariance?: number;
  /** One representative rationale from whichever contributing model provided one, if any. */
  rationale?: string;
  sources?: string[];
}

/** Full ranked_enumeration result — a standalone answer shape, not funneled through AlignedClaim/gate/synthesisReport (its atomic unit and scoring math are both fundamentally different from a claim). */
export interface RankedEnumerationResult {
  /** Sorted by coverageRatio descending, then panelRank ascending. Items covered by only 1-2 models are excluded here — see lowConfidenceItems. */
  items: AggregatedEnumItem[];
  /** Items covered by only 1-2 models — rendered in a separate, collapsed, lower-confidence section rather than mixed into the main list. */
  lowConfidenceItems: AggregatedEnumItem[];
  requestedCount: number | null;
  /** items.length + lowConfidenceItems.length. */
  actualCount: number;
  /** Set only when requestedCount is non-null and actualCount falls short of it — states the shortfall plainly rather than padding the list. */
  shortfallNote?: string;
  /** Mean pairwise Spearman rank correlation across every pair of models that shared at least 2 commonly-covered items; null when fewer than 2 models produced usable items or no pair shared enough overlap to compute it. */
  rankCorrelation: number | null;
  /** Always false today — no live query-log/search-frequency data source exists in this codebase (confirmed by infrastructure audit). Drives the mandatory honesty banner in RankedListView. */
  hasLiveQueryLogData: false;
  /** Models actually attempted for this run — added in the Milestone 2 UI consistency cleanup so the renderer can distinguish "no models ran at all" from "models ran but found no items" (same distinction bias_blindspot_audit/decision_support already had). */
  totalModels: number;
}

// ─── comparison_matrix atomic units (Milestone 2) ──────────────────────────
// A comparison's answer unit is a (subject, attribute) cell, not a claim or
// a ranked item — two independent axes a model fills in from the question
// itself (no framework-supplied subject/attribute list). See
// comparisonAlignment.ts's header comment for why cross-model clustering
// runs on the two axes independently rather than through AlignedClaim.

export interface ComparisonCell {
  /** Name of the thing being compared, e.g. "iPhone 15 Pro" — reuse the EXACT same string across every cell about this subject within your own response. */
  subject: string;
  /** The dimension being compared, e.g. "Battery life" — reuse the EXACT same string across every cell about this attribute within your own response. */
  attribute: string;
  /** This subject's value/assessment on this attribute — one short phrase, not a full sentence. */
  value: string;
  /** This subject's relative standing on this attribute, only when there's a genuine winner/loser — omit when purely descriptive or not meaningfully comparable. */
  verdict?: "better" | "worse" | "even";
  rationale?: string;
  sources?: string[];
}

export interface AggregatedComparisonSubject {
  id: string;
  label: string;
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
}

export interface AggregatedComparisonAttribute {
  id: string;
  label: string;
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
}

export interface AggregatedComparisonCell {
  subjectId: string;
  subject: string;
  attributeId: string;
  attribute: string;
  /** Each contributing model's own value text for this subject×attribute. */
  valuesByModel: Record<ModelId, string>;
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
  /**
   * Cross-model agreement on VALUE for this cell. Deliberately reuses
   * AlignedClaimStatus's vocabulary (declared below) — unlike
   * ranked_enumeration's rank correlation, "do models agree on this data
   * point" here means exactly the same thing it means for a claim row, so a
   * separate vocabulary would only obscure that.
   */
  agreement: AlignedClaimStatus;
  /** Representative value when agreement is "consensus" or "majority" — the modal/longest phrasing among the agreeing models. Undefined for "split" (picking one would misrepresent a genuine disagreement) or "single_source" (valuesByModel's lone entry already is the value). */
  consensusValue?: string;
  /** Tally of verdict calls across contributing models, only for models that supplied one. */
  verdictTally?: Partial<Record<"better" | "worse" | "even", number>>;
  rationale?: string;
  sources?: string[];
}

/** Full comparison_matrix result — a standalone answer shape with its own two-axis aggregation, not funneled through AlignedClaim/gate/synthesisReport/trustSummary (see ranked_enumeration's RankedEnumerationResult for the same architectural pattern). */
export interface ComparisonMatrixResult {
  /** Sorted by coverage descending, then first-seen order. Subjects covered by only 1-2 models (panel > 2 models only) move to lowConfidenceSubjects instead — see comparisonAlignment.ts. */
  subjects: AggregatedComparisonSubject[];
  lowConfidenceSubjects: AggregatedComparisonSubject[];
  attributes: AggregatedComparisonAttribute[];
  lowConfidenceAttributes: AggregatedComparisonAttribute[];
  /** One entry per subject×attribute combination at least one model populated — never padded with fabricated "no data" filler for combinations nobody covered. */
  cells: AggregatedComparisonCell[];
  /** Always false today — no live verified pricing/spec/data source exists in this codebase (confirmed by infrastructure audit); cell values are the panel's own generated assessments. Drives the mandatory honesty banner in ComparisonMatrixView. */
  hasVerifiedSourceData: false;
  /** Models actually attempted for this run — added in the Milestone 2 UI consistency cleanup so the renderer can distinguish "no models ran at all" from "models ran but found nothing comparable" (same distinction bias_blindspot_audit/decision_support already had). */
  totalModels: number;
  /** The panel's answer-first takeaway from the comparison, before the grid — modal/longest phrasing across models that supplied one. Empty string if no model did. */
  directConclusion: string;
  /** Cross-cutting trade-offs that don't reduce to a single cell (e.g. "cheaper options tend to have weaker support"), merged/deduped across models. */
  tradeoffs: string[];
  /** Which subject to pick under which circumstance (e.g. "Perplexity — best when citations matter more than depth"), merged/deduped across models. */
  bestUseRecommendations: string[];
  /** Genuinely missing information that limits confidence in this comparison, merged/deduped across models. */
  uncertainties: string[];
}

// ─── definition_explanation atomic units (Milestone 2) ─────────────────────
// A definition's per-model output is a rich, heterogeneous object (unlike
// ranked_enumeration/comparison_matrix's single repeated array field) — see
// schemaRegistry.ts's comparisonMatrixFields-equivalent field list. `analogy`
// is modeled as two flat top-level string fields (analogyText/analogyLimits)
// at the per-model prompt/validation layer — every other FieldType is
// array-of-primitives or a plain string, and introducing a bespoke
// non-array nested-object FieldType would require touching
// buildResponseZodSchema/salvageFields' "string vs array" branching more
// invasively than this schema needs. The two flat fields are recomposed
// into the nested `analogy?: {text, limits}` shape recommended by the
// product spec at the AGGREGATION layer (below), where it belongs to the
// merged result, not the per-model wire contract.

export interface DefinitionDistinction {
  concept: string;
  explanation: string;
}

export interface DefinitionProcessStep {
  number: number;
  title: string;
  explanation: string;
}

/** One merged, cross-model interpretation of the term/concept — definition_explanation's equivalent of AggregatedEnumItem/AggregatedComparisonCell. Client-safe (rendered directly by DefinitionExplanationView.tsx). */
export interface AggregatedDefinitionInterpretation {
  /** Distinct models whose directAnswer clustered together as materially the same interpretation. */
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
  contributingModels: ModelId[];
  term: string;
  directAnswer: string;
  explanation: string;
  keyPoints: string[];
  example?: string;
  analogy?: { text: string; limits?: string };
  distinctions: DefinitionDistinction[];
  processSteps: DefinitionProcessStep[];
  advancedDetail?: string;
  commonMisconceptions: string[];
  relatedConcepts: string[];
  sources: string[];
}

/**
 * Full definition_explanation result — a standalone answer shape with its
 * own interpretation-clustering aggregation, not funneled through
 * AlignedClaim/gate/synthesisReport/trustSummary. Deliberately does NOT
 * assign a single agreement/certainty score across interpretations — per
 * the product requirement, subjective wording differences must never be
 * scored as if they were claim disagreement, and genuinely different
 * interpretations (isAmbiguous) are presented side by side rather than
 * forced into one merged "consensus" answer.
 */
export interface DefinitionExplanationResult {
  /** The most cross-model-supported interpretation. Null only when every model failed to produce usable output. */
  primary: AggregatedDefinitionInterpretation | null;
  /** Other, materially different interpretations the panel produced — never silently discarded in favor of `primary`. Empty when the panel converged on one interpretation. */
  alternateInterpretations: AggregatedDefinitionInterpretation[];
  /** True whenever alternateInterpretations is non-empty. Does not attempt to distinguish "legitimate domain-specific difference" from "one model got it wrong" — that judgment call is beyond what text-similarity clustering can honestly claim, so every multi-interpretation outcome is surfaced neutrally rather than one being silently favored. */
  isAmbiguous: boolean;
  /** True when at least one model contributing to `primary` cited a source — lets the renderer/tests distinguish a source-backed technical definition from general-knowledge phrasing. */
  sourceBacked: boolean;
  /** Models actually attempted for this run — added in the Milestone 2 UI consistency cleanup so the renderer can distinguish "no models ran at all" from "models ran but produced no usable definition" (same distinction bias_blindspot_audit/decision_support already had). */
  totalModels: number;
}

// ─── causal_explanation atomic units (Milestone 2) ──────────────────────────
// Wire-layer fields are deliberately flat strings/string[] (see
// schemaRegistry.ts's causalExplanationFields) — no per-factor structured
// evidence tagging exists at the wire layer, so causalAlignment.ts derives
// `evidenceStrength`/`sourceBacked` conservatively rather than trusting a
// model-asserted structured value that was never actually collected. The
// central design risk this schema exists to avoid: model repetition is
// panel CONVERGENCE, never proof a cause is real — coverageCount/
// coverageRatio are reported as exactly that (how many models agree),
// deliberately never rolled into a single "certainty" or "truth" score.

export type CausalEvidenceStrength = "strong" | "moderate" | "weak" | "contested" | "unknown";

export type CausalFactorCategory =
  | "direct_cause"
  | "contributing_factor"
  | "trigger"
  | "amplifier"
  /** No current wire field populates this category (the recommended per-model schema has no protectiveFactors field) — kept in the vocabulary for schema completeness/future use, same pattern as bias_blindspot_audit's unexposed machinery. Never fabricated. */
  | "protective_factor"
  | "alternative_explanation";

export interface AggregatedCausalFactor {
  id: string;
  label: string;
  category: CausalFactorCategory;
  /** Distinct models that raised a near-duplicate of this factor within this SAME category — factors are clustered per-category, never merged across categories (a "direct cause" and a "contributing factor" naming the same thing stay in their own buckets; see causalAlignment.ts). */
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
  contributingModels: ModelId[];
  /**
   * Deliberately conservative — "contested" only when this same factor is
   * categorized differently by different models (some call it a direct
   * cause, others an alternative explanation — a real, structurally
   * detected disagreement); "unknown" otherwise. Does NOT cross-check
   * against disputedInterpretations (full sentences) — comparing a short
   * factor phrase against long prose via the shared overlap-coefficient
   * matcher produces false positives whenever a few common words coincide,
   * regardless of topical relevance (see causalAlignment.ts). Never
   * "strong"/"moderate"/"weak" from coverage alone — that would be exactly
   * the model-repetition-as-proof conflation this schema exists to avoid.
   */
  evidenceStrength: CausalEvidenceStrength;
  /** True when at least one model that raised this factor ALSO cited a source somewhere in its own response — an approximation (the wire layer has no per-factor source attribution), not a claim that the citation specifically supports this exact factor. */
  sourceBacked: boolean;
}

/** One merged causal mechanism sentence (cause → effect, explained) — definition_explanation-style clustering, not a graph/node structure. */
export interface AggregatedCausalLink {
  id: string;
  mechanism: string;
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
  contributingModels: ModelId[];
}

/** One preserved, materially distinct causal interpretation where genuine disagreement exists — never dropped for having low coverage (a minority explanation is exactly what this type exists to keep visible). */
export interface AggregatedCausalInterpretation {
  label: string;
  supportingModels: ModelId[];
}

/**
 * Full causal_explanation result — a standalone answer shape with its own
 * per-category aggregation, not funneled through AlignedClaim/gate/
 * synthesisReport/trustSummary. No overall certainty/confidence score is
 * computed anywhere in this type — see the module-level design-risk note
 * above.
 */
export interface CausalExplanationResult {
  directAnswer: string;
  /** direct_cause/contributing_factor/trigger/amplifier/alternative_explanation entries, each tagged with its own category — never blurred together. */
  factors: AggregatedCausalFactor[];
  causalChain: AggregatedCausalLink[];
  confounders: string[];
  disputedInterpretations: AggregatedCausalInterpretation[];
  unknowns: string[];
  testsOrEvidenceNeeded: string[];
  /** True when at least one contributing model cited a source anywhere in its response — response-level, not attributed to any specific factor (see AggregatedCausalFactor.sourceBacked for the per-factor approximation). */
  sourceBacked: boolean;
  /** Phase 10D.1 — response-level union of every contributing model's own `sources` field, exact-string deduplicated, first-seen order. Plain labels AND URLs both survive here; URL-only filtering for display happens at the decision-receipt/UI boundary, never here. */
  sources: string[];
  /** Models actually attempted for this run — the honest denominator behind every coverageRatio above, reported once here rather than repeated per-factor/link. */
  totalModels: number;
}

// ─── checklist_taxonomy atomic units (Milestone 2) ──────────────────────────
// Unifies two related request shapes — a plain checklist (order-independent
// items to consider/verify/gather) and a categorized taxonomy (types of X,
// grouped) — behind one structure: items with an OPTIONAL category. When no
// model provides a meaningful category, every item lands in a single
// "General" sentinel group (a pure checklist); when models DO categorize,
// the same structure renders as a grouped taxonomy. Deliberately has no
// `rank` field (unlike EnumItem) — order does not matter here, which is
// exactly what distinguishes this schema from ranked_enumeration.

export type ChecklistItemSeverity = "low" | "medium" | "high" | "critical";
export type ChecklistItemLikelihood = "low" | "medium" | "high";

/**
 * Risk-register fields, all optional — checklist_taxonomy covers both plain
 * checklists ("what to check before launching a SaaS product") and
 * risk-shaped taxonomies ("what are the main risks of X"). Rather than a
 * separate schema/category (query-routing redesign policy: no new schema
 * per answer shape without a real capability gap), a risk-shaped question
 * still classifies as checklist_taxonomy — these fields let the model
 * additionally populate a real risk register when the items genuinely ARE
 * risks, and RiskAnalysisView.tsx renders that register when enough items
 * carry them (see checklistAlignment.ts's isRiskShapedResult). Left unset
 * entirely for an ordinary checklist.
 */
export interface ChecklistItemRiskFields {
  /** How severe this risk would be if it materialized. */
  severity?: ChecklistItemSeverity;
  /** How likely this risk is to materialize. */
  likelihood?: ChecklistItemLikelihood;
  /** The concrete consequence if this risk materializes — one short sentence, not a restatement of the label. */
  impact?: string;
  /** What in the panel's own knowledge supports treating this as a real risk, if anything. */
  evidence?: string;
  /** A concrete step that would reduce this risk's likelihood or impact. */
  mitigation?: string;
  /** An observable signal worth tracking that this risk is materializing. */
  monitoringSignal?: string;
  /** The risk that remains after the mitigation above is applied — never omit just because mitigation looks complete; state "low" residual risk explicitly rather than implying zero. */
  residualRisk?: string;
}

export interface ChecklistItem extends ChecklistItemRiskFields {
  /** Short kebab-case slug from the item's label, e.g. "data-processing-agreement" — same convention as EnumItem.id, used for cross-model clustering. */
  id: string;
  label: string;
  /** Groups this item under a named category (e.g. "Legal", "Technical") — omit/leave "none" for a flat checklist with no meaningful categories. For a risk-shaped taxonomy, this is the risk category. */
  category?: string;
  rationale?: string;
  /** True for a must-have/blocking item, false or omitted for a nice-to-have/situational one. */
  critical?: boolean;
}

/** One merged, cross-model checklist/taxonomy item. Client-safe (rendered directly by ChecklistTaxonomyView.tsx/RiskAnalysisView.tsx). */
export interface AggregatedChecklistItem extends ChecklistItemRiskFields {
  id: string;
  label: string;
  /** "General" sentinel when the panel provided no meaningful category for this item. */
  category: string;
  rationale?: string;
  /** True when at least half of the models that raised this item flagged it critical — a majority read of the panel's OWN judgment calls, not inferred from how many models mentioned the item at all (coverage and criticality are tracked and reported completely separately). */
  critical: boolean;
  /** Distinct models whose own list included a near-duplicate of this item. */
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
  contributingModels: ModelId[];
}

export interface ChecklistCategoryGroup {
  /** "General" when the panel provided no meaningful category — the whole result then renders as a flat checklist instead of a taxonomy with visible category headings. */
  category: string;
  items: AggregatedChecklistItem[];
}

/** Full checklist_taxonomy result — a standalone answer shape, not funneled through AlignedClaim/gate/synthesisReport/trustSummary (same architectural pattern as the other Milestone 2 parallel-path schemas). */
export interface ChecklistTaxonomyResult {
  summary: string;
  /** Main items grouped by category, sorted by each category's first-seen order; items within a category sorted by coverage descending. A single "General" group means the panel effectively produced a flat checklist, not a taxonomy. */
  categories: ChecklistCategoryGroup[];
  /** Items covered by only 1-2 models — held back from the main categorized list into a separate, collapsed section, rather than mixed in as if equally well-supported. Only applies when the panel has more than 2 models — see checklistAlignment.ts. */
  lowConfidenceItems: AggregatedChecklistItem[];
  notes: string[];
  totalModels: number;
}

/** Below this share of items carrying at least one risk field, the result renders as an ordinary checklist rather than a risk register — a couple of stray risk-flavored items in an otherwise plain checklist shouldn't flip the whole presentation. */
const RISK_SHAPE_MIN_RATIO = 0.5;

/**
 * True when this checklist_taxonomy result is actually a risk register in
 * disguise — determined from the DATA the panel actually produced (did
 * models populate severity/likelihood/mitigation/etc.), never from the
 * question's own wording, since the schema/prompt already steers the model
 * to leave every risk field unset for an ordinary checklist. Pure/
 * client-safe (no "server-only") — used by AdaptivePanelResponse.tsx (a
 * client component) to pick RiskAnalysisView over ChecklistTaxonomyView
 * without adding a new queryType/schema, and could equally be called
 * server-side (e.g. for analytics) without an import-boundary issue.
 */
export function isRiskShapedChecklistResult(result: ChecklistTaxonomyResult): boolean {
  const items = [...result.categories.flatMap((c) => c.items), ...result.lowConfidenceItems];
  if (items.length === 0) return false;
  const riskyCount = items.filter(
    (item) => item.severity !== undefined || item.likelihood !== undefined || !!item.mitigation || !!item.residualRisk
  ).length;
  return riskyCount / items.length >= RISK_SHAPE_MIN_RATIO;
}

// ─── deep_research atomic units (Milestone 2) ───────────────────────────────
// Broad research synthesis's atomic unit is a FINDING (a whole claim +
// summary + evidence characterization together), clustered similarly to
// definition_explanation's interpretations, plus a separate disagreements
// axis (clustered like causal_explanation's disputedInterpretations) and
// reused Bias & Blind Spots Tier 2 (coverageAudit.ts's auditPanelCoverage)
// for panel-level omissions — see deepResearchAlignment.ts's header comment
// for why this is a parallel path, not the claim-matrix pipeline, despite
// being the closest sibling to contested_empirical/generic.

export interface ResearchFinding {
  /** Short kebab-case slug from the finding's core concept, e.g. "remote-work-productivity-decline" — same convention as Claim.id, used for cross-model clustering. */
  id: string;
  title: string;
  summary: string;
  /** Which research dimension this finding belongs to (e.g. "Labor economics", "Methodology") — omit for an undifferentiated finding. */
  category?: string;
  /** Reuses causal_explanation's evidence-strength vocabulary — the same honest, conservative semantics apply: never inferred from how many models raised the finding, only from a genuine independent signal. */
  evidenceStrength?: CausalEvidenceStrength;
  sources?: string[];
}

/** One merged, cross-model research finding. Client-safe (rendered directly by DeepResearchView.tsx). */
export interface AggregatedResearchFinding {
  id: string;
  title: string;
  summary: string;
  category: string;
  /** Deliberately conservative, same rule as AggregatedCausalFactor.evidenceStrength — "unknown" unless a genuine independent signal exists (this finding is also flagged in disagreements). Never "strong"/"moderate"/"weak" purely from model repetition. */
  evidenceStrength: CausalEvidenceStrength;
  sourceBacked: boolean;
  /** Phase 10D.1 — union of `sources` from every model contributing to this specific finding, exact-string deduplicated, first-seen order. Plain labels AND URLs both survive here; URL-only filtering for display happens at the decision-receipt/UI boundary, never here. */
  sources: string[];
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
  contributingModels: ModelId[];
}

/** One preserved, materially distinct research disagreement — never dropped for low coverage, same as AggregatedCausalInterpretation. */
export interface AggregatedResearchDisagreement {
  label: string;
  supportingModels: ModelId[];
}

export interface ResearchSourceCoverage {
  findingsWithSources: number;
  totalFindings: number;
  /** 0 when totalFindings is 0 — never divides by zero. */
  coverageRatio: number;
}

/**
 * Full deep_research result — a standalone answer shape with its own
 * finding-clustering aggregation, not funneled through AlignedClaim/gate/
 * synthesisReport/trustSummary (this schema has its OWN narrative synthesis
 * concept — executiveSummary — computed deterministically from findings,
 * never by the shared synthesisReport.ts narrative-generation call). No
 * overall certainty/confidence score is computed anywhere in this type,
 * same design discipline as CausalExplanationResult.
 */
export interface DeepResearchResult {
  executiveSummary: string;
  /** Sorted by coverage descending, then first-seen order. Findings covered by only 1-2 models (panel > 2 models only) move to lowConfidenceFindings instead — same rule as every other Milestone 2 schema's low-confidence bucket. */
  findings: AggregatedResearchFinding[];
  lowConfidenceFindings: AggregatedResearchFinding[];
  disagreements: AggregatedResearchDisagreement[];
  evidenceGaps: string[];
  openQuestions: string[];
  /** Tier 2 of the existing Bias & Blind Spots system (coverageAudit.ts's auditPanelCoverage) — reused as-is, not reimplemented. Empty when the call fails/times out/finds nothing, per that function's own contract; never invented. */
  panelBlindSpots: AdaptiveCoverageGap[];
  researchBoundaries: string[];
  recommendedNextSteps: string[];
  sourceCoverage: ResearchSourceCoverage;
  totalModels: number;
}

// ─── evidence_review atomic units (Milestone 2) ─────────────────────────────
// Evaluates HOW STRONG/CREDIBLE/RELIABLE a body of evidence, a study, a
// source, or a methodology is — a meta-evaluation of evidence quality
// itself, distinct from deep_research (which synthesizes substantive
// findings across a topic) and from causal_explanation (which explains WHY
// something happens). The atomic unit is a quality DIMENSION (methodology,
// sample size, conflicts of interest, replication, source credibility,
// generalizability, etc.), each with its own model-asserted strength —
// see evidenceReviewAlignment.ts for why the aggregated overall strength is
// derived from these per-dimension model judgments, never from how many
// models simply participated.

export interface EvidenceDimension {
  /** Short kebab-case slug from the dimension's label, e.g. "sample-size" — same convention as Claim.id, used for cross-model clustering. */
  id: string;
  dimension: string;
  assessment: string;
  /** The model's own honest read of this specific dimension. Reuses causal_explanation's vocabulary — the same conservative semantics apply. */
  strength?: CausalEvidenceStrength;
}

/** One merged, cross-model evidence-quality dimension. Client-safe (rendered directly by EvidenceReviewView.tsx). */
export interface AggregatedEvidenceDimension {
  id: string;
  dimension: string;
  assessment: string;
  /** Mode of contributing models' own self-reported strength for this dimension — "contested" when models' own judgments genuinely conflict (e.g. some say "strong", others "weak"), "unknown" when no model reported one. Never inferred from coverage count. */
  strength: CausalEvidenceStrength;
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
  contributingModels: ModelId[];
}

/**
 * Full evidence_review result — a standalone answer shape with its own
 * dimension-clustering aggregation, not funneled through AlignedClaim/gate/
 * synthesisReport/trustSummary. `overallStrength` is derived from the
 * aggregated dimensions' OWN model-asserted strengths (majority/contested
 * among dimensions that have a real signal) — a genuine roll-up of actual
 * judgments, never a count-based certainty score.
 */
export interface EvidenceReviewResult {
  overallAssessment: string;
  overallStrength: CausalEvidenceStrength;
  /** Sorted by coverage descending, then first-seen order. Dimensions covered by only 1-2 models (panel > 2 models only) move to lowConfidenceDimensions instead — same rule as every other Milestone 2 schema's low-confidence bucket. */
  dimensions: AggregatedEvidenceDimension[];
  lowConfidenceDimensions: AggregatedEvidenceDimension[];
  redFlags: string[];
  strengths: string[];
  applicabilityCaveats: string[];
  recommendedChecks: string[];
  /** True when at least one contributing model cited a source anywhere in its response. Response-level, matching causal_explanation's/definition_explanation's approximation (the wire layer has no per-dimension source attribution). */
  sourceBacked: boolean;
  /** Phase 10D.1 — response-level union of every contributing model's own `sources` field, exact-string deduplicated, first-seen order. Plain labels AND URLs both survive here; URL-only filtering for display happens at the decision-receipt/UI boundary, never here. */
  sources: string[];
  totalModels: number;
}

// ─── bias_blindspot_audit atomic units (Milestone 2) ────────────────────────
// Exposes the SAME three-tier Bias & Blind Spots system already embedded in
// every synthesis report (biasDetection.ts/coverageAudit.ts/diagnostics.ts)
// through a dedicated, standalone query type — not a reimplementation. Tier
// 1 reuses `AdaptiveBiasFinding`/`BiasEmptyReason` verbatim (the existing
// `detectAdaptiveBiases` call is schema-agnostic and already takes raw
// `ModelResult[]`, so no adaptation was needed at all). Tier 2 reuses
// `auditPanelCoverage` (generalized for deep_research) plus the panel's own
// self-reported gaps. Tier 3 is a new, schema-specific set of deterministic
// diagnostics — see biasBlindspotAlignment.ts's header comment for why it
// isn't literally `AdaptiveDiagnostics` (that type is built from
// `AlignedClaim[]`'s agreementScore/evidenceType, which this parallel path
// never produces).

/** One merged, cross-model panel-level gap — Tier 2. Richer than the embedded system's `AdaptiveCoverageGap` (adds `coverageReason` to say WHERE this gap signal came from), so it's its own type rather than a reuse. */
export interface AggregatedPanelBlindSpot {
  id: string;
  missingDimension: string;
  /** Populated for gaps identified by the reused auditPanelCoverage call; left undefined for gaps drawn only from the panel's own self-reported omittedDimensions (which don't come with a model-generated rationale). */
  whyItMatters?: string;
  followUpQuestion?: string;
  /** e.g. "identified by independent coverage audit" or "raised by 2 of 4 models" — always says WHERE this gap signal came from, never left implicit. */
  coverageReason: string;
}

export interface BiasSourceConcentration {
  distinctSources: number;
  totalCitations: number;
  /** citations for the single most-cited source / totalCitations — 1.0 means every citation points to the same source. */
  concentrationRatio: number;
}

/**
 * Tier 3 — deterministic, no model call. Keeps source-diversity concerns
 * separate from geographic-bias concerns (two different axes, explicitly
 * never blurred together) and computes homogeneity by clustering models'
 * own summaries for near-duplication — the only signal available here,
 * since this schema never produces AlignedClaim.agreementScore. Reuses the
 * SAME `HOMOGENEITY_AGREEMENT_THRESHOLD` constant the embedded system uses,
 * even though the underlying computation necessarily differs.
 */
export interface BiasStructuralDiagnostics {
  citationCoverage: { modelsWithSources: number; totalModels: number; ratio: number };
  /** Undefined when no model cited any source at all — nothing to compute concentration over. */
  sourceConcentration?: BiasSourceConcentration;
  geographicBiasConcerns: string[];
  sourceConcentrationConcerns: string[];
  evidenceTypeConcerns: string[];
  homogeneityFlag: boolean;
  /** Always the same fixed message when homogeneityFlag is true — an explanatory caveat, not a judgment. */
  homogeneityMessage?: string;
}

/**
 * Full bias_blindspot_audit result — a standalone answer shape, not funneled
 * through AlignedClaim/gate/synthesisReport/trustSummary. The central
 * safeguard: an EMPTY Tier 1 is never treated as "no bias exists" — it's
 * reported as "no model-specific bias was confidently attributable," and
 * Tier 2/Tier 3 still render independently. Model agreement is never
 * converted into proof of neutrality anywhere in this type.
 */
export interface BiasBlindspotAuditResult {
  summary: string;
  /** Tier 1 — reused `AdaptiveBiasFinding[]` verbatim from the embedded system's `detectAdaptiveBiases`. Empty is a normal, honest outcome, not an error. */
  attributedBiases: AdaptiveBiasFinding[];
  /** Null only when attributedBiases is non-empty — otherwise says WHY Tier 1 came back empty (reused `BiasEmptyReason` vocabulary). */
  biasEmptyReason: BiasEmptyReason | null;
  /** Tier 2. */
  panelBlindSpots: AggregatedPanelBlindSpot[];
  sharedAssumptions: string[];
  missingStakeholders: string[];
  /** Tier 3. */
  structuralDiagnostics: BiasStructuralDiagnostics;
  followUpQuestions: string[];
  /** Phase 10D.1 — response-level union of every contributing model's own `sources` field, exact-string deduplicated, first-seen order. Plain labels AND URLs both survive here; URL-only filtering for display happens at the decision-receipt/UI boundary, never here. */
  sources: string[];
  totalModels: number;
}

// ─── decision_support atomic units (Milestone 2) ────────────────────────────
// Helps the user CHOOSE among concrete options under uncertainty — not a
// substitute for comparison_matrix (compares without necessarily
// recommending), ranked_enumeration (an open-ended ranked list),
// causal_explanation (explains why something happened), or procedural
// (explains how to carry out an ALREADY-CHOSEN action). The central design
// risk here is the same discipline used throughout Milestone 2, restated for
// a recommendation instead of a claim: model POPULARITY for one action must
// never become the recommendation by itself — see decisionSupportAlignment.ts
// for how `recommendation` is actually derived (only ever a genuine, uniform
// signal across contributing models; any real split falls back to a
// conservative action plus a plainly-stated explanation of the disagreement).
//
// Deliberately deviates from the originally recommended DecisionCriterion/
// DecisionAssessment shape in two ways, both documented here rather than
// silently: no numeric `weight` on criteria and no numeric `score` on
// assessments — either would imply a false precision this system's honesty
// discipline avoids everywhere else (see CausalEvidenceStrength's qualitative
// vocabulary, reused here for the same reason).

export type DecisionRecommendationAction =
  | "go"
  | "conditional_go"
  | "defer"
  | "no_go"
  | "escalate"
  | "monitor"
  | "choose_option";

export interface DecisionAssessment {
  /** Short kebab-case slug, e.g. "hubspot-cost". */
  id: string;
  /** Must reuse the EXACT same string as one of this model's own `options` entries. */
  optionLabel: string;
  /** Must reuse the EXACT same string as one of this model's own `criteria` entries. */
  criterionLabel: string;
  assessment: string;
  /** Reuses causal_explanation's evidence-strength vocabulary — the model's own honest read of how well-supported THIS specific assessment is. */
  evidenceStrength?: CausalEvidenceStrength;
}

export interface DecisionRisk {
  id: string;
  label: string;
  likelihood?: "low" | "medium" | "high" | "unknown";
  impact?: "low" | "medium" | "high" | "unknown";
  mitigation?: string;
  /** Set only when this risk is specific to one option — must match an `options` entry; omit when it applies broadly across options. */
  optionLabel?: string;
}

export interface AggregatedDecisionOption {
  id: string;
  label: string;
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
  contributingModels: ModelId[];
}

export interface AggregatedDecisionCriterion {
  id: string;
  label: string;
  /** "user" if ANY contributing model flagged this criterion as coming from the user's own question/constraints; "model" otherwise. A simplified two-way read of the recommended type's three-way user/inferred/model provenance — a wire-layer self-report can't reliably distinguish "inferred from context" from "purely model-generated". */
  source: "user" | "model";
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
  contributingModels: ModelId[];
}

export interface AggregatedDecisionAssessment {
  optionId: string;
  criterionId: string;
  /** Merged assessment text across models that assessed this exact option×criterion cell. */
  assessment: string;
  /** Mode of contributing models' own strength reads for this cell — "contested" when they genuinely conflict, "unknown" when none reported one. Never inferred from coverage. */
  evidenceStrength: CausalEvidenceStrength;
  coverageCount: number;
  totalModels: number;
  contributingModels: ModelId[];
}

export interface AggregatedDecisionRisk {
  id: string;
  label: string;
  /** Set only when this risk clustered to one specific canonical option — undefined means it applies broadly. */
  optionId?: string;
  /** "unknown" when contributing models' own reads genuinely disagree, matching the same conservative merge rule used everywhere else in this schema. */
  likelihood?: "low" | "medium" | "high" | "unknown";
  impact?: "low" | "medium" | "high" | "unknown";
  mitigation?: string;
  coverageCount: number;
  totalModels: number;
  contributingModels: ModelId[];
}

/**
 * The aggregated recommendation — NEVER a raw vote count. `isContested` is
 * true only when contributing models' own recommended actions genuinely
 * disagree (or, for "choose_option", agree on the action but pick different
 * options) — a real, structurally detected split, not "some models were
 * silent". `supportCount`/`totalModelsWithRecommendation` report plain
 * convergence for transparency, exactly like every other coverageCount in
 * this system — never converted into a certainty/confidence score.
 */
export interface DecisionRecommendation {
  action: DecisionRecommendationAction;
  /** Populated only when action is "choose_option" and contributing models agree on which option — see isContested. */
  recommendedOptionId?: string;
  rationale: string;
  caveats: string[];
  isContested: boolean;
  supportCount: number;
  totalModelsWithRecommendation: number;
}

/**
 * Full decision_support result — a standalone answer shape, not funneled
 * through AlignedClaim/gate/synthesisReport/trustSummary. `humanReviewNeeded`
 * is computed here (not left to the renderer) from riskLevel, contested
 * status, and evidence strength on the recommended option's own assessments —
 * see decisionSupportAlignment.ts's header comment.
 */
export interface DecisionSupportResult {
  decisionQuestion: string;
  options: AggregatedDecisionOption[];
  criteria: AggregatedDecisionCriterion[];
  /** One entry per option×criterion combination at least one model assessed — never padded with fabricated "no data" filler for combinations nobody covered (same rule as ComparisonMatrixResult.cells). */
  assessments: AggregatedDecisionAssessment[];
  recommendation: DecisionRecommendation;
  assumptions: string[];
  uncertainties: string[];
  risks: AggregatedDecisionRisk[];
  sensitivityFindings: string[];
  reversibleNextStep?: string;
  humanReviewNeeded: boolean;
  sourceBacked: boolean;
  /** Phase 10D.1 — response-level union of every contributing model's own `sources` field, exact-string deduplicated, first-seen order. Plain labels AND URLs both survive here; URL-only filtering for display happens at the decision-receipt/UI boundary, never here. */
  sources: string[];
  totalModels: number;
}

export interface Scenario {
  label: string;
  /** 0–1, must sum ≈ 1 across scenarios in a single response. */
  probability: number;
  /** Max 60 words. */
  narrative: string;
  /** Falsifiable signals, max 3. */
  leadingIndicators: string[];
}

// ─── Field / schema definitions ────────────────────────────────────────────

export type FieldType =
  | "string"
  | "string[]"
  | "claim[]"
  | "metric[]"
  | "step[]"
  | "scenario[]"
  // Query-routing redesign, Milestone 2.
  | "enumItem[]"
  | "comparisonCell[]"
  | "distinction[]"
  | "processStep[]"
  | "checklistItem[]"
  | "researchFinding[]"
  | "evidenceDimension[]"
  | "decisionAssessment[]"
  | "decisionRisk[]";

export interface FieldSpec {
  key: string;
  type: FieldType;
  /** Hard cap, enforced in prompt AND validated post-hoc. */
  maxWords?: number;
  maxItems?: number;
  /** Minimum items, when the schema requires a range (e.g. scenarios 2-4). */
  minItems?: number;
  /** Injected into the model prompt verbatim. */
  description: string;
  /** Restricts which values are valid for this claim-like field (schema-specific confidence vocab). */
  allowedConfidenceValues?: ClaimConfidence[];
}

/**
 * Whether a registry entry is safe to execute (query-routing redesign,
 * Milestone 1's routing guarantee). routeClassifiedQuery() is the ONLY
 * place this is read to make a routing decision — a schema whose
 * prompt/parser/verification/renderer isn't fully built must never be
 * reachable by a live classification; it must resolve to
 * graceful_limitation instead of GenericSectionsView, the legacy research
 * renderer, or any schema-specific renderer.
 */
export type SchemaImplementationStatus = "active" | "disabled" | "handoff";

export interface ResultSchema {
  id: QueryType;
  /** What the list view collapses to. */
  headlineField: string;
  renderHint: AnswerShape;
  fields: FieldSpec[];
  /** See SchemaImplementationStatus. Every entry must declare this explicitly — no implicit default. */
  implementationStatus: SchemaImplementationStatus;
  /** Required when implementationStatus === "disabled" — the honest reason shown in LimitationNotice. */
  capabilityReason?: string;
  /** Required when implementationStatus === "handoff" — which dedicated feature to point the user at. */
  handoffTarget?: HandoffTarget;
  /**
   * Where to route if this schema's own validation/parsing fails at
   * runtime. Declared per the approved architecture so every entry is
   * self-describing; NOT yet wired into new runtime fallback logic in
   * Milestone 1 — active schemas keep their existing classifier-level
   * fallback (classifier.ts's genericFallback) unchanged.
   */
  fallbackQueryType: QueryType;
}

// ─── Per-model adaptive result ─────────────────────────────────────────────

/**
 * Successfully parsed + validated adaptive payload for one model.
 * Keys mirror the schema's fields; values are typed per FieldSpec.type.
 */
export type AdaptiveFieldValue =
  | string
  | string[]
  | Claim[]
  | Metric[]
  | Step[]
  | Scenario[]
  | EnumItem[]
  | ComparisonCell[]
  | DefinitionDistinction[]
  | DefinitionProcessStep[]
  | ChecklistItem[]
  | ResearchFinding[]
  | EvidenceDimension[]
  | DecisionAssessment[]
  | DecisionRisk[];

/** Enum fields recoverable via coercion before validation (see enumCoercion.ts). */
export type CoercibleEnumField = "stance" | "confidence" | "evidenceType";

/** One enum value normalized (case/synonym drift) before validation — e.g. Gemini's "agrees" -> "asserts". Logged so drift stays visible in the debug panel. */
export interface AdaptiveEnumCoercion {
  modelId: ModelId;
  schemaId: QueryType;
  field: CoercibleEnumField;
  /** e.g. "disputedClaims[2].stance" */
  path: string;
  raw: string;
  coerced: string;
}

export interface AdaptiveModelResult {
  modelId: ModelId;
  schemaId: QueryType;
  /**
   * True when at least some schema-declared data could be recovered —
   * either a clean full parse, or a field-level salvage that kept the valid
   * fields/items and dropped only the invalid ones (see validator.ts).
   * False only when nothing at all survived coercion + salvage (+ one retry).
   */
  ok: boolean;
  data: Record<string, AdaptiveFieldValue> | null;
  /** Populated when ok === false — render as a failed cell, never crash the comparison. */
  parseError?: string;
  /** Field keys that were soft-truncated (word/item cap exceeded). */
  truncatedFields?: string[];
  /** Field keys the schema declares that are absent from `data` because no valid value survived coercion + salvage (+ retry). */
  invalidFields?: string[];
  /** Enum coercions applied before validation, across every claim[]-shaped field. Empty/absent when the raw response already used exact enum vocabulary. */
  coercions?: AdaptiveEnumCoercion[];
  /** True when this result reflects the one-shot retry call (original response failed validation, model was re-prompted with the errors). */
  retried?: boolean;
  /** Wall-clock time for this model's connector call, carried from the panel run (ModelResult.latencyMs) — List View's response-time column/sort reads this directly, no new timing added. */
  latencyMs?: number;
}

// ─── Claim alignment (Phase 4b) ────────────────────────────────────────────

/**
 * A cell's stance RELATIVE TO the cluster's canonical proposition — distinct
 * from Claim.stance (ClaimStance), which is the model's own raw assertion
 * polarity independent of any cluster. Two claims with opposite ClaimStance
 * values about the same proposition are exactly the case this type exists to
 * represent in one row: e.g. "cap-and-trade achieves similar reductions"
 * (rawStance: asserts) and "carbon taxes often outperform ETS" (rawStance:
 * asserts) resolve to relative stances "agrees" / "disputes" against a
 * neutral canonicalText like "relative effectiveness of carbon pricing
 * mechanisms".
 */
export type ClaimCellStance = "agrees" | "disputes" | "partial" | "unclear";

export interface AlignedClaimCell {
  modelId: ModelId;
  /** Stance relative to the cluster's canonicalText — drives agreement scoring and matrix coloring. */
  stance: ClaimCellStance;
  /** The model's own original assertion polarity, kept for audit/debugging. */
  rawStance: ClaimStance;
  confidence: ClaimConfidence;
  /** Carried through from the source Claim when present — lets consensus_map expand disputed rows. */
  camps?: { label: string; position: string }[];
  /** The model's own wording (verbatim claim text, or a short paraphrase from the backfill pass) — feeds "Show Positions". */
  excerpt: string;
  /** Only set for claim[]-derived cells — feeds medical_health's evidence-tier-weighted scoring. */
  evidenceType?: ClaimEvidenceType;
  /**
   * True when this cell came from the stance-extraction backfill pass (the
   * model never emitted a claim that clustered here directly, but a
   * dedicated check found it does take a position) rather than from the
   * model's own clustered claim. Backfilled cells default to
   * confidence "majority_view" since it's an inferred position, not the
   * model's stated one.
   */
  backfilled?: boolean;
  /**
   * The structured source value for rows built by a non-claim unitizer
   * (fieldAlignment.ts: metrics/steps/scenarios) — lets schema-specific
   * AgreementComparators (agreementComparators.ts) do numeric/order math
   * without re-parsing `excerpt` text. Absent for claim[]-derived rows.
   */
  raw?: Metric | Step | Scenario;
}

export type AlignedClaimStatus = "consensus" | "majority" | "split" | "single_source";

export interface AlignedClaim {
  /** Canonical id — derived from the cluster's canonicalText, or a generated cluster id. */
  id: string;
  /** Canonical, neutral proposition text for the cluster (not biased toward any one model's phrasing). */
  claimText: string;
  /** One entry per model in the run; null = model truly never took a position on this proposition. */
  cells: Array<AlignedClaimCell | null>;
  /** 0–1, schema-adaptive agreement score — computed by the AgreementComparator (see agreementComparators.ts), not by alignment itself. Defaults to 0 until scored. */
  agreementScore: number;
  /** 0–1, see scoring.ts. Defaults to 0 until scored. */
  certaintyScore: number;
  /** Defaults to "single_source" until scored; recomputed from agreementScore + coverage. */
  status: AlignedClaimStatus;
  /**
   * Schema-specific disagreement classification beyond the generic status
   * enum — e.g. legal_regulatory's "jurisdiction_mismatch", which is a hard
   * key violation and must never be averaged into agreementScore like an
   * ordinary split.
   */
  disagreementType?: string;
}

// ─── Verification gate + synthesis report (R1d/R1e) ────────────────────────
// Declared here (not in gate.ts/synthesisReport.ts, which are "server-only")
// so client components (components/adaptive/*) can import these shapes
// without risking a server-only module ending up in a client bundle.

export type AdaptiveGateStatus = "pass" | "caution" | "fail";

export interface AdaptiveGateResult {
  status: AdaptiveGateStatus;
  runCertainty: number;
  loadBearingSplitCount: number;
  loadBearingClaims: AlignedClaim[];
}

/** Decision-impact tier — mirrors lib/verificationGate/claimSeverity.ts's ClaimSeverity vocabulary. */
export type AdaptiveStakes = "low" | "important" | "decision-critical";

export interface AdaptiveDisagreementPosition {
  modelId: ModelId;
  /** The model's own excerpt for this claim (AlignedClaimCell.excerpt) — a real quote, never model-invented text. */
  position: string;
}

export interface AdaptiveDisagreement {
  /** The disputed claim's canonical text. */
  topic: string;
  /** One-sentence explanation of WHY models diverge — model-generated from the excerpts, validated against the model roster. */
  whyTheyDiffer: string;
  positions: AdaptiveDisagreementPosition[];
  /** Model-assigned: would this claim change a decision the asker is likely making? */
  stakes: AdaptiveStakes;
}

export interface AdaptiveBiasEvidence {
  modelId: ModelId;
  /** Direct quote from the model's own response, max BIAS_EVIDENCE_EXCERPT_MAX_CHARS chars. */
  excerpt: string;
  rationale: string;
}

export interface AdaptiveBiasFinding {
  biasType: string;
  description: string;
  modelsImplicated: ModelId[];
  evidence: AdaptiveBiasEvidence[];
  likelyCauses: string[];
  impact: string;
  mitigationSteps: string[];
}

/**
 * Why Bias & Blind Spots Tier 1 (detectAdaptiveBiases) came back empty —
 * distinguishes a genuine null result ("below_threshold": the call ran fine
 * and found nothing confidently attributable) from every flavor of "the call
 * never really happened" so the dev debug panel can show which one occurred
 * instead of an indistinguishable empty array (Synthesis Report Polish,
 * Part B/Bias-Blind-Spots-Tiers).
 */
export type BiasEmptyReason = "insufficient_models" | "call_failed" | "invalid_response" | "below_threshold";

/** Tier 2 (panel coverage audit): one dimension a domain expert would expect covered that no model addressed. Never invented — the model call is instructed to only name genuinely expected gaps. */
export interface AdaptiveCoverageGap {
  dimension: string;
  whyItMatters: string;
  followUpQuestion: string;
}

/** Per-evidence-type claim counts, keyed by the full ClaimEvidenceType vocabulary (types.ts) — not just the three named in the product spec, so no data is silently dropped. */
export interface AdaptiveEvidenceMix {
  empirical: number;
  theoretical: number;
  anecdotal: number;
  authoritative: number;
}

/** Tier 3: deterministic diagnostics computed directly from already-scored AlignedClaim rows — no model call, so always available whenever the run produced at least one claim. */
export interface AdaptiveDiagnostics {
  citedClaimCount: number;
  totalClaimCount: number;
  evidenceMix: AdaptiveEvidenceMix;
  /** True when mean agreementScore across ALL rows (including single-source, which score 0) exceeds HOMOGENEITY_AGREEMENT_THRESHOLD — a deliberately strict bar so the flag only fires when the panel converged everywhere, not just on its most-agreed claims. */
  homogeneityFlag: boolean;
  meanAgreement: number;
}

export interface AdaptiveVerdictCard {
  question: string;
  topConsensus: string;
  consensusModelCount: number;
  keyDisagreement: string | null;
  disagreementDetail: string | null;
  disagreementModelCount: number;
  /** Top bias/blind spot description, one sentence; null if none were confidently attributable. */
  caveat: string | null;
  /** Gate-dependent guidance, max 3 — see VERDICT_NEXT_STEPS in config.ts. */
  recommendedNextSteps: string[];
}

export interface AdaptiveSynthesisReport {
  unifiedAnswer: string;
  panelVerdict: string;
  gate: AdaptiveGateStatus;
  runCertainty: number;
  whereModelsAgree: string[];
  /** Flat topic list, kept for the debug panel/backward-compat — the UI renders `disagreements` (richer) instead. */
  whereModelsDisagree: string[];
  certaintyAssessment: string;
  narrativeSections: { title: string; body: string }[];
  /** Restored narrative layer (Synthesis Report Polish pass). */
  executiveSummary: string;
  disagreements: AdaptiveDisagreement[];
  /** Capped at MAX_BIAS_FINDINGS; empty when none were confidently attributable. */
  biasAndBlindSpots: AdaptiveBiasFinding[];
  /** Null whenever biasAndBlindSpots is non-empty; otherwise why Tier 1 came back empty (see BiasEmptyReason). */
  biasEmptyReason: BiasEmptyReason | null;
  /** Tier 2: dimensions the panel didn't cover — see AdaptiveCoverageGap. */
  panelCoverageGaps: AdaptiveCoverageGap[];
  /** Tier 3: deterministic diagnostics — see AdaptiveDiagnostics. */
  diagnostics: AdaptiveDiagnostics;
  verdictCard: AdaptiveVerdictCard;
  degraded: boolean;
}

// ─── Trust Summary (R1c) ────────────────────────────────────────────────
// Declared here for the same reason as the gate/synthesis-report shapes
// above: client components (components/adaptive/*) render this directly.

export interface ModelTrustSummary {
  modelId: ModelId;
  /** Count of claim[]/metric[]/step[]/scenario[] items this model raised in its own response. */
  claimsContributed: number;
  /** 0–1: fraction of comparable rows where this model's stance matched the row's majority stance. 1 when the model had no comparable rows. */
  majorityAlignment: number;
  /** 0–1: fraction of sourceable fields (Metric.source, factual_lookup's `source`) with a real, non-generic source. 1 when the schema has no sourceable field. */
  citationScore: number;
  /** Count of rows where this model disputed a row that the panel otherwise resolved as "split". */
  contradictionCount: number;
  parseHealth: "ok" | "degraded" | "failed";
  /**
   * 0–1 composite: citation/consistency/contradiction weighted per
   * TRUST_WEIGHTS_BY_SCHEMA, then capped per parseHealth
   * (TRUST_SCORE_CAP_BY_HEALTH in config.ts — 0 when "failed", 75% ceiling
   * when "degraded"). This is the post-cap, display value.
   */
  trustScore: number;
  /** True when the health cap actually lowered the raw weighted score — drives the UI tooltip explaining why the score can't read higher. */
  capped: boolean;
}

export interface AdaptiveTrustSummary {
  perModel: ModelTrustSummary[];
  /** Mean trustScore across models with parseHealth !== "failed"; 0 if every model failed to parse. */
  overallTrust: number;
}

// ─── Common response envelope (query-routing redesign, Milestone 1) ────────
// Every new-taxonomy schema's response carries this alongside its own
// payload shape — shared metadata governance/renderers/debug tooling can
// read without knowing the specific schema. Not yet wired into the 9
// pre-existing schemas' actual persisted output (that's additive follow-up
// work, not a Milestone 1 requirement); the type exists now so
// routeClassifiedQuery()/LimitationNotice have a real shape to build.

export interface AdaptiveSourceCoverage {
  supportedUnits: number;
  totalUnits: number;
  ratio: number;
}

export interface CommonResponseMeta {
  schemaVersion: number;
  queryType: QueryType;
  answerShape: AnswerShape;
  dataBasis: "live_data" | "provided_sources" | "training_prior" | "mixed" | "calculated" | "user_provided";
  freshness: FreshnessRequirement;
  riskLevel: RiskLevel;
  evidenceQuality: "strong" | "moderate" | "weak" | "unknown" | "not_applicable";
  consensusSummary?: string;
  disagreementSummary?: string;
  uncertainties: string[];
  blindSpots: string[];
  humanReviewNeeded: boolean;
  recommendedNextAction?: string;
  generatedAt: string;

  // ── Query-Routing Redesign, Phase 1 — additive execution-metadata fields.
  // Populated by buildCommonResponseMeta() for the 9 active Milestone 2
  // dedicated schemas only; left undefined for non-execution responses
  // (buildCommonMeta() in commonMeta.ts, unchanged) since none of these
  // concepts (models attempted, source coverage of real answer units,
  // execution status) apply to a run that never invoked a model. Kept on
  // this SAME interface rather than a parallel type so there is exactly one
  // CommonResponseMeta shape in the codebase — just with a subset of fields
  // meaningful depending on which builder produced it.
  /** Reuses AdaptivePanelResult's own field name (not a new "schemaId" alias) so this and orchestrate.ts stay in the same vocabulary — see queryType above for the classification-level equivalent. */
  schemaId?: QueryType;
  /** Always "active" when present — a non-execution response never gets this field at all rather than carrying a misleading routingKind. */
  routingKind?: "active";
  totalModels?: number;
  successfulModels?: number;
  failedModels?: number;
  /** Passed connector-level success AND adaptive schema validation — a connector "success" containing malformed JSON does not count here. */
  modelsWithUsableOutput?: number;
  sourceBacked?: boolean;
  /** Unit-level source coverage using each schema's own real answer units (ranked items, comparison cells, findings, etc.) — omitted, not zero-filled, when the schema has no reliable unit-level signal. */
  sourceCoverage?: AdaptiveSourceCoverage;
  /** Concrete, deduplicated, schema-specific statements about this RESULT's own completeness/provenance (e.g. "2 of 5 models did not produce usable output") — deliberately distinct from `uncertainties`/`blindSpots` above, which carry the SCHEMA'S OWN content (e.g. decision_support's self-reported uncertainties), not meta-level completeness signals. */
  limitations?: string[];
  executionStatus?: "completed" | "partial" | "failed";
}

/** Distinguishes WHY a limitation is being shown — LimitationNotice uses this to select copy/tone, never a single generic "can't help" message. */
export type LimitationReasonKind = "capability_gap" | "handoff" | "genuine_limitation" | "unrecognized_or_invalid";

export interface GracefulLimitationResponse {
  kind: LimitationReasonKind;
  limitation: string;
  whyItMatters?: string;
  nearestValidAlternative?: string;
  recommendedSources?: string[];
  clarifyingQuestion?: string;
  /** Populated only when kind === "handoff". */
  handoffTarget?: HandoffTarget;
  meta: CommonResponseMeta;
}
