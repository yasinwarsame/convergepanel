/**
 * causal_explanation alignment/aggregation tests (Milestone 2).
 *
 * Covers: paraphrase merging within a category, NEVER merging across
 * categories (direct causes stay distinct from contributing factors),
 * distinct mechanisms staying separate, alternative explanations preserved,
 * confounder/unknown dedup, disputed interpretations always preserved
 * (never filtered by coverage — minority explanations survive), model
 * coverage math, source-backed aggregation, the central safeguard that
 * correlation-only output never becomes a causal conclusion (no
 * "evidenceStrength: strong" from repetition alone), and empty/malformed
 * input handling.
 */

import { buildCausalExplanationResult, CausalExplanationFields } from "@/lib/adaptiveSchema/causalAlignment";
import { ModelId } from "@/lib/types";

function fields(overrides: Partial<CausalExplanationFields> = {}): CausalExplanationFields {
  return {
    directAnswer: "",
    directCauses: [],
    contributingFactors: [],
    triggers: [],
    amplifiers: [],
    alternativeExplanations: [],
    causalLinks: [],
    confounders: [],
    disputedInterpretations: [],
    unknowns: [],
    testsOrEvidenceNeeded: [],
    sources: [],
    ...overrides,
  };
}

function perModel(entries: [string, CausalExplanationFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

describe("buildCausalExplanationResult — paraphrase merging within a category", () => {
  it("merges paraphrased direct causes into one factor", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ directCauses: ["Rising demand for goods outpacing supply"] })],
        ["claude", fields({ directCauses: ["Demand for goods rising faster than supply"] })],
      ]),
      2
    );
    const directCauses = result.factors.filter((f) => f.category === "direct_cause");
    expect(directCauses).toHaveLength(1);
    expect(directCauses[0].coverageCount).toBe(2);
  });

  it("keeps distinct causes separate", () => {
    const result = buildCausalExplanationResult(
      perModel([["chatgpt", fields({ directCauses: ["Rising demand", "Supply chain disruption"] })]]),
      1
    );
    expect(result.factors.filter((f) => f.category === "direct_cause")).toHaveLength(2);
  });
});

describe("buildCausalExplanationResult — category isolation", () => {
  it("never merges a direct cause with a contributing factor even when the text is identical", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ directCauses: ["Rising interest rates"] })],
        ["claude", fields({ contributingFactors: ["Rising interest rates"] })],
      ]),
      2
    );
    const directCauses = result.factors.filter((f) => f.category === "direct_cause");
    const contributing = result.factors.filter((f) => f.category === "contributing_factor");
    expect(directCauses).toHaveLength(1);
    expect(contributing).toHaveLength(1);
    expect(directCauses[0].coverageCount).toBe(1);
    expect(contributing[0].coverageCount).toBe(1);
  });
});

describe("buildCausalExplanationResult — mechanisms (causal chain)", () => {
  it("merges paraphrased mechanisms describing the same causal link", () => {
    const result = buildCausalExplanationResult(
      perModel([
        [
          "chatgpt",
          fields({
            causalLinks: ["Higher interest rates raise borrowing costs, which reduces mortgage demand and cools home prices."],
          }),
        ],
        [
          "claude",
          fields({
            causalLinks: ["Raising interest rates increases the cost of borrowing, reducing mortgage demand and cooling home prices."],
          }),
        ],
      ]),
      2
    );
    expect(result.causalChain).toHaveLength(1);
    expect(result.causalChain[0].coverageCount).toBe(2);
  });

  it("keeps distinct mechanisms separate", () => {
    const result = buildCausalExplanationResult(
      perModel([
        [
          "chatgpt",
          fields({
            causalLinks: [
              "Higher interest rates raise borrowing costs, which reduces mortgage demand and cools home prices.",
              "Reduced immigration shrinks the labor pool, which drives wages up across the sector.",
            ],
          }),
        ],
      ]),
      1
    );
    expect(result.causalChain).toHaveLength(2);
  });
});

describe("buildCausalExplanationResult — alternative explanations and disputed interpretations", () => {
  it("preserves alternative explanations as their own category", () => {
    const result = buildCausalExplanationResult(
      perModel([["chatgpt", fields({ directCauses: ["Rising demand"], alternativeExplanations: ["Currency devaluation alone"] })]]),
      1
    );
    expect(result.factors.some((f) => f.category === "alternative_explanation" && f.label === "Currency devaluation alone")).toBe(true);
  });

  it("preserves a minority disputed interpretation even when only one model raised it", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ disputedInterpretations: ["Some economists argue this is purely a monetary phenomenon."] })],
        ["claude", fields({})],
        ["grok", fields({})],
        ["perplexity", fields({})],
      ]),
      4
    );
    expect(result.disputedInterpretations).toHaveLength(1);
    expect(result.disputedInterpretations[0].supportingModels).toEqual(["chatgpt"]);
  });

  it("groups disputed interpretations raised by multiple models by supportingModels, without discarding any", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ disputedInterpretations: ["Some argue this is a purely monetary phenomenon."] })],
        ["claude", fields({ disputedInterpretations: ["Others argue this is entirely a supply-side story."] })],
      ]),
      2
    );
    expect(result.disputedInterpretations).toHaveLength(2);
  });
});

