/**
 * Field Alignment (non-claim units)
 *
 * lib/adaptiveSchema/alignment.ts aligns claim[] fields. Several schemas
 * carry their verifiable content in metric[] / step[] / scenario[] / scalar
 * string fields instead (financial_valuation's metrics, forecast_speculative's
 * scenarios, procedural's steps, factual_lookup's answer, legal_regulatory's
 * jurisdiction) — nothing in the pre-existing pipeline aligned those across
 * models at all. Per R1a, AlignedClaim is the universal verification unit,
 * so these unitizers turn each of those field types into AlignedClaim rows
 * too, using deterministic structural keys (label / order) instead of LLM
 * clustering — there's no under-clustering risk here since these fields
 * carry their own explicit matching key, unlike freeform claim text.
 *
 * These functions only build the matrix (cells + a first-pass stance from
 * the type-appropriate comparison). Final agreementScore/status are always
 * assigned by the schema's AgreementComparator (agreementComparators.ts).
 */

import "server-only";
import { ModelId } from "@/lib/types";
import {
  AlignedClaim,
  AlignedClaimCell,
  ClaimCellStance,
  Metric,
  Scenario,
  Step,
} from "./types";
import {
  DEFAULT_METRIC_TOLERANCE,
  METRIC_DISPUTE_MULTIPLIER,
  METRIC_TOLERANCE_OVERRIDES,
  SCENARIO_DISPUTE_MULTIPLIER,
  SCENARIO_PROBABILITY_TOLERANCE,
} from "./config";

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

function slugifyLabel(label: string): string {
  return normalizeLabel(label).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function emptyRow(id: string, claimText: string, modelOrder: ModelId[]): AlignedClaim {
  return {
    id,
    claimText,
    cells: modelOrder.map(() => null),
    agreementScore: 0,
    certaintyScore: 0,
    status: "single_source",
  };
}

// ─── metric[] (financial_valuation) ────────────────────────────────────

export function alignMetrics(
  perModel: { modelId: ModelId; metrics: Metric[] }[]
): AlignedClaim[] {
  const modelOrder = perModel.map((m) => m.modelId);
  const groups = new Map<string, { label: string; entries: { modelId: ModelId; metric: Metric }[] }>();

  for (const { modelId, metrics } of perModel) {
    for (const metric of metrics) {
      const key = normalizeLabel(metric.label);
      if (!groups.has(key)) groups.set(key, { label: metric.label, entries: [] });
      groups.get(key)!.entries.push({ modelId, metric });
    }
  }

  const rows: AlignedClaim[] = [];
  for (const { label, entries } of groups.values()) {
    const row = emptyRow(slugifyLabel(label) || `metric-${rows.length}`, label, modelOrder);
    const numericValues = entries
      .filter((e) => typeof e.metric.value === "number")
      .map((e) => e.metric.value as number);
    const centerValue = numericValues.length > 0 ? median(numericValues) : null;
    const tolerance = METRIC_TOLERANCE_OVERRIDES[normalizeLabel(label)] ?? DEFAULT_METRIC_TOLERANCE;

    const cellByModel = new Map<ModelId, AlignedClaimCell>();
    for (const { modelId, metric } of entries) {
      if (cellByModel.has(modelId)) continue;

      let stance: ClaimCellStance = "unclear";
      if (typeof metric.value === "number" && centerValue !== null) {
        if (centerValue === 0) {
          stance = metric.value === 0 ? "agrees" : "disputes";
        } else {
          const relDiff = Math.abs(metric.value - centerValue) / Math.abs(centerValue);
          stance = relDiff <= tolerance ? "agrees" : relDiff <= tolerance * METRIC_DISPUTE_MULTIPLIER ? "partial" : "disputes";
        }
      }

      cellByModel.set(modelId, {
        modelId,
        stance,
        rawStance: stance === "disputes" ? "disputes" : stance === "unclear" ? "uncertain" : "asserts",
        confidence: "majority_view",
        excerpt: `${metric.value ?? "unknown"}${metric.unit ? ` ${metric.unit}` : ""} (as of ${metric.asOf}, source: ${metric.source})`,
        raw: metric,
      });
    }

    row.cells = modelOrder.map((modelId) => cellByModel.get(modelId) ?? null);
    rows.push(row);
  }

  return rows;
}

// ─── scenario[] (forecast_speculative) ─────────────────────────────────

export function alignScenarios(
  perModel: { modelId: ModelId; scenarios: Scenario[] }[]
): AlignedClaim[] {
  const modelOrder = perModel.map((m) => m.modelId);
  const groups = new Map<string, { label: string; entries: { modelId: ModelId; scenario: Scenario }[] }>();

  for (const { modelId, scenarios } of perModel) {
    for (const scenario of scenarios) {
      const key = normalizeLabel(scenario.label);
      if (!groups.has(key)) groups.set(key, { label: scenario.label, entries: [] });
      groups.get(key)!.entries.push({ modelId, scenario });
    }
  }

  const rows: AlignedClaim[] = [];
  for (const { label, entries } of groups.values()) {
    const row = emptyRow(slugifyLabel(label) || `scenario-${rows.length}`, label, modelOrder);
    const probabilities = entries.map((e) => e.scenario.probability);
    const centerProbability = probabilities.length > 0 ? median(probabilities) : null;

    const cellByModel = new Map<ModelId, AlignedClaimCell>();
    for (const { modelId, scenario } of entries) {
      if (cellByModel.has(modelId)) continue;

      let stance: ClaimCellStance = "unclear";
      if (centerProbability !== null) {
        const absDiff = Math.abs(scenario.probability - centerProbability);
        stance =
          absDiff <= SCENARIO_PROBABILITY_TOLERANCE
            ? "agrees"
            : absDiff <= SCENARIO_PROBABILITY_TOLERANCE * SCENARIO_DISPUTE_MULTIPLIER
              ? "partial"
              : "disputes";
      }

      cellByModel.set(modelId, {
        modelId,
        stance,
        rawStance: stance === "disputes" ? "disputes" : stance === "unclear" ? "uncertain" : "asserts",
        confidence: "majority_view",
        excerpt: `${Math.round(scenario.probability * 100)}% — ${scenario.narrative}`,
        raw: scenario,
      });
    }

    row.cells = modelOrder.map((modelId) => cellByModel.get(modelId) ?? null);
    rows.push(row);
  }

  return rows;
}

// ─── step[] (procedural) ────────────────────────────────────────────────

/** Cheap token-overlap similarity, avoids an LLM call for a purely structural comparison. */
function textSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalizeLabel(a).split(" ").filter(Boolean));
  const tokensB = new Set(normalizeLabel(b).split(" ").filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokensA) if (tokensB.has(t)) overlap += 1;
  return overlap / Math.max(tokensA.size, tokensB.size);
}

