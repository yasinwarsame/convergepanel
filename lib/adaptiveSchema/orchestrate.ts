/**
 * Adaptive Panel Orchestration
 *
 * Glue between lib/panel.ts's fan-out and the adaptive schema modules, kept
 * out of app/api/run-panel/route.ts so the route only has two call sites:
 * one before runPanel() (classify + build prompts) and one after
 * (validate + align + score + synthesize). All of it is no-ops-safe — every
 * failure mode degrades to "generic" / parseError / a template report rather
 * than throwing.
 *
 * finalizeAdaptiveRun() builds ONE merged AlignedClaim[] per run — claim[]
 * fields go through alignment.ts's claim clustering, while metric[]/step[]/
 * scenario[]/scalar fields go through fieldAlignment.ts's structural
 * unitizers (see R1a: AlignedClaim is the universal verification unit
 * regardless of which field type produced it). ADAPTIVE_VERIFICATION_ENABLED
 * gates the scoring/synthesis layer on top of that matrix — when it's off,
 * behavior is unchanged from before this restoration (raw validated results
 * + an unscored alignedClaims matrix for claim[] schemas only).
 */

import "server-only";
import { ModelId, ModelResult } from "@/lib/types";
import { ADAPTIVE_VERIFICATION_ENABLED } from "@/lib/env";
import { logger } from "@/lib/logger";
import { CONNECTOR_MAP } from "@/lib/connectors";
import type { ConnectorCallOptions } from "@/lib/connectors/types";
import { classifyQuery } from "./classifier";
import { getResultSchema, SCHEMA_REGISTRY } from "./schemaRegistry";
import { routeClassifiedQuery, RoutedQuery } from "./routeClassifiedQuery";
import { buildModelPrompt } from "./promptBuilder";
import { validateAdaptiveResponse } from "./validator";
import { withTimeout } from "./util";
import { computeAdaptiveRetryWindow, monotonicNowMs, ResearchRequestBudget } from "./retryBudget";
import { AdaptiveRetryUsageSink, mergeAdaptiveRetry, normalizeAdaptiveRetryUsage } from "./retryCorrection";
import { alignClaims, ClaimFieldOrigin, ModelClaims } from "./alignment";
import { alignMetrics, alignScenarios, alignSteps, alignScalarField, ScalarComparisonMode } from "./fieldAlignment";
import { buildRankedEnumerationResult } from "./enumAlignment";
import { buildComparisonMatrixResult } from "./comparisonAlignment";
import { buildDefinitionExplanationResult, extractDefinitionFields } from "./definitionAlignment";
import { buildCausalExplanationResult, extractCausalFields } from "./causalAlignment";
import { buildChecklistTaxonomyResult, extractChecklistFields } from "./checklistAlignment";
import { buildDeepResearchResult, extractDeepResearchFields } from "./deepResearchAlignment";
import { buildEvidenceReviewResult, extractEvidenceReviewFields } from "./evidenceReviewAlignment";
import { buildBiasBlindspotAuditResult, extractBiasBlindspotFields } from "./biasBlindspotAlignment";
import { buildDecisionSupportResult, extractDecisionSupportFields } from "./decisionSupportAlignment";
import { AdaptiveSchemaResult, buildCommonResponseMeta } from "./commonResponseMeta";
import {
  isPersistedLegacyAdaptiveSchemaId,
  PersistedAdaptiveOutputV1,
  PersistedAdaptiveSchemaId,
  PersistedLegacyAdaptiveOutputV1,
  PersistedLegacyAdaptiveSchemaId,
  SCHEMA_ANSWER_SHAPE,
} from "./persistedOutput";
import { scoreAgreement } from "./agreementComparators";
import { applyConsensusIntegrity, claimFieldClass } from "./consensusIntegrity";
import { scoreClaimCertainty, computeRunCertainty } from "./scoring";
import { computeAdaptiveGate, AdaptiveGateResult } from "./gate";
import { buildAdaptiveSynthesisReport, AdaptiveSynthesisReport } from "./synthesisReport";
import { buildAdaptiveTrustSummary } from "./trustSummary";
import {
  AdaptiveModelResult,
  AdaptiveTrustSummary,
  AlignedClaim,
  Claim,
  CausalExplanationResult,
  ChecklistTaxonomyResult,
  ComparisonCell,
  ComparisonMatrixResult,
  BiasBlindspotAuditResult,
  CommonResponseMeta,
  DecisionSupportResult,
  DeepResearchResult,
  DefinitionExplanationResult,
  EnumItem,
  EvidenceReviewResult,
  GracefulLimitationResponse,
  Metric,
  QueryClassification,
  QueryType,
  RankedEnumerationResult,
  ResultSchema,
  Scenario,
  Step,
} from "./types";

/**
 * Query-Routing Redesign, Phase 1 — builds CommonResponseMeta and the
 * versioned PersistedAdaptiveOutputV1 envelope for one of the 9 active
 * Milestone 2 dedicated schemas. Called once per schema branch below,
 * immediately before that branch returns, so the logic lives in exactly one
 * place rather than nine. Returns `{}` (no meta/envelope) when
 * `classification` is absent — finalizeAdaptiveRun's own signature keeps
 * `classification` optional for backward compatibility with existing
 * callers/tests that don't pass it; meta/persistence simply don't apply to
 * those calls, the same way they don't apply to the 10 legacy-active
 * schemas below this function (see persistedOutput.ts's module doc).
 *
 * The cast at the return is safe by construction, not unchecked casting of
 * untrusted data: every call site below passes a `schemaId` and
 * `schemaResult` that are already known, statically, to correspond (each
 * `if (schema.id === "...")` branch only ever calls this with its OWN just-built
 * result). Reading persisted data back out later goes through
 * parsePersistedAdaptiveOutput()'s real runtime validation instead — this
 * function only ever constructs, never parses, untrusted input.
 */