describe("buildCausalExplanationResult — confounders/unknowns dedup", () => {
  it("deduplicates near-duplicate confounders and unknowns across models", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ confounders: ["Seasonal effects could explain part of this"], unknowns: ["Long-term persistence is unclear"] })],
        ["claude", fields({ confounders: ["Seasonal effects might explain part of this"], unknowns: ["Whether this persists long-term is unclear"] })],
      ]),
      2
    );
    expect(result.confounders).toHaveLength(1);
    expect(result.unknowns).toHaveLength(1);
  });
});

describe("buildCausalExplanationResult — model coverage and source-backed aggregation", () => {
  it("computes coverageRatio from the full attempted model count", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ directCauses: ["Rising demand"] })],
        ["claude", fields({ directCauses: ["Rising demand"] })],
      ]),
      4
    );
    const cause = result.factors.find((f) => f.category === "direct_cause")!;
    expect(cause.coverageCount).toBe(2);
    expect(cause.totalModels).toBe(4);
    expect(cause.coverageRatio).toBe(0.5);
  });

  it("marks a factor sourceBacked when a contributing model cited any source", () => {
    const result = buildCausalExplanationResult(
      perModel([["chatgpt", fields({ directCauses: ["Rising demand"], sources: ["Federal Reserve report"] })]]),
      1
    );
    expect(result.factors[0].sourceBacked).toBe(true);
    expect(result.sourceBacked).toBe(true);
  });

  it("is not sourceBacked when no contributing model cited a source", () => {
    const result = buildCausalExplanationResult(perModel([["chatgpt", fields({ directCauses: ["Rising demand"] })]]), 1);
    expect(result.factors[0].sourceBacked).toBe(false);
    expect(result.sourceBacked).toBe(false);
  });
});

describe("buildCausalExplanationResult — correlation-only output never becomes a causal conclusion", () => {
  it("never assigns 'strong'/'moderate'/'weak' evidenceStrength purely from model repetition — five models agreeing stays 'unknown', not upgraded to a stronger tier", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ directCauses: ["Rising demand"] })],
        ["claude", fields({ directCauses: ["Rising demand"] })],
        ["grok", fields({ directCauses: ["Rising demand"] })],
        ["perplexity", fields({ directCauses: ["Rising demand"] })],
        ["gemini", fields({ directCauses: ["Rising demand"] })],
      ]),
      5
    );
    const cause = result.factors.find((f) => f.category === "direct_cause")!;
    expect(cause.coverageCount).toBe(5);
    expect(cause.evidenceStrength).toBe("unknown");
  });

  it("does NOT flag a factor 'contested' merely because a disputed interpretation happens to share a few words with it — avoids the 'broad vocabulary' false-positive trap", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ directCauses: ["Rising demand"] })],
        ["claude", fields({ disputedInterpretations: ["Some claim rising costs demand immediate government action, which is controversial"] })],
      ]),
      2
    );
    const cause = result.factors.find((f) => f.category === "direct_cause")!;
    expect(cause.evidenceStrength).toBe("unknown");
  });

  it("marks a factor 'contested' when models disagree on its category (cause vs alternative explanation)", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ directCauses: ["Currency devaluation drove this"] })],
        ["claude", fields({ alternativeExplanations: ["Currency devaluation drove this"] })],
      ]),
      2
    );
    const cause = result.factors.find((f) => f.category === "direct_cause")!;
    const alt = result.factors.find((f) => f.category === "alternative_explanation")!;
    expect(cause.evidenceStrength).toBe("contested");
    expect(alt.evidenceStrength).toBe("contested");
  });

  it("never computes an overall certainty/confidence score anywhere in the result", () => {
    const result = buildCausalExplanationResult(perModel([["chatgpt", fields({ directCauses: ["Rising demand"] })]]), 1) as any;
    expect(result.certaintyScore).toBeUndefined();
    expect(result.confidence).toBeUndefined();
    expect(result.gate).toBeUndefined();
  });
});

describe("buildCausalExplanationResult — empty and malformed input", () => {
  it("never throws and returns an empty result when no model produced usable data", () => {
    const result = buildCausalExplanationResult([], 2);
    expect(result.directAnswer).toBe("");
    expect(result.factors).toEqual([]);
    expect(result.causalChain).toEqual([]);
    expect(result.disputedInterpretations).toEqual([]);
    expect(result.sourceBacked).toBe(false);
    expect(result.totalModels).toBe(2);
  });

  it("handles malformed (non-array) field values safely via extractCausalFields upstream, and empty arrays here", () => {
    const result = buildCausalExplanationResult(perModel([["chatgpt", fields()]]), 1);
    expect(result.factors).toEqual([]);
    expect(result.causalChain).toEqual([]);
    expect(result.confounders).toEqual([]);
  });
});
