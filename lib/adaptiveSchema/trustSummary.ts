/**
 * Trust Summary (R1c)
 *
 * Per model, per run: claims contributed, alignment with the panel majority,
 * citation presence, contradiction count, and parse/validation health,
 * rolled into one composite trustScore weighted per schema
 * (TRUST_WEIGHTS_BY_SCHEMA in config.ts — citations matter more for
 * factual_lookup/medical/legal, numeric consistency matters more for
 * financial_valuation/procedural).
 *
 * Operates on rows already scored by agreementComparators.ts/scoring.ts —
 * this module reads agreementScore/status but never writes them.
 */

import "server-only";
import { ModelId } from "@/lib/types";
import { AdaptiveModelResult, AdaptiveTrustSummary, AlignedClaim, Metric, ModelTrustSummary, ResultSchema } from "./types";
import { getTrustWeights } from "./config";

export type { AdaptiveTrustSummary, ModelTrustSummary };

function parseHealthFor(result: AdaptiveModelResult): ModelTrustSummary["parseHealth"] {
  if (!result.ok) return "failed";
  if (result.truncatedFields && result.truncatedFields.length > 0) return "degraded";
  return "ok";
}

function countClaimsContributed(schema: ResultSchema, result: AdaptiveModelResult): number {
  if (!result.ok || !result.data) return 0;
  let count = 0;
  for (const field of schema.fields) {
    if (field.type === "claim[]" || field.type === "metric[]" || field.type === "step[]" || field.type === "scenario[]") {
      const value = result.data[field.key];
      if (Array.isArray(value)) count += value.length;
    }
  }
  return count;
}

function isRealSource(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "unknown" && normalized !== "none" && normalized !== "n/a";
}

/**
 * Citation-presence signal, scoped to whatever the schema actually asks a
 * model to source: Metric.source (financial_valuation, contested_empirical's
 * keyMetrics) or factual_lookup's dedicated `source` field. Schemas with no
 * sourceable field at all (procedural, forecast_speculative,
 * creative_generative, legal_regulatory) have nothing to check — citationScore
 * is neutral (1) rather than penalizing a model for a schema that never asked
 * it to cite anything.
 */
function computeCitationScore(schema: ResultSchema, result: AdaptiveModelResult): number {
  if (!result.ok || !result.data) return 0;

  const sourceableValues: (string | null | undefined)[] = [];
  const metricFieldKeys = schema.fields.filter((f) => f.type === "metric[]").map((f) => f.key);
  for (const key of metricFieldKeys) {
    const metrics = (result.data[key] as Metric[] | undefined) || [];
    for (const m of metrics) sourceableValues.push(m.source);
  }

  if (schema.id === "factual_lookup") {
    sourceableValues.push(result.data["source"] as string | undefined);
  }

  if (sourceableValues.length === 0) return 1;

  const sourced = sourceableValues.filter(isRealSource).length;
  return sourced / sourceableValues.length;
}

/** Majority stance among a row's non-null cells (mode; ties broken by first-seen order). */
function majorityStance(row: AlignedClaim): string | null {
  const counts = new Map<string, number>();
  for (const cell of row.cells) {
    if (!cell) continue;
    counts.set(cell.stance, (counts.get(cell.stance) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [stance, count] of counts) {
    if (count > bestCount) {
      best = stance;
      bestCount = count;
    }
  }
  return best;
}

function computeConsistencyAndContradiction(
  modelId: ModelId,
  rows: AlignedClaim[]
): { majorityAlignment: number; contradictionCount: number; participatedRows: number } {
  let participatedRows = 0;
  let aligned = 0;
  let contradictions = 0;

  for (const row of rows) {
    const cell = row.cells.find((c) => c?.modelId === modelId);
    if (!cell) continue;
    participatedRows += 1;

    const dominant = majorityStance(row);
    if (dominant && cell.stance === dominant) {
      aligned += 1;
    } else if (row.status === "split" && cell.stance === "disputes") {
      contradictions += 1;
    }
  }

  return {
    majorityAlignment: participatedRows > 0 ? aligned / participatedRows : 1,
    contradictionCount: contradictions,
    participatedRows,
  };
}

/** Builds the per-model + overall Trust Summary from already-scored aligned claims. */
export function buildAdaptiveTrustSummary(
  schema: ResultSchema,
  adaptiveResults: AdaptiveModelResult[],
  alignedClaims: AlignedClaim[]
): AdaptiveTrustSummary {
  const weights = getTrustWeights(schema.id);

  const perModel: ModelTrustSummary[] = adaptiveResults.map((result) => {
    const parseHealth = parseHealthFor(result);
    const claimsContributed = countClaimsContributed(schema, result);
    const citationScore = computeCitationScore(schema, result);
    const { majorityAlignment, contradictionCount, participatedRows } = computeConsistencyAndContradiction(
      result.modelId,
      alignedClaims
    );
    const contradictionRate = participatedRows > 0 ? contradictionCount / participatedRows : 0;
    const contradictionSubScore = 1 - contradictionRate;

    const trustScore =
      parseHealth === "failed"
        ? 0
        : weights.citation * citationScore + weights.consistency * majorityAlignment + weights.contradiction * contradictionSubScore;

    return {
      modelId: result.modelId,
      claimsContributed,
      majorityAlignment,
      citationScore,
      contradictionCount,
      parseHealth,
      trustScore,
    };
  });

  const scored = perModel.filter((m) => m.parseHealth !== "failed");
  const overallTrust = scored.length > 0 ? scored.reduce((sum, m) => sum + m.trustScore, 0) / scored.length : 0;

  return { perModel, overallTrust };
}