function attachAdaptiveEnvelope(
  schemaId: PersistedAdaptiveSchemaId,
  schema: ResultSchema,
  classification: QueryClassification | undefined,
  results: ModelResult[],
  adaptiveResults: AdaptiveModelResult[],
  schemaResult: AdaptiveSchemaResult
): { commonResponseMeta?: CommonResponseMeta; persistedOutput?: PersistedAdaptiveOutputV1 } {
  if (!classification) return {};

  const commonResponseMeta = buildCommonResponseMeta({
    schema,
    classification,
    modelResults: results,
    adaptiveResults,
    schemaResult,
  });

  const persistedOutput = {
    version: 1,
    schemaId,
    answerShape: SCHEMA_ANSWER_SHAPE[schemaId],
    classification,
    meta: commonResponseMeta,
    result: schemaResult,
    generatedAt: commonResponseMeta.generatedAt,
  } as unknown as PersistedAdaptiveOutputV1;

  return { commonResponseMeta, persistedOutput };
}

/**
 * Phase 2 pilot history-reload fix — the sibling of `attachAdaptiveEnvelope`
 * above for the legacy-active schema family. Not merged into that function:
 * it takes the claim-matrix pipeline's own outputs
 * (`alignedClaims`/`gate`/`synthesisReport`/`trustSummary`) rather than a
 * single aggregated Milestone-2 `schemaResult`, and returns
 * `PersistedLegacyAdaptiveOutputV1` — a distinct type, see
 * persistedOutput.ts for why. Same `!classification` guard as
 * `attachAdaptiveEnvelope` (persistence only ever applies to a real,
 * classified run).
 *
 * Batch 3 persistence foundation (2C-1) — originally hardcoded to
 * `schemaId: "procedural"` (Phase 2 pilot); `schemaId` is now the caller's
 * own `schema.id`, already narrowed to `PersistedLegacyAdaptiveSchemaId` at
 * both call sites below. No recomputation — this packages exactly the
 * already-computed claims-matrix result for persistence, same as before.
 *
 * `gate`/`synthesisReport`/`trustSummary` are optional parameters: the
 * empty-`alignedClaims` call site below (creative_generative's actual live
 * behavior — see persistedOutput.ts's interface doc) never computes them at
 * all, and passes `undefined` through rather than fabricating placeholder
 * values.
 */
function attachLegacyAdaptiveEnvelope(
  schemaId: PersistedLegacyAdaptiveSchemaId,
  classification: QueryClassification | undefined,
  adaptiveResults: AdaptiveModelResult[],
  alignedClaims: AlignedClaim[],
  gate?: AdaptiveGateResult,
  synthesisReport?: AdaptiveSynthesisReport,
  trustSummary?: AdaptiveTrustSummary
): { persistedLegacyOutput?: PersistedLegacyAdaptiveOutputV1 } {
  if (!classification) return {};

  const persistedLegacyOutput: PersistedLegacyAdaptiveOutputV1 = {
    version: 1,
    schemaId,
    classification,
    generatedAt: new Date().toISOString(),
    results: adaptiveResults,
    alignedClaims,
    gate,
    synthesisReport,
    trustSummary,
  };

  return { persistedLegacyOutput };
}

/** Everything finalizeAdaptiveRun needs to re-call a single model's connector once, with an augmented prompt, after its first response failed validation. Omit to disable retry (e.g. in tests that only exercise the salvage path). */
export interface AdaptiveRetryContext {
  apiKeys: Partial<Record<ModelId, string | undefined>>;
  /** Same map planAdaptiveRun() produced — the original per-model system prompt to append error feedback to. */
  promptOverrides: Partial<Record<ModelId, string>>;
  context: string | null;
  /** The request's execution budget, captured at the start of the research POST handler (retryBudget.ts). */
  budget: ResearchRequestBudget;
  /** Receives each issued retry call's provider-reported usage, once per slot; frozen by the caller before accounting. */
  usageSink: AdaptiveRetryUsageSink;
  /** Monotonic clock override for tests; defaults to performance.now(). */
  now?: () => number;
}

function describeValidationFailure(result: AdaptiveModelResult): string {
  if (result.parseError) return result.parseError;
  if (result.invalidFields && result.invalidFields.length > 0) {
    return `Missing or invalid fields: ${result.invalidFields.join(", ")}`;
  }
  return "Response failed schema validation.";
}

/**
 * One-shot retry: a model whose first response left required fields invalid
 * (even after coercion + salvage) gets re-prompted once with the original
 * system prompt plus the validation errors and an instruction to return only
 * the corrected JSON. Never loops, and never throws — every failure (budget
 * skip, guard timeout, connector error, still-invalid fields, or an
 * unexpected exception) resolves to the first attempt plus a retryOutcome,
 * so one slot can never reject the Promise.all over its siblings.
 */
