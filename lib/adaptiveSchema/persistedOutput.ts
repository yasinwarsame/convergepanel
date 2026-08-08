/**
 * Query-Routing Redesign, Phase 1 — the versioned, persisted adaptive
 * output envelope. See docs/adaptive-persistence-design.md for the full
 * design (storage location decision, size assessment, backward-compat
 * strategy) — this file is the contract + runtime validator that design
 * settled on.
 *
 * Deliberately NOT built on Zod, unlike validator.ts's per-model response
 * validation: the 9 result types here are already large, complex,
 * hand-authored TypeScript interfaces (each with its own nested aggregated
 * types) produced exactly once, by this codebase's own alignment functions.
 * Re-deriving 9 full Zod schemas from them would be pure duplicated
 * maintenance burden for a goal this module states plainly — "sufficient to
 * prevent renderer crashes" on CORRUPTED or PARTIAL persisted data, not a
 * second independent proof of every nested field's shape (that proof
 * already happened once, at generation time, inside finalizeAdaptiveRun()).
 * A lightweight structural check (right top-level keys, right JS types) is
 * proportionate; a full schema re-derivation is not. This is still real
 * runtime validation, not unchecked casting — every field this module reads
 * off Firestore data is checked before the value is trusted.
 */

import {
  AdaptiveGateResult,
  AdaptiveModelResult,
  AdaptiveSynthesisReport,
  AdaptiveTrustSummary,
  AlignedClaim,
  AnswerShape,
  BiasBlindspotAuditResult,
  CausalExplanationResult,
  ChecklistTaxonomyResult,
  ComparisonMatrixResult,
  CommonResponseMeta,
  DecisionSupportResult,
  DeepResearchResult,
  DefinitionExplanationResult,
  EvidenceReviewResult,
  QueryClassification,
  RankedEnumerationResult,
} from "./types";

/** Persisted classification is already 100% semantic data (queryType, domain, riskLevel, etc.) — nothing UI-state to strip, so this is a plain alias, not a narrower type. */
export type PersistedQueryClassification = QueryClassification;

interface PersistedAdaptiveOutputBase {
  version: 1;
  classification: PersistedQueryClassification;
  meta: CommonResponseMeta;
  generatedAt: string;
}

/**
 * Discriminated union keyed by `schemaId` — one variant per Milestone 2
 * dedicated schema. Deliberately does NOT cover the 10 legacy-active
 * schemas (contested_empirical, factual_lookup, procedural, etc.) — those
 * continue to rely on the existing runDocument/legacy-synthesis persistence
 * path, unchanged, per the design doc's explicit scope note.
 */
export type PersistedAdaptiveOutputV1 =
  | (PersistedAdaptiveOutputBase & { schemaId: "ranked_enumeration"; answerShape: "ranked_list"; result: RankedEnumerationResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "comparison_matrix"; answerShape: "comparison_grid"; result: ComparisonMatrixResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "definition_explanation"; answerShape: "definition_card"; result: DefinitionExplanationResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "causal_explanation"; answerShape: "causal_map"; result: CausalExplanationResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "checklist_taxonomy"; answerShape: "checklist_taxonomy_view"; result: ChecklistTaxonomyResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "deep_research"; answerShape: "deep_research_view"; result: DeepResearchResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "evidence_review"; answerShape: "evidence_review_view"; result: EvidenceReviewResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "bias_blindspot_audit"; answerShape: "bias_blindspot_audit_view"; result: BiasBlindspotAuditResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "decision_support"; answerShape: "decision_support_view"; result: DecisionSupportResult });

export type PersistedAdaptiveOutput = PersistedAdaptiveOutputV1;

export type PersistedAdaptiveSchemaId = PersistedAdaptiveOutputV1["schemaId"];

