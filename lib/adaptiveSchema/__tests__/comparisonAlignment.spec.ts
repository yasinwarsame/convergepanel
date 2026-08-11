/**
 * comparison_matrix alignment/aggregation tests (Milestone 2).
 *
 * Covers: independent subject/attribute clustering (including the
 * deliberately strict subject-axis guard against subset merges like
 * "iPhone 15" vs "iPhone 15 Pro"), coverage math, cell agreement
 * (consensus/majority/split/single_source), consensusValue selection,
 * verdict tallying, the low-confidence bucket (and its "only applies when
 * totalModels > 2" refinement, shared with ranked_enumeration), never
 * padding missing cells, and empty input.
 */

import { buildComparisonMatrixResult } from "@/lib/adaptiveSchema/comparisonAlignment";
import { ComparisonCell } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function cell(overrides: Partial<ComparisonCell> & Pick<ComparisonCell, "subject" | "attribute" | "value">): ComparisonCell {
  return { ...overrides };
}

function perModel(entries: [string, ComparisonCell[]][]) {
  return entries.map(([modelId, cells]) => ({ modelId: modelId as ModelId, cells }));
}

describe("buildComparisonMatrixResult — subject clustering", () => {
  it("merges a pure formatting variant (missing space) into one subject", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "iPhone 15", attribute: "Price", value: "$799" })]],
        ["claude", [cell({ subject: "iPhone15", attribute: "Price", value: "$799" })]],
      ])
    );
    expect(result.subjects).toHaveLength(1);
    expect(result.subjects[0].coverageCount).toBe(2);
  });

  it("does NOT merge a genuinely different (superset) product name — 'iPhone 15' and 'iPhone 15 Pro' stay distinct subjects", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "iPhone 15", attribute: "Price", value: "$799" })]],
        ["claude", [cell({ subject: "iPhone 15 Pro", attribute: "Price", value: "$999" })]],
      ])
    );
    const labels = [...result.subjects, ...result.lowConfidenceSubjects].map((s) => s.label).sort();
    expect(labels).toEqual(["iPhone 15", "iPhone 15 Pro"]);
  });

  it("merges pure word-reordering into one subject", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "Tesla Model 3", attribute: "Range", value: "272 miles" })]],
        ["claude", [cell({ subject: "Model 3 Tesla", attribute: "Range", value: "272 miles" })]],
      ])
    );
    expect(result.subjects).toHaveLength(1);
  });
});

describe("buildComparisonMatrixResult — attribute clustering", () => {
  it("merges a subset attribute paraphrase ('battery' into 'battery life')", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Battery life", value: "20h" })]],
        ["claude", [cell({ subject: "X", attribute: "Battery", value: "20h" })]],
      ])
    );
    expect(result.attributes).toHaveLength(1);
  });

  it("keeps genuinely distinct attributes separate", () => {
    const result = buildComparisonMatrixResult(
      perModel([["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" }), cell({ subject: "X", attribute: "Weight", value: "1kg" })]]])
    );
    const labels = [...result.attributes, ...result.lowConfidenceAttributes].map((a) => a.label).sort();
    expect(labels).toEqual(["Price", "Weight"]);
  });
});

describe("buildComparisonMatrixResult — cell agreement", () => {
  it("is 'consensus' when every covering model gives a near-identical value", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$799" })]],
        ["claude", [cell({ subject: "X", attribute: "Price", value: "$799" })]],
        ["grok", [cell({ subject: "X", attribute: "Price", value: "$799" })]],
      ])
    );
    const c = result.cells[0];
    expect(c.agreement).toBe("consensus");
    expect(c.consensusValue).toBe("$799");
    expect(c.coverageCount).toBe(3);
  });

  it("is 'majority' when more than half agree but not all", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$799" })]],
        ["claude", [cell({ subject: "X", attribute: "Price", value: "$799" })]],
        ["grok", [cell({ subject: "X", attribute: "Price", value: "$899, on sale" })]],
      ])
    );
    const c = result.cells[0];
    expect(c.agreement).toBe("majority");
    expect(c.consensusValue).toBe("$799");
  });

  it("is 'split' when models genuinely disagree with no majority cluster", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Verdict", value: "Best overall choice" })]],
        ["claude", [cell({ subject: "X", attribute: "Verdict", value: "Not recommended at all" })]],
      ])
    );
    const c = result.cells[0];
    expect(c.agreement).toBe("split");
    expect(c.consensusValue).toBeUndefined();
    expect(Object.keys(c.valuesByModel)).toHaveLength(2);
  });

  it("is 'single_source' when only one model covers the cell", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$799" })]],
        ["claude", []],
      ])
    );
    const c = result.cells[0];
    expect(c.agreement).toBe("single_source");
    expect(c.coverageCount).toBe(1);
  });
});