async function retryModelOnce(
  schema: ResultSchema,
  question: string,
  firstAttempt: AdaptiveModelResult,
  retryContext: AdaptiveRetryContext,
  slotIndex: number
): Promise<AdaptiveModelResult> {
  const modelId = firstAttempt.modelId;
  let callIssued = false;
  try {
    const connector = CONNECTOR_MAP[modelId];
    const basePrompt = retryContext.promptOverrides[modelId];
    if (!connector || !basePrompt) return firstAttempt;

    const now = retryContext.now ?? monotonicNowMs;
    const window = retryContext.budget
      ? computeAdaptiveRetryWindow({ modelId, budget: retryContext.budget, nowMonoMs: now() })
      : null;
    if (!window || window.kind === "skip") {
      logger.warn("[adaptiveSchema] Retry skipped: remaining request budget below the minimum retry window", {
        modelId,
        schemaId: schema.id,
        availableMs: window ? Math.round(window.availableMs) : null,
        minimumMs: window ? window.minimumMs : null,
        budgetPresent: !!retryContext.budget,
      });
      return { ...firstAttempt, retryOutcome: "skipped_budget" };
    }

    const retryPrompt = `${basePrompt}\n\nYour previous response failed validation with these errors:\n${describeValidationFailure(
      firstAttempt
    )}\n\nCorrect these fields and return ONLY the fixed JSON object — no commentary, no markdown fences.`;

    const opts: ConnectorCallOptions = { systemPromptOverride: retryPrompt };

    let retryModelResult: ModelResult;
    const startedAt = now();
    callIssued = true;
    try {
      // Only the race winner is ever read: a call that loses to the guard
      // keeps running at the provider, but nothing here observes its result.
      const callPromise = connector(question, retryContext.context, retryContext.apiKeys[modelId], opts);
      retryModelResult = await withTimeout(callPromise, window.guardMs, "adaptive retry guard timeout");
    } catch (err: any) {
      // Guard timeout or a thrown connector: the provider may still finish
      // and bill, but this process never sees its usage — recorded as
      // unavailable, never estimated. A late resolution is ignored entirely.
      retryContext.usageSink.record(slotIndex, modelId, null);
      logger.warn("[adaptiveSchema] Retry call failed or hit the guard, keeping first attempt", {
        modelId,
        schemaId: schema.id,
        guardMs: Math.round(window.guardMs),
        retryLatencyMs: Math.round(now() - startedAt),
        error: err?.message,
      });
      return { ...firstAttempt, retryOutcome: "failed_call" };
    }

    const usage = normalizeAdaptiveRetryUsage(modelId, retryModelResult);
    retryContext.usageSink.record(slotIndex, modelId, usage);

    if (retryModelResult.status !== "ok") {
      logger.warn("[adaptiveSchema] Retry call returned a non-ok status, keeping first attempt", {
        modelId,
        schemaId: schema.id,
        status: retryModelResult.status,
        usageReported: usage !== null,
      });
      return { ...firstAttempt, retryOutcome: "failed_call" };
    }

    const revalidated = validateAdaptiveResponse(modelId, schema, retryModelResult.rawText);
    const { result, outcome } = mergeAdaptiveRetry(firstAttempt, revalidated);
    logger.warn("[adaptiveSchema] Retried model after validation failure", {
      modelId,
      schemaId: schema.id,
      firstAttemptInvalidFields: firstAttempt.invalidFields,
      retryOk: revalidated.ok,
      retryInvalidFields: revalidated.invalidFields,
      retryOutcome: outcome,
      retryLatencyMs: Math.round(now() - startedAt),
      usageReported: usage !== null,
    });
    return result;
  } catch (err: any) {
    logger.error("[adaptiveSchema] Retry path threw unexpectedly, keeping first attempt", {
      modelId,
      schemaId: schema.id,
      callIssued,
      error: err?.message,
    });
    if (!callIssued) return firstAttempt;
    // The provider call was issued, so it counts as a call even though its
    // usage is unknowable here (no-op if this slot already recorded).
    retryContext.usageSink.record(slotIndex, modelId, null);
    return { ...firstAttempt, retryOutcome: "failed_call" };
  }
}

export interface AdaptivePromptPlan {
  classification: QueryClassification;
  schema: ResultSchema;
  promptOverrides: Partial<Record<ModelId, string>>;
  /**
   * Query-routing redesign, Milestone 1.5: the routing decision computed
   * from `classification`, once, right here — the single source of truth
   * for whether this run should ever reach the model panel. The caller
   * (app/api/run-panel/route.ts) MUST check `routing.kind !== "active"` and
   * return a non-execution response BEFORE calling runPanel() — see
   * routeClassifiedQuery.ts's module doc for why this must never be
   * re-derived or duplicated anywhere else.
   */
  routing: RoutedQuery;
}

/**
 * Pre-fan-out step: classify the query once, route it, then — ONLY when
 * the route is "active" — build the schema-scoped system prompt every
 * selected model will answer (all models answer the same schema so their
 * responses are comparable). For any other routing outcome (handoff,
 * disabled, clarification, unanswerable, invalid), no prompt is built at
 * all: `promptOverrides` is empty and `schema` is graceful_limitation's
 * registry entry, since there is nothing for a model to answer — the
 * caller must not proceed to runPanel() in that case.
 */