/** Verified directly against SCHEMA_REGISTRY's renderHint for each of the 9 dedicated schemas — not invented. */
export const SCHEMA_ANSWER_SHAPE: Record<PersistedAdaptiveSchemaId, AnswerShape> = {
  ranked_enumeration: "ranked_list",
  comparison_matrix: "comparison_grid",
  definition_explanation: "definition_card",
  causal_explanation: "causal_map",
  checklist_taxonomy: "checklist_taxonomy_view",
  deep_research: "deep_research_view",
  evidence_review: "evidence_review_view",
  bias_blindspot_audit: "bias_blindspot_audit_view",
  decision_support: "decision_support_view",
};

const SUPPORTED_SCHEMA_IDS = new Set<string>(Object.keys(SCHEMA_ANSWER_SHAPE));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * One structural check per schema — verifies the specific top-level fields
 * each renderer actually destructures exist with the right JS type. Not a
 * deep/exhaustive check of every nested field (see module doc for why).
 */
const RESULT_SHAPE_CHECKS: Record<PersistedAdaptiveSchemaId, (result: unknown) => boolean> = {
  ranked_enumeration: (r) =>
    isPlainObject(r) && Array.isArray(r.items) && Array.isArray(r.lowConfidenceItems) && typeof r.totalModels === "number",
  comparison_matrix: (r) =>
    isPlainObject(r) && Array.isArray(r.subjects) && Array.isArray(r.attributes) && Array.isArray(r.cells) && typeof r.totalModels === "number",
  definition_explanation: (r) =>
    isPlainObject(r) && "primary" in r && Array.isArray(r.alternateInterpretations) && typeof r.totalModels === "number",
  causal_explanation: (r) =>
    isPlainObject(r) && typeof r.directAnswer === "string" && Array.isArray(r.factors) && typeof r.totalModels === "number",
  checklist_taxonomy: (r) =>
    isPlainObject(r) && Array.isArray(r.categories) && Array.isArray(r.lowConfidenceItems) && typeof r.totalModels === "number",
  deep_research: (r) =>
    isPlainObject(r) && typeof r.executiveSummary === "string" && Array.isArray(r.findings) && typeof r.totalModels === "number",
  evidence_review: (r) =>
    isPlainObject(r) && typeof r.overallAssessment === "string" && Array.isArray(r.dimensions) && typeof r.totalModels === "number",
  bias_blindspot_audit: (r) =>
    isPlainObject(r) && typeof r.summary === "string" && Array.isArray(r.attributedBiases) && typeof r.totalModels === "number",
  decision_support: (r) =>
    isPlainObject(r) &&
    typeof r.decisionQuestion === "string" &&
    Array.isArray(r.options) &&
    isPlainObject(r.recommendation) &&
    typeof r.totalModels === "number",
};

/** Why parsing failed — distinguishes "nothing was ever persisted" (the common, expected case for pre-Phase-1 runs) from genuine corruption/version drift, so the caller can render three different, honest UI states rather than one generic failure. */
export type PersistedAdaptiveOutputFailureReason = "absent" | "unsupported_version" | "malformed";

export type ParsePersistedAdaptiveOutputResult =
  | { ok: true; output: PersistedAdaptiveOutput }
  | { ok: false; reason: PersistedAdaptiveOutputFailureReason };

/**
 * Never throws. `raw` is whatever Firestore handed back for a run
 * document's `adaptiveOutput` field — untrusted by construction (could be
 * absent, from a future schema version, or corrupted by a partial write).
 */
export function parsePersistedAdaptiveOutput(raw: unknown): ParsePersistedAdaptiveOutputResult {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "absent" };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "malformed" };
  }
  if (raw.version !== 1) {
    return { ok: false, reason: "unsupported_version" };
  }

  const schemaId = raw.schemaId;
  if (typeof schemaId !== "string" || !SUPPORTED_SCHEMA_IDS.has(schemaId)) {
    return { ok: false, reason: "malformed" };
  }
  const typedSchemaId = schemaId as PersistedAdaptiveSchemaId;

  // Rejects a mismatched schemaId/answerShape pair — e.g. a hand-edited or
  // corrupted document claiming schemaId "decision_support" with
  // answerShape "ranked_list".
  if (raw.answerShape !== SCHEMA_ANSWER_SHAPE[typedSchemaId]) {
    return { ok: false, reason: "malformed" };
  }

  if (!isPlainObject(raw.classification) || typeof raw.classification.queryType !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (!isPlainObject(raw.meta)) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof raw.generatedAt !== "string") {
    return { ok: false, reason: "malformed" };
  }

  // Rejects a mismatched schemaId/result pair — e.g. schemaId
  // "ranked_enumeration" with a `result` object that's actually shaped like
  // a DecisionSupportResult.
  if (!RESULT_SHAPE_CHECKS[typedSchemaId](raw.result)) {
    return { ok: false, reason: "malformed" };
  }

  return { ok: true, output: raw as unknown as PersistedAdaptiveOutput };
}