describe("buildComparisonMatrixResult — verdict tallying", () => {
  it("tallies verdicts across contributing models", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$799", verdict: "better" })]],
        ["claude", [cell({ subject: "X", attribute: "Price", value: "$799", verdict: "better" })]],
        ["grok", [cell({ subject: "X", attribute: "Price", value: "$899", verdict: "worse" })]],
      ])
    );
    expect(result.cells[0].verdictTally).toEqual({ better: 2, worse: 1 });
  });

  it("omits verdictTally when no model supplied a verdict", () => {
    const result = buildComparisonMatrixResult(perModel([["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$799" })]]]));
    expect(result.cells[0].verdictTally).toBeUndefined();
  });
});

describe("buildComparisonMatrixResult — low-confidence bucket", () => {
  it("moves subjects covered by only 1-2 models into lowConfidenceSubjects when the panel has more than 2 models", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "Popular", attribute: "Price", value: "$1" }), cell({ subject: "Rare", attribute: "Price", value: "$2" })]],
        ["claude", [cell({ subject: "Popular", attribute: "Price", value: "$1" })]],
        ["grok", [cell({ subject: "Popular", attribute: "Price", value: "$1" })]],
        ["perplexity", [cell({ subject: "Popular", attribute: "Price", value: "$1" })]],
      ])
    );
    expect(result.subjects.map((s) => s.label)).toEqual(["Popular"]);
    expect(result.lowConfidenceSubjects.map((s) => s.label)).toEqual(["Rare"]);
  });

  it("does NOT apply the low-confidence split when the whole panel only has 2 models", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" })]],
        ["claude", [cell({ subject: "X", attribute: "Price", value: "$1" })]],
      ])
    );
    expect(result.subjects.map((s) => s.label)).toEqual(["X"]);
    expect(result.lowConfidenceSubjects).toEqual([]);
  });
});

describe("buildComparisonMatrixResult — missing cells (never padded)", () => {
  it("only includes subject×attribute combinations at least one model actually populated", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" })]],
        ["claude", [cell({ subject: "Y", attribute: "Weight", value: "1kg" })]],
      ])
    );
    // 2 subjects x 2 attributes = 4 possible combinations, but only 2 were ever populated.
    expect(result.cells).toHaveLength(2);
  });
});

describe("buildComparisonMatrixResult — sorting", () => {
  it("sorts subjects and attributes by coverage descending", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "A", attribute: "P", value: "1" }), cell({ subject: "B", attribute: "P", value: "2" })]],
        ["claude", [cell({ subject: "B", attribute: "P", value: "2" })]],
      ])
    );
    expect(result.subjects.map((s) => s.label)).toEqual(["B", "A"]);
  });
});

describe("buildComparisonMatrixResult — empty input", () => {
  it("never throws and returns an empty result when no model produced usable cells", () => {
    const result = buildComparisonMatrixResult(perModel([["chatgpt", []], ["claude", []]]));
    expect(result.subjects).toEqual([]);
    expect(result.lowConfidenceSubjects).toEqual([]);
    expect(result.attributes).toEqual([]);
    expect(result.lowConfidenceAttributes).toEqual([]);
    expect(result.cells).toEqual([]);
  });

  it("hasVerifiedSourceData is always false — no such capability exists", () => {
    const result = buildComparisonMatrixResult(perModel([["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" })]]]));
    expect(result.hasVerifiedSourceData).toBe(false);
  });

  it("handles a totally empty perModel array", () => {
    const result = buildComparisonMatrixResult([]);
    expect(result.cells).toEqual([]);
  });
});