export async function planAdaptiveRun(
  question: string,
  selectedModels: ModelId[],
  context: string | null
): Promise<AdaptivePromptPlan> {
  const classification = await classifyQuery(question);
  const routing = routeClassifiedQuery(classification);

  if (routing.kind !== "active") {
    return { classification, schema: SCHEMA_REGISTRY.graceful_limitation, promptOverrides: {}, routing };
  }

  const schema = routing.schema;
  const prompt = buildModelPrompt(question, classification, schema, context);

  const promptOverrides: Partial<Record<ModelId, string>> = {};
  for (const modelId of selectedModels) {
    promptOverrides[modelId] = prompt;
  }

  return { classification, schema, promptOverrides, routing };
}

export interface AdaptivePanelResult {
  schemaId: ResultSchema["id"];
  adaptiveResults: AdaptiveModelResult[];
  /** Present when the schema has at least one claim[]/metric[]/step[]/scenario[]/aligned-scalar field. */
  alignedClaims?: AlignedClaim[];
  /** Present only when ADAPTIVE_VERIFICATION_ENABLED and alignedClaims is non-empty. */
  gate?: AdaptiveGateResult;
  /** Present only when ADAPTIVE_VERIFICATION_ENABLED and alignedClaims is non-empty. */
  synthesisReport?: AdaptiveSynthesisReport;
  /** Present only when ADAPTIVE_VERIFICATION_ENABLED and alignedClaims is non-empty. */
  trustSummary?: AdaptiveTrustSummary;
  /**
   * Present only for schema.id === "ranked_enumeration" (Milestone 2) — a
   * parallel result shape, never mixed with alignedClaims/gate/
   * synthesisReport/trustSummary. See enumAlignment.ts's header comment for
   * why a ranked list isn't funneled through the claim-matrix pipeline.
   */
  rankedEnumeration?: RankedEnumerationResult;
  /**
   * Present only for schema.id === "comparison_matrix" (Milestone 2) — a
   * second parallel result shape, never mixed with alignedClaims/gate/
   * synthesisReport/trustSummary/rankedEnumeration. See
   * comparisonAlignment.ts's header comment for why a two-axis comparison
   * isn't funneled through the claim-matrix pipeline.
   */
  comparisonMatrix?: ComparisonMatrixResult;
  /**
   * Present only for schema.id === "definition_explanation" (Milestone 2) —
   * a third parallel result shape, never mixed with alignedClaims/gate/
   * synthesisReport/trustSummary/rankedEnumeration/comparisonMatrix. See
   * definitionAlignment.ts's header comment for why a definition's atomic
   * unit (a whole interpretation) isn't funneled through the claim-matrix
   * pipeline.
   */
  definitionExplanation?: DefinitionExplanationResult;
  /**
   * Present only for schema.id === "causal_explanation" (Milestone 2) — a
   * fourth parallel result shape, never mixed with alignedClaims/gate/
   * synthesisReport/trustSummary/rankedEnumeration/comparisonMatrix/
   * definitionExplanation. See causalAlignment.ts's header comment for the
   * central design risk this schema exists to avoid (model repetition is
   * panel convergence, never proof of causality).
   */
  causalExplanation?: CausalExplanationResult;
  /**
   * Present only for schema.id === "checklist_taxonomy" (Milestone 2) — a
   * fifth parallel result shape, never mixed with alignedClaims/gate/
   * synthesisReport/trustSummary/rankedEnumeration/comparisonMatrix/
   * definitionExplanation/causalExplanation. See checklistAlignment.ts's
   * header comment for how its item clustering differs from
   * causalAlignment.ts's (merges across categories, then resolves category
   * by majority vote) and from enumAlignment.ts's (no rank at all).
   */
  checklistTaxonomy?: ChecklistTaxonomyResult;
  /**
   * Present only for schema.id === "deep_research" (Milestone 2) — a sixth
   * parallel result shape, never mixed with alignedClaims/gate/
   * synthesisReport/trustSummary/rankedEnumeration/comparisonMatrix/
   * definitionExplanation/causalExplanation/checklistTaxonomy. See
   * deepResearchAlignment.ts's header comment — the only Milestone 2
   * aggregation that's async (it makes a real Bias & Blind Spots Tier 2
   * model call for panelBlindSpots).
   */
  deepResearch?: DeepResearchResult;
  /**
   * Present only for schema.id === "evidence_review" (Milestone 2) — a
   * seventh parallel result shape, never mixed with alignedClaims/gate/
   * synthesisReport/trustSummary/rankedEnumeration/comparisonMatrix/
   * definitionExplanation/causalExplanation/checklistTaxonomy/deepResearch.
   * See evidenceReviewAlignment.ts's header comment for why overallStrength
   * is derived from per-dimension model judgments, never from coverage.
   */
  evidenceReview?: EvidenceReviewResult;
  /**
   * Present only for schema.id === "bias_blindspot_audit" (Milestone 2) —
   * an eighth parallel result shape, never mixed with alignedClaims/gate/
   * synthesisReport/trustSummary/rankedEnumeration/comparisonMatrix/
   * definitionExplanation/causalExplanation/checklistTaxonomy/
   * deepResearch/evidenceReview. See biasBlindspotAlignment.ts's header
   * comment — Tier 1/Tier 2 reuse the embedded system's own model calls
   * directly, never a reimplementation.
   */
  biasBlindspotAudit?: BiasBlindspotAuditResult;
  /**
   * Present only for schema.id === "decision_support" (Milestone 2) — a
   * ninth parallel result shape, never mixed with alignedClaims/gate/
   * synthesisReport/trustSummary/rankedEnumeration/comparisonMatrix/
   * definitionExplanation/causalExplanation/checklistTaxonomy/deepResearch/
   * evidenceReview/biasBlindspotAudit. See decisionSupportAlignment.ts's
   * header comment for why `recommendation` is never a raw vote count.
   */
  decisionSupport?: DecisionSupportResult;
  /**
   * Query-Routing Redesign, Phase 1 — populated alongside the schema-specific
   * result above for any of the 9 active Milestone 2 schemas, whenever
   * `classification` was passed to finalizeAdaptiveRun (absent for callers/
   * tests that omit it, matching this field's own optionality). Never
   * populated for the 10 legacy-active schemas — those still return only
   * `alignedClaims`/`gate`/`synthesisReport`/`trustSummary` below.
   */
  commonResponseMeta?: CommonResponseMeta;
  /** The full versioned envelope `commonResponseMeta` was built as part of — what route.ts persists and returns as `adaptiveOutput`. */
  persistedOutput?: PersistedAdaptiveOutputV1;
  /**
   * Phase 2 pilot history-reload fix — populated ONLY for schema.id ===
   * "procedural", and only when `classification` was passed and the
   * verification engine actually ran (alignedClaims/gate/synthesisReport
   * all present). What route.ts persists and returns as
   * `legacyAdaptiveOutput` — see persistedOutput.ts's
   * PersistedLegacyAdaptiveOutputV1 doc for why this is a separate type
   * from `persistedOutput` above, not a tenth Milestone-2-shaped variant.
   */
  persistedLegacyOutput?: PersistedLegacyAdaptiveOutputV1;
}

