/**
 * Order 5 Contract C1 (claim-tie attribution) — deterministic fixtures (Phase 3). Baseline values for every fixture
 * were captured from the shipped 625773767 trustSummary.ts before any production edit
 * (__fixtures__/baseline-62577376/claimTieBaseline.json, written by captureBaseline.spec.ts with O5C_CAPTURE=1).
 */
import { alignScalarField } from "@/lib/adaptiveSchema/fieldAlignment";
import type { AdaptiveModelResult, AlignedClaim, AlignedClaimCell, AlignedClaimStatus, ClaimCellStance } from "@/lib/adaptiveSchema/types";
import type { ModelId } from "@/lib/types";

export const SLOTS: ModelId[] = ["chatgpt", "claude", "grok", "perplexity", "gemini"];

export function claimCell(modelId: ModelId, stance: ClaimCellStance): AlignedClaimCell {
  return { modelId, stance, rawStance: "asserts", confidence: "settled", origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" }, excerpt: `${modelId} ${stance}` };
}
export function inferredCell(modelId: ModelId, stance: ClaimCellStance): AlignedClaimCell {
  return { modelId, stance, rawStance: "asserts", confidence: null, origin: { kind: "inferred" }, excerpt: `${modelId} inferred ${stance}`, backfilled: true };
}
export function derivedCell(modelId: ModelId, stance: ClaimCellStance, fieldType: "metric" | "scenario" | "step"): AlignedClaimCell {
  return { modelId, stance, rawStance: "asserts", confidence: null, origin: { kind: "field_derived", fieldType }, excerpt: `${modelId} ${fieldType}` };
}
export function unknownCell(modelId: ModelId, stance: ClaimCellStance): AlignedClaimCell {
  return { modelId, stance, rawStance: "asserts", confidence: "settled", excerpt: `${modelId} legacy` };
}

export function row(id: string, status: AlignedClaimStatus, cells: (AlignedClaimCell | null)[]): AlignedClaim {
  return { id, claimText: id, cells, agreementScore: status === "split" ? 0.5 : 1, certaintyScore: 0.5, status };
}

/** Claim row from slot-ordered stances (null = no position). */
export function claimRow(id: string, status: AlignedClaimStatus, stances: (ClaimCellStance | null)[], slots: ModelId[] = SLOTS): AlignedClaim {
  return row(id, status, stances.map((s, i) => (s ? claimCell(slots[i], s) : null)));
}

/** Scalar row exactly as the shipped aligner builds it (first-seen largest value group "agrees"). */
export function scalarRow(id: string, values: (string | null)[], slots: ModelId[] = SLOTS, status: AlignedClaimStatus = "split"): AlignedClaim {
  const r = alignScalarField(values.map((v, i) => ({ modelId: slots[i], value: v })), id, id, "exact_normalized");
  return { ...r, status, agreementScore: status === "split" ? 0 : 1 };
}

export function okResult(modelId: ModelId, schemaId = "generic", extra: Partial<AdaptiveModelResult> = {}): AdaptiveModelResult {
  return { modelId, schemaId: schemaId as any, ok: true, data: {}, ...extra };
}
export function failedResult(modelId: ModelId, schemaId = "generic"): AdaptiveModelResult {
  return { modelId, schemaId: schemaId as any, ok: false, data: null, parseError: "invalid JSON" } as AdaptiveModelResult;
}
export function degradedResult(modelId: ModelId, schemaId = "generic"): AdaptiveModelResult {
  return { modelId, schemaId: schemaId as any, ok: true, data: {}, truncatedFields: ["summary"] };
}

export interface Fixture {
  name: string;
  schemaId: string;
  results: () => AdaptiveModelResult[];
  rows: () => AlignedClaim[];
  /** True when at least one row is an eligible claim-origin tie (the rule applies). */
  tie: boolean;
}

const ok = (n: number, schemaId = "generic") => () => SLOTS.slice(0, n).map((m) => okResult(m, schemaId));

export const FIXTURES: Fixture[] = [
  { name: "claim-1-1-agrees-disputes-split", schemaId: "generic", results: ok(2), rows: () => [claimRow("r", "split", ["agrees", "disputes"])], tie: true },
  { name: "claim-1-1-disputes-agrees-split", schemaId: "generic", results: ok(2), rows: () => [claimRow("r", "split", ["disputes", "agrees"])], tie: true },
  { name: "claim-three-way-split", schemaId: "generic", results: ok(3), rows: () => [claimRow("r", "split", ["agrees", "disputes", "partial"])], tie: true },
  { name: "claim-2-2-agrees-disputes-split", schemaId: "generic", results: ok(4), rows: () => [claimRow("r", "split", ["agrees", "disputes", "agrees", "disputes"])], tie: true },
  { name: "claim-1-1-partial-disputes-split", schemaId: "procedural", results: ok(2, "procedural"), rows: () => [claimRow("r", "split", ["partial", "disputes"])], tie: true },
  { name: "claim-1-1-agrees-unclear-majority", schemaId: "generic", results: ok(2), rows: () => [claimRow("r", "limited_coverage", ["agrees", "unclear"])], tie: true },
  { name: "claim-2-2-agrees-partial-majority", schemaId: "generic", results: ok(4), rows: () => [claimRow("r", "majority", ["agrees", "partial", "agrees", "partial"])], tie: true },
  { name: "claim-nonsplit-tie-with-dispute", schemaId: "generic", results: ok(5), rows: () => [claimRow("r", "majority", ["agrees", "agrees", "partial", "partial", "disputes"])], tie: true },
  { name: "claim-untied-3-1-split", schemaId: "generic", results: ok(4), rows: () => [claimRow("r", "split", ["agrees", "agrees", "disputes", "agrees"])], tie: false },
  { name: "claim-untied-disputes-mode-split", schemaId: "generic", results: ok(4), rows: () => [claimRow("r", "split", ["agrees", "disputes", "disputes", "disputes"])], tie: false },
  { name: "claim-single-cell", schemaId: "generic", results: ok(2), rows: () => [claimRow("r", "single_source", ["disputes", null])], tie: false },
  {
    name: "claim-inferred-mixed-tie",
    schemaId: "generic",
    results: ok(2),
    rows: () => [row("r", "split", [claimCell("chatgpt", "agrees"), inferredCell("claude", "disputes")])],
    tie: true,
  },
  { name: "scalar-2-2-tie", schemaId: "factual_lookup", results: ok(4, "factual_lookup"), rows: () => [scalarRow("answer", ["Paris", "Lyon", "paris", "Lyon"])], tie: false },
  { name: "scalar-1-1-tie", schemaId: "factual_lookup", results: ok(2, "factual_lookup"), rows: () => [scalarRow("answer", ["Paris", "Lyon"])], tie: false },
  { name: "scalar-3-2-untied", schemaId: "factual_lookup", results: ok(5, "factual_lookup"), rows: () => [scalarRow("answer", ["Paris", "Lyon", "Paris", "Lyon", "Paris"])], tie: false },
  { name: "scalar-2-1-1-c1t2-class", schemaId: "factual_lookup", results: ok(4, "factual_lookup"), rows: () => [scalarRow("answer", ["Lyon", "Paris", "Rome", "Paris"])], tie: false },
  { name: "metric-2-2-tie", schemaId: "financial_valuation", results: ok(4, "financial_valuation"), rows: () => [row("m", "split", ["agrees", "disputes", "agrees", "disputes"].map((s, i) => derivedCell(SLOTS[i], s as ClaimCellStance, "metric")))], tie: false },
  { name: "scenario-1-1-tie", schemaId: "forecast_speculative", results: ok(2, "forecast_speculative"), rows: () => [row("s", "split", [derivedCell("chatgpt", "agrees", "scenario"), derivedCell("claude", "disputes", "scenario")])], tie: false },
  { name: "step-1-1-tie", schemaId: "procedural", results: ok(2, "procedural"), rows: () => [row("st", "split", [derivedCell("chatgpt", "agrees", "step"), derivedCell("claude", "disputes", "step")])], tie: false },
  {
    name: "missing-and-failed-slots",
    schemaId: "generic",
    results: () => [okResult("chatgpt"), okResult("claude"), failedResult("grok"), okResult("perplexity")],
    rows: () => [claimRow("r", "split", ["agrees", "disputes", null, null])],
    tie: true,
  },
  {
    name: "substituted-slot",
    schemaId: "generic",
    // The "grok" slot's response came from a substitute provider; trust is keyed by the logical slot, as today.
    results: () => [okResult("chatgpt"), okResult("claude"), okResult("grok", "generic", { latencyMs: 7 })],
    rows: () => [claimRow("r", "split", ["agrees", "disputes", "partial"])],
    tie: true,
  },
  {
    name: "duplicate-slot-cells",
    schemaId: "generic",
    results: ok(3),
    rows: () => [row("r", "split", [claimCell("chatgpt", "agrees"), claimCell("claude", "disputes"), claimCell("claude", "agrees")])],
    tie: false,
  },
  { name: "duplicate-result-slot", schemaId: "generic", results: () => [okResult("chatgpt"), okResult("claude"), okResult("claude")], rows: () => [claimRow("r", "split", ["agrees", "disputes"])], tie: false },
  { name: "cell-slot-not-in-results", schemaId: "generic", results: () => [okResult("chatgpt")], rows: () => [claimRow("r", "split", ["agrees", "disputes"])], tie: false },
  { name: "unknown-origin-tie", schemaId: "generic", results: ok(2), rows: () => [row("r", "split", [unknownCell("chatgpt", "agrees"), unknownCell("claude", "disputes")])], tie: false },
  { name: "mixed-origin-tie", schemaId: "generic", results: ok(2), rows: () => [row("r", "split", [claimCell("chatgpt", "agrees"), derivedCell("claude", "disputes", "metric")])], tie: false },
  {
    name: "claim-origin-but-backfilled",
    schemaId: "generic",
    results: ok(2),
    rows: () => [row("r", "split", [claimCell("chatgpt", "agrees"), { ...claimCell("claude", "disputes"), backfilled: true }])],
    tie: false,
  },
  {
    name: "inferred-without-backfill-flag",
    schemaId: "generic",
    results: ok(2),
    rows: () => [row("r", "split", [claimCell("chatgpt", "agrees"), { ...inferredCell("claude", "disputes"), backfilled: undefined }])],
    tie: false,
  },
  {
    name: "claim-cell-with-raw-value",
    schemaId: "generic",
    results: ok(2),
    rows: () => [row("r", "split", [claimCell("chatgpt", "agrees"), { ...claimCell("claude", "disputes"), raw: { label: "x", value: 1 } as any }])],
    tie: false,
  },
  { name: "unknown-stance-value", schemaId: "generic", results: ok(2), rows: () => [row("r", "split", [claimCell("chatgpt", "agrees"), { ...claimCell("claude", "disputes"), stance: "rejects" as any }])], tie: false },
  {
    name: "degraded-cap-transition",
    schemaId: "generic",
    // chatgpt degraded: legacy raw 0.3 + 0.35·1 + 0.35·1 = 1.0 > 0.75 (capped); after the tie raw 0.3 + 0 + 0.35 = 0.65.
    results: () => [degradedResult("chatgpt"), okResult("claude")],
    rows: () => [claimRow("r", "split", ["agrees", "disputes"])],
    tie: true,
  },
  {
    name: "degraded-cap-still-binding",
    schemaId: "generic",
    // chatgpt degraded with three untied consensus rows and one tie: raw 0.3 + 0.35·3/4 + 0.35 = 0.9125 > 0.75 still.
    results: () => [degradedResult("chatgpt"), okResult("claude")],
    rows: () => [claimRow("a", "consensus", ["agrees", "agrees"]), claimRow("b", "consensus", ["agrees", "agrees"]), claimRow("c", "consensus", ["agrees", "agrees"]), claimRow("r", "split", ["agrees", "disputes"])],
    tie: true,
  },
  {
    name: "run-964",
    schemaId: "procedural",
    results: ok(2, "procedural"),
    rows: () => [
      claimRow("c0", "single_source", ["agrees", null]),
      claimRow("c1", "split", ["partial", "disputes"]),
      row("step-1", "single_source", [derivedCell("chatgpt", "unclear", "step"), null]),
    ],
    tie: true,
  },
  {
    name: "run-964-reversed",
    schemaId: "procedural",
    results: () => [okResult("claude", "procedural"), okResult("chatgpt", "procedural")],
    rows: () => [
      row("c0", "single_source", [null, claimCell("chatgpt", "agrees")]),
      row("c1", "split", [claimCell("claude", "disputes"), claimCell("chatgpt", "partial")]),
      row("step-1", "single_source", [null, derivedCell("chatgpt", "unclear", "step")]),
    ],
    tie: true,
  },
  { name: "run-3811", schemaId: "procedural", results: () => [okResult("claude", "procedural"), okResult("chatgpt", "procedural")], rows: () => [scalarRow("answer", ["Turin", "rome"], ["claude", "chatgpt"])], tie: false },
  {
    name: "multi-row-mixed-run",
    schemaId: "generic",
    results: ok(4),
    rows: () => [
      claimRow("t1", "split", ["agrees", "disputes", "agrees", "disputes"]),
      claimRow("u1", "split", ["agrees", "agrees", "agrees", "disputes"]),
      row("m1", "split", ["agrees", "disputes", "agrees", "disputes"].map((s, i) => derivedCell(SLOTS[i], s as ClaimCellStance, "metric"))),
      claimRow("t2", "majority", ["agrees", "unclear", null, null]),
    ],
    tie: true,
  },
];

/** ListView's trust sort (sortRows, mode "trust"): stable descending by trustScore over results order. */
export function trustRank(summary: { perModel: { modelId: string; trustScore: number }[] }): string[] {
  return [...summary.perModel].sort((a, b) => b.trustScore - a.trustScore).map((m) => m.modelId);
}