/**
 * Phase 2 pilot history-reload fix — a second, narrowly-scoped envelope for
 * the legacy-active schema family (the query-routing "LEGACY_FALLBACK"
 * schemas that still run the claims-matrix pipeline instead of a Milestone
 * 2 dedicated aggregator). Deliberately NOT folded into
 * `PersistedAdaptiveOutputV1` above: that union's `result` is always a
 * single finished, aggregated object (one per Milestone 2 schema); this
 * family instead needs the raw per-model `results` (so Model Responses can
 * show real per-model output, not a re-derivation) alongside the
 * claim-matrix pipeline's own
 * `alignedClaims`/`gate`/`synthesisReport`/`trustSummary` — a materially
 * different shape that would force every Milestone-2-only assumption
 * elsewhere in this file (SCHEMA_ANSWER_SHAPE, RESULT_SHAPE_CHECKS) to grow
 * a special case. A parallel type + parser is the smaller, honest fix.
 *
 * Persisted on `runs/{runId}.legacyAdaptiveOutput` — a distinct Firestore
 * field from `adaptiveOutput`, so the two envelopes never collide and
 * `parsePersistedAdaptiveOutput` above needs no changes at all.
 *
 * Batch 3 persistence foundation (2C-1) — originally scoped to `procedural`
 * only (Phase 2 pilot); widened here to the full 8-member legacy-active
 * family below, per docs/adaptive-synthesis-batch3-persistence-audit.md.
 * Every schema in this family reaches the exact same claims-matrix
 * fall-through in orchestrate.ts and produces byte-identical shape to what
 * `procedural` already persisted successfully — this is a widened
 * allowlist, not a new mechanism.
 */

/**
 * The fixed set of schemas this envelope covers. Verified directly against
 * `schemaRegistry.ts`'s `fallbackQueryType: LEGACY_FALLBACK` schemas (8
 * total, `procedural` plus these 7) — deliberately NOT "every QueryType."
 * `factual_lookup` already has its own dedicated primary-view renderer
 * (DirectAnswerCard) but persists through this exact same envelope, since
 * its structured result has the identical claims-matrix shape. The 9
 * Milestone-2 schemas, `generic`, and `graceful_limitation` are
 * intentionally excluded — widening this set to a new schema requires a
 * conscious edit here, never an accidental default.
 */
export const PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS = [
  "procedural",
  "contested_empirical",
  "legal_regulatory",
  "financial_valuation",
  "factual_lookup",
  "medical_health",
  "forecast_speculative",
  "creative_generative",
] as const;

export type PersistedLegacyAdaptiveSchemaId = (typeof PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS)[number];

const PERSISTED_LEGACY_ADAPTIVE_SCHEMA_ID_SET = new Set<string>(PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS);

/** Explicit allowlist check — never a bare `typeof === "string"` — so an arbitrary or malformed schemaId is rejected, not merely type-narrowed. */
export function isPersistedLegacyAdaptiveSchemaId(schemaId: unknown): schemaId is PersistedLegacyAdaptiveSchemaId {
  return typeof schemaId === "string" && PERSISTED_LEGACY_ADAPTIVE_SCHEMA_ID_SET.has(schemaId);
}