/** Schema-specific scalar fields worth aligning across models as a single-row comparison — not every string field, only ones with a genuine cross-model comparison semantic. */
const SCALAR_ALIGNMENT_FIELDS: Partial<Record<QueryType, { key: string; label: string; mode: ScalarComparisonMode }[]>> = {
  factual_lookup: [{ key: "answer", label: "Answer", mode: "exact_normalized" }],
  legal_regulatory: [{ key: "jurisdiction", label: "Jurisdiction", mode: "hard_key" }],
};

function buildNonClaimRows(schema: ResultSchema, adaptiveResults: AdaptiveModelResult[]): AlignedClaim[] {
  const rows: AlignedClaim[] = [];

  const metricFieldKeys = schema.fields.filter((f) => f.type === "metric[]").map((f) => f.key);
  for (const key of metricFieldKeys) {
    const perModel = adaptiveResults.map((r) => ({
      modelId: r.modelId,
      metrics: r.ok && r.data ? ((r.data[key] as Metric[] | undefined) || []) : [],
    }));
    rows.push(...alignMetrics(perModel));
  }

  const scenarioFieldKeys = schema.fields.filter((f) => f.type === "scenario[]").map((f) => f.key);
  for (const key of scenarioFieldKeys) {
    const perModel = adaptiveResults.map((r) => ({
      modelId: r.modelId,
      scenarios: r.ok && r.data ? ((r.data[key] as Scenario[] | undefined) || []) : [],
    }));
    rows.push(...alignScenarios(perModel));
  }

  const stepFieldKeys = schema.fields.filter((f) => f.type === "step[]").map((f) => f.key);
  for (const key of stepFieldKeys) {
    const perModel = adaptiveResults.map((r) => ({
      modelId: r.modelId,
      steps: r.ok && r.data ? ((r.data[key] as Step[] | undefined) || []) : [],
    }));
    rows.push(...alignSteps(perModel));
  }

  const scalarFields = SCALAR_ALIGNMENT_FIELDS[schema.id] || [];
  for (const field of scalarFields) {
    const perModel = adaptiveResults.map((r) => ({
      modelId: r.modelId,
      value: r.ok && r.data ? ((r.data[field.key] as string | undefined) ?? null) : null,
    }));
    rows.push(alignScalarField(perModel, field.key, field.label, field.mode));
  }

  return rows;
}

/**
 * Post-fan-out step: validate every model's raw text against the schema,
 * align every comparable field type into one AlignedClaim[] matrix, and
 * (when ADAPTIVE_VERIFICATION_ENABLED) score agreement/certainty, compute
 * the verification gate, and generate the Synthesis Report.
 */
