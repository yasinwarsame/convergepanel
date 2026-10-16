/**
 * Consensus Integrity Tests (D1–D7, D11)
 *
 * The limited_coverage boundary (assessedPositions × 2 ≤ dispatchedPanelSize),
 * that it only ever relabels consensus/majority, that it never moves
 * certainty or the gate, the contested axis (marked / assessed), field-origin
 * classification, the exhaustive status rank/label maps, and the canonical
 * contested wording.
 */

import {
  CLAIM_FIELD_CLASS,
  CONSENSUS_STATUS_LABEL,
  CONSENSUS_STATUS_RANK,
  applyConsensusIntegrity,
  assessedPositionCount,
  claimFieldClass,
  computeContestedDimensions,
  consensusStatusLabel,
  consensusStatusRank,
  describeContested,
  describeCoverage,
  isLimitedCoverage,
} from "@/lib/adaptiveSchema/consensusIntegrity";
import { scoreAgreement } from "@/lib/adaptiveSchema/agreementComparators";
import { buildComparisonMatrixResult } from "@/lib/adaptiveSchema/comparisonAlignment";
import { computeRunCertainty, scoreClaimCertainty } from "@/lib/adaptiveSchema/scoring";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import {
  ALIGNED_CLAIM_STATUSES,
  AlignedCellOrigin,
  AlignedClaim,
  AlignedClaimCell,
  ClaimCellStance,
  ClaimConfidence,
  QueryType,
} from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

const MODELS: ModelId[] = ["chatgpt", "claude", "gemini", "grok", "perplexity", "deepseek"] as ModelId[];

const CLAIM_ORIGIN: AlignedCellOrigin = { kind: "claim", field: "keyClaims", fieldClass: "unclassified" };

function cell(
  modelId: ModelId,
  stance: ClaimCellStance,
  overrides: Partial<AlignedClaimCell> = {}
): AlignedClaimCell {
  return { modelId, stance, rawStance: "asserts", confidence: "settled", origin: CLAIM_ORIGIN, excerpt: `${modelId} says`, ...overrides };
}

/** A row over `panel` dispatched models: the given stances fill the first columns, the rest are silent (null). */
function rowOf(stances: (ClaimCellStance | null)[], panel: number, overrides: Partial<AlignedClaim> = {}): AlignedClaim {
  const cells = MODELS.slice(0, panel).map((m, i) => (stances[i] ? cell(m, stances[i]!) : null));
  return { id: "row", claimText: "Some proposition", cells, agreementScore: 0, certaintyScore: 0, status: "single_source", ...overrides };
}

/** The production order: comparator, then the coverage boundary. */
function classify(stances: (ClaimCellStance | null)[], panel: number, schemaId: QueryType = "generic"): AlignedClaim {
  return applyConsensusIntegrity(scoreAgreement(schemaId, [rowOf(stances, panel)]), panel)[0];
}

describe("isLimitedCoverage: assessedPositions × 2 ≤ dispatchedPanelSize", () => {
  it.each([
    [2, 5, true],
    [2, 4, true],
    [3, 5, false],
    [1, 2, true],
    [1, 3, true],
    [3, 6, true],
    [4, 6, false],
    [5, 5, false],
    [4, 4, false],
    [2, 2, false],
  ])("%i assessed of %i dispatched → limited=%s", (assessed, panel, expected) => {
    expect(isLimitedCoverage(assessed, panel)).toBe(expected);
  });

  it.each([0, -1, 2.5, NaN, Infinity])("fails closed (limited) for a panel size that isn't a positive integer: %s", (panel) => {
    expect(isLimitedCoverage(5, panel)).toBe(true);
  });
});

describe("assessedPositionCount", () => {
  it("counts non-null cells whose stance is not unclear", () => {
    expect(assessedPositionCount(rowOf(["agrees", "partial", "disputes", "unclear", null], 5))).toBe(3);
  });
});