const STEP_AGREEMENT_SIMILARITY = 0.4;
const STEP_DISPUTE_SIMILARITY = 0.15;

/**
 * Steps are order-sensitive: one row per step order number. A model missing
 * a step at that order is null (not disagreement) — only a model that HAS a
 * step at that order whose action text is a poor match for the majority
 * phrasing counts as "disputes" (a real contradiction requires reading the
 * text; this heuristic approximates it via token overlap rather than an LLM
 * call, since order+phrasing is already a strong structural signal).
 */
export function alignSteps(
  perModel: { modelId: ModelId; steps: Step[] }[]
): AlignedClaim[] {
  const modelOrder = perModel.map((m) => m.modelId);
  const maxOrder = Math.max(0, ...perModel.flatMap((m) => m.steps.map((s) => s.order)));

  const rows: AlignedClaim[] = [];
  for (let order = 1; order <= maxOrder; order++) {
    const entries = perModel
      .flatMap((m) => m.steps.filter((s) => s.order === order).map((step) => ({ modelId: m.modelId, step })));
    if (entries.length === 0) continue;

    const representativeText = entries[0].step.action;
    const row = emptyRow(`step-${order}`, `Step ${order}: ${representativeText}`, modelOrder);

    const cellByModel = new Map<ModelId, AlignedClaimCell>();
    for (const { modelId, step } of entries) {
      if (cellByModel.has(modelId)) continue;

      const similarities = entries
        .filter((e) => e.modelId !== modelId)
        .map((e) => textSimilarity(step.action, e.step.action));
      const bestMatch = similarities.length > 0 ? Math.max(...similarities) : null;

      let stance: ClaimCellStance = "unclear";
      if (bestMatch !== null) {
        stance = bestMatch >= STEP_AGREEMENT_SIMILARITY ? "agrees" : bestMatch >= STEP_DISPUTE_SIMILARITY ? "partial" : "disputes";
      }

      cellByModel.set(modelId, {
        modelId,
        stance,
        rawStance: stance === "disputes" ? "disputes" : stance === "unclear" ? "uncertain" : "asserts",
        confidence: "majority_view",
        excerpt: step.action,
        raw: step,
      });
    }

    row.cells = modelOrder.map((modelId) => cellByModel.get(modelId) ?? null);
    rows.push(row);
  }

  return rows;
}

// ─── scalar string fields (factual_lookup's answer, legal's jurisdiction) ─

export type ScalarComparisonMode = "exact_normalized" | "hard_key";

function normalizeForComparison(value: string): string {
  return value.trim().toLowerCase().replace(/[.,;:!?'"]/g, "").replace(/\s+/g, " ");
}

/**
 * Aligns a single scalar string field (not an array) into ONE AlignedClaim
 * row comparing every model's value. "exact_normalized" treats any
 * normalized mismatch as a dispute (factual_lookup: dates/names/numbers
 * either match or they don't). "hard_key" is the same mechanical comparison;
 * callers needing legal_regulatory's jurisdiction_mismatch semantics set
 * AlignedClaim.disagreementType afterward (agreementComparators.ts), since
 * that's a scoring decision, not an alignment one.
 */
export function alignScalarField(
  perModel: { modelId: ModelId; value: string | null }[],
  rowId: string,
  claimText: string,
  _mode: ScalarComparisonMode
): AlignedClaim {
  const modelOrder = perModel.map((m) => m.modelId);
  const row = emptyRow(rowId, claimText, modelOrder);

  const present = perModel.filter((m) => m.value && m.value.trim().length > 0);
  const normalizedCounts = new Map<string, number>();
  for (const { value } of present) {
    const norm = normalizeForComparison(value!);
    normalizedCounts.set(norm, (normalizedCounts.get(norm) ?? 0) + 1);
  }
  let majorityNorm: string | null = null;
  let majorityCount = 0;
  for (const [norm, count] of normalizedCounts) {
    if (count > majorityCount) {
      majorityNorm = norm;
      majorityCount = count;
    }
  }

  const cellByModel = new Map<ModelId, AlignedClaimCell>();
  for (const { modelId, value } of perModel) {
    if (!value || !value.trim()) continue;
    const norm = normalizeForComparison(value);
    const stance: ClaimCellStance = majorityNorm !== null && norm === majorityNorm ? "agrees" : "disputes";
    cellByModel.set(modelId, {
      modelId,
      stance,
      rawStance: stance === "agrees" ? "asserts" : "disputes",
      confidence: "majority_view",
      excerpt: value.trim(),
    });
  }

  row.cells = modelOrder.map((modelId) => cellByModel.get(modelId) ?? null);
  return row;
}