export async function finalizeAdaptiveRun(
  schema: ResultSchema,
  results: ModelResult[],
  question?: string,
  retryContext?: AdaptiveRetryContext,
  classification?: QueryClassification
): Promise<AdaptivePanelResult> {
  let adaptiveResults: AdaptiveModelResult[] = results.map((r) => ({
    ...validateAdaptiveResponse(r.modelId, schema, r.status === "ok" || r.status === "substituted" ? r.rawText : null),
    latencyMs: r.latencyMs,
  }));

  if (retryContext) {
    adaptiveResults = await Promise.all(
      adaptiveResults.map(async (r, idx) => {
        const needsRetry = !r.ok || (r.invalidFields && r.invalidFields.length > 0);
        if (!needsRetry) return r;
        // AR3: a substituted slot was answered by a different provider than
        // its logical modelId — re-calling CONNECTOR_MAP[modelId] would hit
        // the original (failed) provider, so it is never retried.
        if (results[idx].status === "substituted") return { ...r, retryOutcome: "ineligible_substituted" as const };
        // Only a real "ok" primary answer is ever corrected; failed/error/
        // timeout/refused/rate_limited slots never gain an adaptive retry.
        if (results[idx].status !== "ok") return r;
        return retryModelOnce(schema, question || "", r, retryContext, idx);
      })
    );
  }

  // ranked_enumeration (Milestone 2): a parallel path, not funneled through
  // AlignedClaim at all — see enumAlignment.ts's header comment. Returns
  // early, before any claim[]/metric[]/etc alignment or the gate/
  // synthesisReport/trustSummary pipeline, none of which apply here.
  if (schema.id === "ranked_enumeration") {
    const enumFieldKeys = schema.fields.filter((f) => f.type === "enumItem[]").map((f) => f.key);
    const perModelItems = adaptiveResults.map((r) => ({
      modelId: r.modelId,
      items: r.ok && r.data ? enumFieldKeys.flatMap((key) => (r.data![key] as EnumItem[] | undefined) || []) : [],
    }));
    const rankedEnumeration = buildRankedEnumerationResult(perModelItems, classification?.requestedCount ?? null);
    const envelope = attachAdaptiveEnvelope("ranked_enumeration", schema, classification, results, adaptiveResults, rankedEnumeration);
    return { schemaId: schema.id, adaptiveResults, rankedEnumeration, ...envelope };
  }

  // comparison_matrix (Milestone 2): another parallel path, same reasoning
  // as ranked_enumeration above — a (subject, attribute) cell has no claim
  // vocabulary equivalent, so this skips alignedClaims/gate/synthesisReport/
  // trustSummary entirely too.
  if (schema.id === "comparison_matrix") {
    const cellFieldKeys = schema.fields.filter((f) => f.type === "comparisonCell[]").map((f) => f.key);
    const perModelCells = adaptiveResults.map((r) => ({
      modelId: r.modelId,
      cells: r.ok && r.data ? cellFieldKeys.flatMap((key) => (r.data![key] as ComparisonCell[] | undefined) || []) : [],
      directConclusion: r.ok && r.data && typeof r.data.directConclusion === "string" ? r.data.directConclusion : undefined,
      tradeoffs: r.ok && r.data && Array.isArray(r.data.tradeoffs) ? (r.data.tradeoffs as string[]) : undefined,
      bestUseRecommendations:
        r.ok && r.data && Array.isArray(r.data.bestUseRecommendations) ? (r.data.bestUseRecommendations as string[]) : undefined,
      uncertainties: r.ok && r.data && Array.isArray(r.data.uncertainties) ? (r.data.uncertainties as string[]) : undefined,
    }));
    const comparisonMatrix = buildComparisonMatrixResult(perModelCells);
    const envelope = attachAdaptiveEnvelope("comparison_matrix", schema, classification, results, adaptiveResults, comparisonMatrix);
    return { schemaId: schema.id, adaptiveResults, comparisonMatrix, ...envelope };
  }

  // definition_explanation (Milestone 2): a third parallel path — only
  // models that actually produced usable data are passed in (unlike the two
  // branches above, a failed model has no fields object at all, not an
  // empty-array placeholder), so totalModels is passed explicitly rather
  // than derived from the filtered list.
  if (schema.id === "definition_explanation") {
    const perModelFields = adaptiveResults
      .filter((r) => r.ok && r.data)
      .map((r) => ({ modelId: r.modelId, fields: extractDefinitionFields(r.data!) }));
    const definitionExplanation = buildDefinitionExplanationResult(perModelFields, adaptiveResults.length);
    const envelope = attachAdaptiveEnvelope("definition_explanation", schema, classification, results, adaptiveResults, definitionExplanation);
    return { schemaId: schema.id, adaptiveResults, definitionExplanation, ...envelope };
  }

  // causal_explanation (Milestone 2): a fourth parallel path — same
  // "only successful models, explicit totalModels" pattern as
  // definition_explanation above, for the same reason (no natural "empty"
  // placeholder for a whole missing per-model response).
  if (schema.id === "causal_explanation") {
    const perModelFields = adaptiveResults
      .filter((r) => r.ok && r.data)
      .map((r) => ({ modelId: r.modelId, fields: extractCausalFields(r.data!) }));
    const causalExplanation = buildCausalExplanationResult(perModelFields, adaptiveResults.length);
    const envelope = attachAdaptiveEnvelope("causal_explanation", schema, classification, results, adaptiveResults, causalExplanation);
    return { schemaId: schema.id, adaptiveResults, causalExplanation, ...envelope };
  }

  // checklist_taxonomy (Milestone 2): a fifth parallel path. Unlike
  // definition_explanation/causal_explanation, this includes every model
  // (even ones that failed to parse contribute an empty items[] via
  // extractChecklistFields' safe defaults) — the same "all models, empty
  // placeholder for failures" convention as ranked_enumeration/
  // comparison_matrix, since the core content here is an array field.
  if (schema.id === "checklist_taxonomy") {
    const perModelFields = adaptiveResults.map((r) => ({
      modelId: r.modelId,
      fields: r.ok && r.data ? extractChecklistFields(r.data) : { summary: "", items: [], notes: [] },
    }));
    const checklistTaxonomy = buildChecklistTaxonomyResult(perModelFields);
    const envelope = attachAdaptiveEnvelope("checklist_taxonomy", schema, classification, results, adaptiveResults, checklistTaxonomy);
    return { schemaId: schema.id, adaptiveResults, checklistTaxonomy, ...envelope };
  }

  // deep_research (Milestone 2): a sixth parallel path — the only one that
  // awaits a real model call (auditPanelCoverage, reused Bias & Blind Spots
  // Tier 2), since finalizeAdaptiveRun is already async. Every model is
  // included (a failed model contributes empty defaults via
  // extractDeepResearchFields), matching ranked_enumeration/
  // comparison_matrix/checklist_taxonomy's convention rather than
  // definition_explanation/causal_explanation's "successful models only"
  // one, since the core content here is array fields too.
  if (schema.id === "deep_research") {
    const perModelFields = adaptiveResults.map((r) => ({
      modelId: r.modelId,
      fields:
        r.ok && r.data
          ? extractDeepResearchFields(r.data)
          : { executiveSummary: "", findings: [], disagreements: [], evidenceGaps: [], openQuestions: [], researchBoundaries: [], recommendedNextSteps: [], sources: [] },
    }));
    const deepResearch = await buildDeepResearchResult(perModelFields, question || "");
    const envelope = attachAdaptiveEnvelope("deep_research", schema, classification, results, adaptiveResults, deepResearch);
    return { schemaId: schema.id, adaptiveResults, deepResearch, ...envelope };
  }

  // evidence_review (Milestone 2): a seventh parallel path — only models
  // that actually produced usable data are passed in (unlike
  // ranked_enumeration/comparison_matrix/checklist_taxonomy/deep_research,
  // there's no natural "empty" per-model placeholder object worth
  // constructing here; matches definition_explanation/causal_explanation's
  // convention instead).
  if (schema.id === "evidence_review") {
    const perModelFields = adaptiveResults
      .filter((r) => r.ok && r.data)
      .map((r) => ({ modelId: r.modelId, fields: extractEvidenceReviewFields(r.data!) }));
    const evidenceReview = buildEvidenceReviewResult(perModelFields, adaptiveResults.length);
    const envelope = attachAdaptiveEnvelope("evidence_review", schema, classification, results, adaptiveResults, evidenceReview);
    return { schemaId: schema.id, adaptiveResults, evidenceReview, ...envelope };
  }

  // bias_blindspot_audit (Milestone 2): an eighth parallel path — the
  // second (after deep_research) that awaits real model calls, this time
  // TWO run in parallel (Tier 1's detectAdaptiveBiases, Tier 2's
  // auditPanelCoverage), both reused verbatim from the embedded system. The
  // only branch that also needs the RAW `results: ModelResult[]` (not just
  // validated adaptiveResults) — Tier 1 reads full raw response text.
  if (schema.id === "bias_blindspot_audit") {
    const perModelFields = adaptiveResults
      .filter((r) => r.ok && r.data)
      .map((r) => ({ modelId: r.modelId, fields: extractBiasBlindspotFields(r.data!) }));
    const biasBlindspotAudit = await buildBiasBlindspotAuditResult(
      perModelFields,
      adaptiveResults.length,
      question || "",
      results
    );
    const envelope = attachAdaptiveEnvelope("bias_blindspot_audit", schema, classification, results, adaptiveResults, biasBlindspotAudit);
    return { schemaId: schema.id, adaptiveResults, biasBlindspotAudit, ...envelope };
  }

  // decision_support (Milestone 2): a ninth parallel path — only models that
  // actually produced usable data are passed in, same convention as
  // definition_explanation/causal_explanation/evidence_review (rich,
  // heterogeneous per-model objects have no natural "empty" placeholder
  // worth constructing). `classification?.riskLevel` is threaded through so
  // humanReviewNeeded can be computed honestly (never left to the renderer
  // alone) — see decisionSupportAlignment.ts's header comment.
  if (schema.id === "decision_support") {
    const perModelFields = adaptiveResults
      .filter((r) => r.ok && r.data)
      .map((r) => ({ modelId: r.modelId, fields: extractDecisionSupportFields(r.data!) }));
    const decisionSupport = buildDecisionSupportResult(perModelFields, adaptiveResults.length, classification?.riskLevel);
    const envelope = attachAdaptiveEnvelope("decision_support", schema, classification, results, adaptiveResults, decisionSupport);
    return { schemaId: schema.id, adaptiveResults, decisionSupport, ...envelope };
  }

  const claimFieldKeys = schema.fields.filter((f) => f.type === "claim[]").map((f) => f.key);

  let alignedClaims: AlignedClaim[] = [];

  if (claimFieldKeys.length > 0) {
    const perModelClaims: ModelClaims[] = adaptiveResults.map((r) => {
      const claims: Claim[] = [];
      // claimOrigins[i] records which field claims[i] came from (settled vs
      // disputed, see claimFieldClass) — built in the same loop so the two
      // can't drift apart.
      const claimOrigins: ClaimFieldOrigin[] = [];
      if (r.ok && r.data) {
        for (const key of claimFieldKeys) {
          for (const claim of (r.data[key] as Claim[] | undefined) || []) {
            claims.push(claim);
            claimOrigins.push({ field: key, fieldClass: claimFieldClass(schema.id, key) });
          }
        }
      }
      // Full response (not just claim[] fields) so the stance-extraction
      // backfill (alignment.ts pass 3) can catch a stance implied only in
      // prose — e.g. a `summary` field — that the model never separately
      // listed as a Claim.
      return { modelId: r.modelId, claims, claimOrigins, fullResponseData: r.ok ? r.data : null };
    });
    alignedClaims.push(...(await alignClaims(perModelClaims)));
  }

  alignedClaims.push(...buildNonClaimRows(schema, adaptiveResults));

  if (alignedClaims.length === 0) {
    // Batch 3 persistence foundation (2C-1) — a schema with no
    // claim/metric/scenario/step/scalar-alignment fields (today, only
    // creative_generative) never computes gate/synthesisReport, live or
    // historical; still attach the envelope so its raw per-model results
    // persist for History parity, matching what AdaptivePanelResponse.tsx's
    // existing `!gate || !synthesisReport` fallback already renders live.
    const legacyEnvelope = isPersistedLegacyAdaptiveSchemaId(schema.id)
      ? attachLegacyAdaptiveEnvelope(schema.id, classification, adaptiveResults, alignedClaims)
      : {};
    return { schemaId: schema.id, adaptiveResults, ...legacyEnvelope };
  }

  if (!ADAPTIVE_VERIFICATION_ENABLED) {
    // Unscored matrix only — preserves pre-restoration behavior for anyone
    // running with the verification engine flag off.
    return { schemaId: schema.id, adaptiveResults, alignedClaims };
  }

  // results holds one entry per DISPATCHED model, failures included — the
  // panel size limited_coverage is measured against (consensusIntegrity.ts).
  const scoredForAgreement = applyConsensusIntegrity(scoreAgreement(schema.id, alignedClaims), results.length);
  const scored = scoreClaimCertainty(scoredForAgreement, results.length);

  const runCertainty = computeRunCertainty(scored, schema.id);
  const gate = computeAdaptiveGate(scored, runCertainty, schema.id);
  const synthesisReport = await buildAdaptiveSynthesisReport(question || "", schema.id, scored, results);
  const trustSummary = buildAdaptiveTrustSummary(schema, adaptiveResults, scored);

  // Batch 3 persistence foundation (2C-1) — originally narrowly scoped to
  // schema.id === "procedural" only (Phase 2 pilot); now covers the full
  // 8-member legacy-active family (isPersistedLegacyAdaptiveSchemaId), per
  // docs/adaptive-synthesis-batch3-persistence-audit.md. Every schema in
  // that family reaches this exact same claims-matrix fall-through, so no
  // other branching changes — only which schemas get the envelope widens.
  const legacyEnvelope = isPersistedLegacyAdaptiveSchemaId(schema.id)
    ? attachLegacyAdaptiveEnvelope(schema.id, classification, adaptiveResults, scored, gate, synthesisReport, trustSummary)
    : {};

  return {
    schemaId: schema.id,
    adaptiveResults,
    alignedClaims: scored,
    gate,
    synthesisReport,
    trustSummary,
    ...legacyEnvelope,
  };
}