describe("buildComparisonMatrixResult — producer canonicalization (absent vs. explicit-undefined own-property)", () => {
  it("omits consensusValue, verdictTally, rationale, and sources as genuinely absent keys — not explicit-undefined own-properties — when no model supplies them", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Verdict", value: "Best overall choice" })]],
        ["claude", [cell({ subject: "X", attribute: "Verdict", value: "Not recommended at all" })]],
      ])
    );
    const c = result.cells[0];
    expect(c.agreement).toBe("split");
    expect(Object.prototype.hasOwnProperty.call(c, "consensusValue")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(c, "verdictTally")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(c, "rationale")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(c, "sources")).toBe(false);
    // JSON.stringify only omits genuinely-absent keys — an explicit-undefined
    // own-property would be silently dropped too, so this is a secondary,
    // not a primary, proof — hasOwnProperty above is the real assertion.
    expect(Object.keys(JSON.parse(JSON.stringify(c)))).not.toEqual(expect.arrayContaining(["consensusValue", "verdictTally", "rationale", "sources"]));
  });

  it("preserves consensusValue, verdictTally, rationale, and sources as real own-properties when models do supply them", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$799", verdict: "better", rationale: "Cheapest option.", sources: ["https://a.example"] })]],
        ["claude", [cell({ subject: "X", attribute: "Price", value: "$799", verdict: "better" })]],
      ])
    );
    const c = result.cells[0];
    expect(Object.prototype.hasOwnProperty.call(c, "consensusValue")).toBe(true);
    expect(c.consensusValue).toBe("$799");
    expect(Object.prototype.hasOwnProperty.call(c, "verdictTally")).toBe(true);
    expect(c.verdictTally).toEqual({ better: 2 });
    expect(Object.prototype.hasOwnProperty.call(c, "rationale")).toBe(true);
    expect(c.rationale).toBe("Cheapest option.");
    expect(Object.prototype.hasOwnProperty.call(c, "sources")).toBe(true);
    expect(c.sources).toEqual(["https://a.example"]);
  });
});

describe("buildComparisonMatrixResult — narrative synthesis fields", () => {
  it("defaults directConclusion to empty string and the lists to empty arrays when no model supplies them", () => {
    const result = buildComparisonMatrixResult(perModel([["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" })]]]));
    expect(result.directConclusion).toBe("");
    expect(result.tradeoffs).toEqual([]);
    expect(result.bestUseRecommendations).toEqual([]);
    expect(result.uncertainties).toEqual([]);
  });

  it("picks the modal directConclusion when multiple models agree, ignoring models that supplied none", () => {
    const result = buildComparisonMatrixResult([
      { modelId: "chatgpt" as ModelId, cells: [cell({ subject: "X", attribute: "P", value: "1" })], directConclusion: "A leads overall." },
      { modelId: "claude" as ModelId, cells: [cell({ subject: "X", attribute: "P", value: "1" })], directConclusion: "A leads overall." },
      { modelId: "gemini" as ModelId, cells: [cell({ subject: "X", attribute: "P", value: "1" })] },
    ]);
    expect(result.directConclusion).toBe("A leads overall.");
  });

  it("merges and deduplicates near-duplicate trade-offs/recommendations/uncertainties across models", () => {
    const result = buildComparisonMatrixResult([
      {
        modelId: "chatgpt" as ModelId,
        cells: [cell({ subject: "X", attribute: "P", value: "1" })],
        tradeoffs: ["Cheaper options have weaker support."],
        bestUseRecommendations: ["X is the right pick for a small budget-conscious team."],
        uncertainties: ["Pricing changes often."],
      },
      {
        modelId: "claude" as ModelId,
        cells: [cell({ subject: "X", attribute: "P", value: "1" })],
        tradeoffs: ["Cheaper options tend to have weaker support."],
        bestUseRecommendations: ["Y is the right pick for regulated enterprise procurement workflows."],
        uncertainties: [],
      },
    ]);
    expect(result.tradeoffs.length).toBe(1);
    expect(result.bestUseRecommendations.length).toBe(2);
    expect(result.uncertainties).toEqual(["Pricing changes often."]);
  });
});