/**
 * `gate`/`synthesisReport` are optional — narrow type correction discovered
 * during Batch 3 persistence foundation (2C-1): `creative_generative` has
 * no `claim[]`/`metric[]`/`scenario[]`/`step[]` fields and no
 * `SCALAR_ALIGNMENT_FIELDS` entry, so `orchestrate.ts`'s shared
 * claims-matrix path returns with an empty `alignedClaims` before gate/
 * synthesis are ever computed — live rendering already handles this via
 * `AdaptivePanelResponse.tsx`'s existing `if (!gate || !synthesisReport)`
 * fallback to `AdaptiveResultsView` (which for this schema is
 * `GalleryView`, reading only raw `results`). Making these fields
 * optional here lets the envelope still carry `results` for History parity
 * on that one schema, matching what live rendering already tolerates —
 * not a new computation, no new scoring, just an honest type for data that
 * was always allowed to be absent.
 */
export interface PersistedLegacyAdaptiveOutputV1 {
  version: 1;
  schemaId: PersistedLegacyAdaptiveSchemaId;
  classification: PersistedQueryClassification;
  generatedAt: string;
  results: AdaptiveModelResult[];
  alignedClaims: AlignedClaim[];
  gate?: AdaptiveGateResult;
  synthesisReport?: AdaptiveSynthesisReport;
  trustSummary?: AdaptiveTrustSummary;
}

export type ParsePersistedLegacyAdaptiveOutputResult =
  | { ok: true; output: PersistedLegacyAdaptiveOutputV1 }
  | { ok: false; reason: PersistedAdaptiveOutputFailureReason };

/**
 * Same validation posture as `parsePersistedAdaptiveOutput` above — a
 * lightweight structural check, never a full re-derivation, never throws.
 */
export function parsePersistedLegacyAdaptiveOutput(raw: unknown): ParsePersistedLegacyAdaptiveOutputResult {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "absent" };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "malformed" };
  }
  if (raw.version !== 1) {
    return { ok: false, reason: "unsupported_version" };
  }
  if (!isPersistedLegacyAdaptiveSchemaId(raw.schemaId)) {
    return { ok: false, reason: "malformed" };
  }
  if (!isPlainObject(raw.classification) || typeof raw.classification.queryType !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (typeof raw.generatedAt !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (!Array.isArray(raw.results)) {
    return { ok: false, reason: "malformed" };
  }
  if (!Array.isArray(raw.alignedClaims)) {
    return { ok: false, reason: "malformed" };
  }
  // gate/synthesisReport are optional, but NOT independently of
  // alignedClaims — orchestrate.ts only ever produces this envelope two
  // ways: (1) alignedClaims non-empty, scored, WITH gate/synthesisReport
  // both computed in the same branch, or (2) alignedClaims empty (today,
  // always creative_generative; in principle any schema whose models
  // returned no comparable claims at all) with gate/synthesisReport never
  // computed. "Non-empty alignedClaims with no gate/synthesisReport" is a
  // combination the real orchestrator can never produce — accepting it
  // here would silently trust a corrupted or hand-edited record, so it
  // must fail closed rather than pass through as valid, regardless of
  // schemaId. This is a structural invariant, not a creative_generative
  // special case — the check is on alignedClaims.length, never on schemaId.
  const hasClaims = raw.alignedClaims.length > 0;
  if (hasClaims) {
    if (!isPlainObject(raw.gate) || typeof raw.gate.status !== "string") {
      return { ok: false, reason: "malformed" };
    }
    if (!isPlainObject(raw.synthesisReport) || typeof raw.synthesisReport.unifiedAnswer !== "string") {
      return { ok: false, reason: "malformed" };
    }
  } else if (
    (raw.gate !== undefined && (!isPlainObject(raw.gate) || typeof raw.gate.status !== "string")) ||
    (raw.synthesisReport !== undefined &&
      (!isPlainObject(raw.synthesisReport) || typeof raw.synthesisReport.unifiedAnswer !== "string"))
  ) {
    // Defensive: if a gate/synthesisReport IS present on an empty-claims
    // record, it must still be well-shaped — never silently accepted.
    return { ok: false, reason: "malformed" };
  }

  return { ok: true, output: raw as unknown as PersistedLegacyAdaptiveOutputV1 };
}