// ─── Non-execution response (query-routing redesign, Milestone 1.5) ────────
// Built once, here, from the SAME routing decision planAdaptiveRun already
// computed — app/api/run-panel/route.ts calls this and returns immediately,
// BEFORE checkAndIncrementUsageForRun/createRun/runPanel, whenever
// plan.routing.kind !== "active". Never persisted as a runs/{runId} doc
// (this never becomes a "run" at all — no quota consumed, no run created)
// and never carries consensus/certainty/gate/verdict fields, since no model
// was ever called.

/** Mirrors the four `capability_gap`/`handoff`/`clarification_required`/`invalid_state` outcomes the approved design specified, plus "unanswerable" for a direct (non-clarification) graceful_limitation classification — a case the original 4-value enum didn't have a slot for. */
export type NonExecutionRoutingOutcome = "handoff" | "capability_gap" | "clarification_required" | "unanswerable" | "invalid_state";

export interface NonExecutionAdaptivePayload {
  classification: QueryClassification;
  schemaId: QueryType;
  results: [];
  executionStatus: "not_started";
  routingOutcome: NonExecutionRoutingOutcome;
  modelsInvoked: 0;
  tokensUsed: 0;
  limitation: GracefulLimitationResponse;
}

function routingOutcomeFor(kind: Exclude<RoutedQuery["kind"], "active">): NonExecutionRoutingOutcome {
  switch (kind) {
    case "handoff":
      return "handoff";
    case "disabled":
      return "capability_gap";
    case "clarification":
      return "clarification_required";
    case "unanswerable":
      return "unanswerable";
    case "invalid":
      return "invalid_state";
  }
}

/**
 * Builds the full `{ok, runId, results, adaptive}` JSON body for a
 * non-executed run. `classification` is included so the client can
 * independently call routeClassifiedQuery() itself (same function, same
 * registry) rather than trust the server's routing label blindly.
 */
export function buildNonExecutionPayload(classification: QueryClassification, routing: RoutedQuery) {
  if (routing.kind === "active") {
    // Contract violation if the caller reaches here — never actually hit
    // in practice since app/api/run-panel/route.ts only calls this when
    // routing.kind !== "active", but fail safe rather than construct a
    // nonsensical payload.
    throw new Error("buildNonExecutionPayload called with an active routing decision");
  }

  const schemaId: QueryType = routing.kind === "invalid" ? "graceful_limitation" : routing.queryType;

  const adaptive: NonExecutionAdaptivePayload = {
    classification,
    schemaId,
    results: [],
    executionStatus: "not_started",
    routingOutcome: routingOutcomeFor(routing.kind),
    modelsInvoked: 0,
    tokensUsed: 0,
    limitation: routing.response,
  };

  return {
    ok: true as const,
    runId: null,
    results: [] as ModelResult[],
    adaptive,
  };
}
