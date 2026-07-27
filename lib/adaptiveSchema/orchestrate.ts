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
import { classifyQuery } from "./classifier";
import { getResultSchema } from "./schemaRegistry";
import { buildModelPrompt } from "./promptBuilder";
import { validateAdaptiveResponse } from "./validator";
import { alignClaims, ModelClaims } from "./alignment";
import { alignMetrics, alignScenarios, alignSteps, alignScalarField, ScalarComparisonMode } from "./fieldAlignment";
import { scoreAgreement } from "./agreementComparators";
import { scoreClaimCertainty, computeRunCertainty } from "./scoring";
import { computeAdaptiveGate, AdaptiveGateResult } from "./gate";
import { buildAdaptiveSynthesisReport, AdaptiveSynthesisReport } from "./synthesisReport";
import { buildAdaptiveTrustSummary } from "./trustSummary";
import {
  AdaptiveModelResult,
  AdaptiveTrustSummary,
  AlignedClaim,
  Claim,
  Metric,
  QueryClassification,
  QueryType,
  ResultSchema,
  Scenario,
  Step,
} from "./types";

export interface AdaptivePromptPlan {
  classification: QueryClassification;
  schema: ResultSchema;
  promptOverrides: Partial<Record<ModelId, string>>;
}

/**
 * Pre-fan-out step: classify the query once, then build the same
 * schema-scoped system prompt for every selected model (all models answer
 * the same schema so their responses are comparable).
 */
export async function planAdaptiveRun(
  question: string,
  selectedModels: ModelId[],
  context: string | null
): Promise<AdaptivePromptPlan> {
  const classification = await classifyQuery(question);
  const schema = getResultSchema(classification.queryType);
  const prompt = buildModelPrompt(question, classification, schema, context);

  const promptOverrides: Partial<Record<ModelId, string>> = {};
  for (const modelId of selectedModels) {
    promptOverrides[modelId] = prompt;
  }

  return { classification, schema, promptOverrides };
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
  question?: string
): Promise<AdaptivePanelResult> {
  const adaptiveResults = results.map((r) =>
    validateAdaptiveResponse(r.modelId, schema, r.status === "ok" || r.status === "substituted" ? r.rawText : null)
  );

  const claimFieldKeys = schema.fields.filter((f) => f.type === "claim[]").map((f) => f.key);

  let alignedClaims: AlignedClaim[] = [];

  if (claimFieldKeys.length > 0) {
    const perModelClaims: ModelClaims[] = adaptiveResults.map((r) => {
      const claims: Claim[] = r.ok && r.data ? claimFieldKeys.flatMap((key) => (r.data![key] as Claim[] | undefined) || []) : [];
      // Full response (not just claim[] fields) so the stance-extraction
      // backfill (alignment.ts pass 3) can catch a stance implied only in
      // prose — e.g. a `summary` field — that the model never separately
      // listed as a Claim.
      return { modelId: r.modelId, claims, fullResponseData: r.ok ? r.data : null };
    });
    alignedClaims.push(...(await alignClaims(perModelClaims)));
  }

  alignedClaims.push(...buildNonClaimRows(schema, adaptiveResults));

  if (alignedClaims.length === 0) {
    return { schemaId: schema.id, adaptiveResults };
  }

  if (!ADAPTIVE_VERIFICATION_ENABLED) {
    // Unscored matrix only — preserves pre-restoration behavior for anyone
    // running with the verification engine flag off.
    return { schemaId: schema.id, adaptiveResults, alignedClaims };
  }

  const scoredForAgreement = scoreAgreement(schema.id, alignedClaims);
  const scored = scoreClaimCertainty(scoredForAgreement, results.length);

  const runCertainty = computeRunCertainty(scored, schema.id);
  const gate = computeAdaptiveGate(scored, runCertainty, schema.id);
  const synthesisReport = await buildAdaptiveSynthesisReport(question || "", schema.id, scored, results);
  const trustSummary = buildAdaptiveTrustSummary(schema, adaptiveResults, scored);

  return {
    schemaId: schema.id,
    adaptiveResults,
    alignedClaims: scored,
    gate,
    synthesisReport,
    trustSummary,
  };
}