describe("applyConsensusIntegrity: limited_coverage at the classification boundary", () => {
  it("2 of 5 aligned (3 silent) → limited_coverage, not consensus", () => {
    const base = scoreAgreement("generic", [rowOf(["agrees", "agrees", null, null, null], 5)])[0];
    expect(base.status).toBe("consensus"); // the legacy overstatement
    expect(classify(["agrees", "agrees", null, null, null], 5).status).toBe("limited_coverage");
  });

  it("2 of 4 aligned → limited_coverage", () => {
    expect(classify(["agrees", "agrees", null, null], 4).status).toBe("limited_coverage");
  });

  it("3 of 5 aligned → stays consensus", () => {
    expect(classify(["agrees", "agrees", "agrees", null, null], 5).status).toBe("consensus");
  });

  it("3 of 5 majority (one partial) → stays majority", () => {
    // partial weighs 0.5: (1 + 1 + 0.5) / 3 = 0.83 < 0.85 → majority, not consensus.
    expect(scoreAgreement("generic", [rowOf(["agrees", "agrees", "partial", null, null], 5)])[0].status).toBe("majority");
    expect(classify(["agrees", "agrees", "partial", null, null], 5).status).toBe("majority");
  });

  it("2 of 5 majority (one partial) → limited_coverage", () => {
    expect(classify(["agrees", "partial", null, null, null], 5).status).toBe("limited_coverage");
  });

  it("1 of 2 (the other unclear) → majority becomes limited_coverage", () => {
    const base = scoreAgreement("generic", [rowOf(["agrees", "unclear"], 2)])[0];
    expect(base.status).toBe("majority");
    expect(classify(["agrees", "unclear"], 2).status).toBe("limited_coverage");
  });

  it("1 of 3 (two unclear) → majority becomes limited_coverage", () => {
    const base = scoreAgreement("generic", [rowOf(["agrees", "unclear", "unclear"], 3)])[0];
    expect(base.status).toBe("majority");
    expect(classify(["agrees", "unclear", "unclear"], 3).status).toBe("limited_coverage");
  });

  it("full coverage (5 of 5) → stays consensus", () => {
    expect(classify(["agrees", "agrees", "agrees", "agrees", "agrees"], 5).status).toBe("consensus");
  });

  it("measures against the dispatched panel, not the cells that are present: same 2 agreeing cells, 3 vs 5 dispatched", () => {
    // Same two agreeing cells; only the dispatched panel size differs.
    const twoCells = scoreAgreement("generic", [rowOf(["agrees", "agrees"], 2)]);
    expect(applyConsensusIntegrity(twoCells, 3)[0].status).toBe("consensus");
    expect(applyConsensusIntegrity(twoCells, 4)[0].status).toBe("limited_coverage");
    expect(applyConsensusIntegrity(twoCells, 5)[0].status).toBe("limited_coverage");
  });

  it("never relabels split: 1 agree / 1 dispute of 5 stays split", () => {
    expect(classify(["agrees", "disputes", null, null, null], 5).status).toBe("split");
  });

  it("never relabels split on a contested_empirical row with identical camps (the old split→majority path)", () => {
    const camps = [
      { label: "A", position: "a" },
      { label: "B", position: "b" },
    ];
    const r = rowOf(["agrees", "disputes", null, null, null], 5);
    r.cells[0] = { ...r.cells[0]!, camps };
    r.cells[1] = { ...r.cells[1]!, camps };
    const out = applyConsensusIntegrity(scoreAgreement("contested_empirical", [r]), 5)[0];
    expect(out.status).toBe("split");
  });

  it("never relabels single_source", () => {
    expect(classify(["agrees", null, null, null, null], 5).status).toBe("single_source");
  });

  it("never relabels a jurisdiction_mismatch split or a factual_lookup split", () => {
    const legal = applyConsensusIntegrity(
      scoreAgreement("legal_regulatory", [rowOf(["agrees", "disputes", null, null, null], 5, { id: "jurisdiction" })]),
      5
    )[0];
    expect(legal.status).toBe("split");
    expect(legal.disagreementType).toBe("jurisdiction_mismatch");
    expect(classify(["agrees", "disputes", null, null], 4, "factual_lookup").status).toBe("split");
  });

  it("changes only status (and adds contested): cells, agreementScore and certaintyScore pass through untouched", () => {
    const scored = scoreClaimCertainty(scoreAgreement("generic", [rowOf(["agrees", "agrees", null, null, null], 5)]), 5);
    const [out] = applyConsensusIntegrity(scored, 5);
    expect(out.cells).toBe(scored[0].cells);
    expect(out.agreementScore).toBe(scored[0].agreementScore);
    expect(out.certaintyScore).toBe(scored[0].certaintyScore);
    const { status: _a, contested: _b, ...restOut } = out;
    const { status: _c, contested: _d, ...restIn } = scored[0];
    expect(restOut).toEqual(restIn);
  });

  it("is idempotent", () => {
    const once = applyConsensusIntegrity(scoreAgreement("generic", [rowOf(["agrees", "agrees", null, null, null], 5)]), 5);
    expect(applyConsensusIntegrity(once, 5)).toEqual(once);
  });
});

// ─── Certainty + gate invariance (owner non-negotiable) ───────────────────

/** Deterministic PRNG so the property corpus is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STANCES: (ClaimCellStance | null)[] = ["agrees", "agrees", "partial", "disputes", "unclear", null, null];
const CONFIDENCES: (ClaimConfidence | null)[] = ["settled", "majority_view", "contested", "speculative", null];

function randomRows(rand: () => number, panel: number): AlignedClaim[] {
  const n = 1 + Math.floor(rand() * 7);
  return Array.from({ length: n }, (_, ri) => {
    const cells = MODELS.slice(0, panel).map((m) => {
      const stance = STANCES[Math.floor(rand() * STANCES.length)];
      if (!stance) return null;
      return cell(m, stance, {
        confidence: CONFIDENCES[Math.floor(rand() * CONFIDENCES.length)],
        ...(rand() < 0.3 ? { camps: [{ label: rand() < 0.5 ? "A" : "B", position: "p" }] } : {}),
      });
    });
    return { id: `r${ri}`, claimText: `claim ${ri}`, cells, agreementScore: 0, certaintyScore: 0, status: "single_source" as const };
  });
}

describe("certainty and gate are unchanged by the coverage classification (property, 3,000 random runs)", () => {
  const schemaIds = Object.keys(SCHEMA_REGISTRY) as QueryType[];

  it("for every schema and panel size 1–6, run certainty, every row certainty and the gate are identical with and without applyConsensusIntegrity", () => {
    const rand = mulberry32(20261016);
    let limitedSeen = 0;
    for (let i = 0; i < 3000; i++) {
      const schemaId = schemaIds[i % schemaIds.length];
      const panel = 1 + Math.floor(rand() * 6);
      const agreed = scoreAgreement(schemaId, randomRows(rand, panel));

      const without = scoreClaimCertainty(agreed, panel);
      const withIntegrity = scoreClaimCertainty(applyConsensusIntegrity(agreed, panel), panel);
      limitedSeen += withIntegrity.filter((r) => r.status === "limited_coverage").length;

      expect(withIntegrity.map((r) => r.certaintyScore)).toEqual(without.map((r) => r.certaintyScore));
      const certWithout = computeRunCertainty(without, schemaId);
      const certWith = computeRunCertainty(withIntegrity, schemaId);
      expect(certWith).toBe(certWithout);

      const gateWithout = computeAdaptiveGate(without, certWithout, schemaId);
      const gateWith = computeAdaptiveGate(withIntegrity, certWith, schemaId);
      expect(gateWith.status).toBe(gateWithout.status);
      expect(gateWith.loadBearingSplitCount).toBe(gateWithout.loadBearingSplitCount);
    }
    // The corpus must actually exercise the relabel, or the property is vacuous.
    expect(limitedSeen).toBeGreaterThan(500);
  });
});

// ─── Contested axis ───────────────────────────────────────────────────────

describe("computeContestedDimensions (marked / assessed)", () => {
  const disputed: AlignedCellOrigin = { kind: "claim", field: "disputedClaims", fieldClass: "disputed" };
  const settled: AlignedCellOrigin = { kind: "claim", field: "settledClaims", fieldClass: "settled" };

  function row(cells: (AlignedClaimCell | null)[]): AlignedClaim {
    return { id: "r", claimText: "Underlying claim", cells, agreementScore: 0, certaintyScore: 0, status: "consensus" };
  }

  it("neither: settled-field claims with settled confidence and no camps → marked 0 of assessed 3", () => {
    const r = row([0, 1, 2].map((i) => cell(MODELS[i], "agrees", { origin: settled })));
    expect(computeContestedDimensions(r)).toEqual({ marked: 0, assessed: 3 });
    expect(describeContested({ ...r, contested: computeContestedDimensions(r) })).toBeNull();
  });

  it("marked by field origin alone: disputed-field claims count even with a non-contested confidence", () => {
    const r = row([0, 1].map((i) => cell(MODELS[i], "agrees", { origin: disputed, confidence: "majority_view" })));
    expect(computeContestedDimensions(r)).toEqual({ marked: 2, assessed: 2 });
  });

  it("marked by confidence alone: a contested confidence in an unclassified field", () => {
    const r = row([cell(MODELS[0], "agrees", { confidence: "contested" }), cell(MODELS[1], "agrees")]);
    expect(computeContestedDimensions(r)).toEqual({ marked: 1, assessed: 2 });
  });

  it("marked by camps alone", () => {
    const r = row([cell(MODELS[0], "agrees", { camps: [{ label: "A", position: "a" }] }), cell(MODELS[1], "agrees")]);
    expect(computeContestedDimensions(r)).toEqual({ marked: 1, assessed: 2 });
  });

  it("a contested mark on a cell that is not the model's own claim is not assessed: inferred and field-derived cells never count", () => {
    const inferred = cell(MODELS[0], "agrees", { origin: { kind: "inferred" }, confidence: null, backfilled: true });
    // Even a (malformed) contested confidence on an inferred cell is ignored.
    const inferredWithMark = cell(MODELS[1], "agrees", { origin: { kind: "inferred" }, confidence: "contested" });
    const field = cell(MODELS[2], "agrees", { origin: { kind: "field_derived", fieldType: "metric" }, confidence: null });
    expect(computeContestedDimensions(row([inferred, inferredWithMark, field]))).toBeUndefined();

    const mixed = row([cell(MODELS[0], "agrees", { origin: disputed }), inferredWithMark, null]);
    expect(computeContestedDimensions(mixed)).toEqual({ marked: 1, assessed: 1 });
  });

  it("legacy cells without origin (persisted before this change) are never counted", () => {
    const { origin: _o, ...legacy } = cell(MODELS[0], "agrees", { confidence: "contested" });
    expect(computeContestedDimensions(row([legacy as AlignedClaimCell]))).toBeUndefined();
  });

  it("applyConsensusIntegrity attaches contested only when some model listed the claim itself", () => {
    const [withClaim] = applyConsensusIntegrity([row([cell(MODELS[0], "agrees", { origin: disputed }), cell(MODELS[1], "agrees", { origin: disputed })])], 2);
    expect(withClaim.contested).toEqual({ marked: 2, assessed: 2 });
    const [fieldOnly] = applyConsensusIntegrity(
      [row([cell(MODELS[0], "agrees", { origin: { kind: "field_derived", fieldType: "scalar" }, confidence: null }), cell(MODELS[1], "agrees", { origin: { kind: "field_derived", fieldType: "scalar" }, confidence: null })])],
      2
    );
    expect("contested" in fieldOnly).toBe(false);
  });

  it("the contested axis never changes status", () => {
    const allMarked = row([0, 1, 2, 3, 4].map((i) => cell(MODELS[i], "agrees", { origin: disputed })));
    const [out] = applyConsensusIntegrity(scoreAgreement("contested_empirical", [allMarked]), 5);
    expect(out.status).toBe("consensus");
    expect(out.contested).toEqual({ marked: 5, assessed: 5 });
  });
});

describe("describeContested / describeCoverage: canonical wording", () => {
  function withContested(marked: number, assessed: number, positions: number): AlignedClaim {
    const cells = MODELS.slice(0, 5).map((m, i) => (i < positions ? cell(m, "agrees") : null));
    return { id: "r", claimText: "X", cells, agreementScore: 1, certaintyScore: 1, status: "consensus", contested: { marked, assessed } };
  }

  it("'all mark the underlying claim contested' when every model with a position listed and marked it", () => {
    expect(describeContested(withContested(5, 5, 5))).toBe("all mark the underlying claim contested");
  });

  it("counts when only some marked it", () => {
    expect(describeContested(withContested(4, 5, 5))).toBe("4 of 5 models that listed this claim mark it contested");
  });

  it("counts (never 'all') when some positions were inferred rather than listed", () => {
    expect(describeContested(withContested(3, 3, 5))).toBe("3 of 3 models that listed this claim mark it contested");
  });

  it("singular", () => {
    expect(describeContested(withContested(1, 1, 2))).toBe("1 of 1 model that listed this claim mark it contested");
  });

  it("null when nothing is marked, or the row has no contested axis", () => {
    expect(describeContested(withContested(0, 5, 5))).toBeNull();
    const { contested: _c, ...noAxis } = withContested(5, 5, 5);
    expect(describeContested(noAxis as AlignedClaim)).toBeNull();
  });

  it("is a pure function of the structured input", () => {
    const r = withContested(4, 5, 5);
    expect(describeContested(r)).toBe(describeContested(JSON.parse(JSON.stringify(r))));
  });

  it("describeCoverage states positions against the dispatched panel", () => {
    expect(describeCoverage(rowOf(["agrees", "agrees", "unclear", null, null], 5), 5)).toBe("2 of 5 dispatched models took a position");
  });
});

// ─── Field origin ─────────────────────────────────────────────────────────

describe("claimFieldClass", () => {
  it("classifies contested_empirical's two claim fields and nothing else", () => {
    expect(claimFieldClass("contested_empirical", "settledClaims")).toBe("settled");
    expect(claimFieldClass("contested_empirical", "disputedClaims")).toBe("disputed");
    expect(claimFieldClass("legal_regulatory", "unsettledIssues")).toBe("unclassified");
    expect(claimFieldClass("generic", "keyClaims")).toBe("unclassified");
    expect(claimFieldClass("medical_health", "evidenceByTier")).toBe("unclassified");
    expect(claimFieldClass("generic", "disputedClaims")).toBe("unclassified");
  });

  it("every classified field is a real claim[] field of its schema", () => {
    for (const [schemaId, fields] of Object.entries(CLAIM_FIELD_CLASS)) {
      const claimFields = SCHEMA_REGISTRY[schemaId as QueryType].fields.filter((f) => f.type === "claim[]").map((f) => f.key);
      for (const field of Object.keys(fields!)) expect(claimFields).toContain(field);
    }
  });
});

// ─── Exhaustive status presentation ──────────────────────────────────────

describe("status rank and label maps", () => {
  it("rank every status exactly once, with distinct integer ranks in ALIGNED_CLAIM_STATUSES order", () => {
    expect(Object.keys(CONSENSUS_STATUS_RANK).sort()).toEqual([...ALIGNED_CLAIM_STATUSES].sort());
    const ranks = ALIGNED_CLAIM_STATUSES.map((s) => CONSENSUS_STATUS_RANK[s]);
    for (const r of ranks) expect(Number.isInteger(r)).toBe(true);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it("label every status", () => {
    expect(Object.keys(CONSENSUS_STATUS_LABEL).sort()).toEqual([...ALIGNED_CLAIM_STATUSES].sort());
    for (const s of ALIGNED_CLAIM_STATUSES) expect(CONSENSUS_STATUS_LABEL[s].length).toBeGreaterThan(0);
    expect(consensusStatusLabel("limited_coverage")).toBe("limited coverage");
  });

  it("limited_coverage ranks below majority and above split", () => {
    expect(consensusStatusRank("majority")).toBeLessThan(consensusStatusRank("limited_coverage"));
    expect(consensusStatusRank("limited_coverage")).toBeLessThan(consensusStatusRank("split"));
  });

  it("an unknown persisted value ranks last as a finite number, never NaN, and is labelled as-is", () => {
    const rank = consensusStatusRank("some_future_status");
    expect(Number.isFinite(rank)).toBe(true);
    for (const s of ALIGNED_CLAIM_STATUSES) expect(rank).toBeGreaterThan(CONSENSUS_STATUS_RANK[s]);
    expect(consensusStatusLabel("some_future_status")).toBe("some_future_status");
  });
});

// ─── comparison_matrix isolation (D6) ────────────────────────────────────


describe("comparison_matrix cells keep their own four-value agreement", () => {
  it("2 agreeing models on a cell is still the comparison's own 'consensus' — limited_coverage never reaches comparison cells", () => {
    const result = buildComparisonMatrixResult([
      { modelId: "chatgpt" as ModelId, cells: [{ subject: "Phone A", attribute: "Price", value: "$799" }] },
      { modelId: "claude" as ModelId, cells: [{ subject: "Phone A", attribute: "Price", value: "$799" }] },
      { modelId: "grok" as ModelId, cells: [] },
      { modelId: "gemini" as ModelId, cells: [] },
      { modelId: "perplexity" as ModelId, cells: [] },
    ]);
    expect(result.cells.length).toBeGreaterThan(0);
    for (const c of result.cells) expect(["consensus", "majority", "split", "single_source"]).toContain(c.agreement);
    expect(result.cells[0].agreement).toBe("consensus");
  });
});

describe("legacy status text is unchanged", () => {
  it("the four pre-existing statuses are labelled with their exact raw value", () => {
    for (const s of ["consensus", "majority", "split", "single_source"] as const) expect(CONSENSUS_STATUS_LABEL[s]).toBe(s);
  });
});
