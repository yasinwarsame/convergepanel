/**
 * ranked_enumeration alignment/aggregation tests (Milestone 2).
 *
 * Covers: paraphrase clustering, coverage/panelRank/rankVariance math, the
 * low-confidence bucket (and its "only applies when totalModels > 2"
 * refinement), shortfall detection (never padded), and rank correlation.
 */

import { buildRankedEnumerationResult } from "@/lib/adaptiveSchema/enumAlignment";
import { EnumItem } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function item(overrides: Partial<EnumItem> & { id: string; label: string; rank: number }): EnumItem {
  return { ...overrides };
}

function perModel(entries: [string, EnumItem[]][]) {
  return entries.map(([modelId, items]) => ({ modelId: modelId as ModelId, items }));
}

describe("buildRankedEnumerationResult — clustering", () => {
  it("merges near-duplicate labels/slugs across models into one item, counting distinct models once", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "chatgpt-tool", label: "ChatGPT", rank: 1 })]],
        ["claude", [item({ id: "chat-gpt", label: "ChatGPT by OpenAI", rank: 2 })]],
        ["grok", [item({ id: "chatgpt", label: "ChatGPT", rank: 1 })]],
        ["perplexity", [item({ id: "chatgpt-tool", label: "ChatGPT", rank: 3 })]],
        ["gemini", [item({ id: "chatgpt", label: "ChatGPT", rank: 2 })]],
      ]),
      null
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].coverageCount).toBe(5);
    expect(result.items[0].totalModels).toBe(5);
    expect(result.items[0].coverageRatio).toBe(1);
  });

  it("keeps genuinely distinct items separate", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "chatgpt", label: "ChatGPT", rank: 1 }), item({ id: "claude", label: "Claude", rank: 2 })]],
        ["claude", [item({ id: "gemini", label: "Gemini", rank: 1 })]],
      ]),
      null
    );

    const labels = [...result.items, ...result.lowConfidenceItems].map((i) => i.label).sort();
    expect(labels).toEqual(["ChatGPT", "Claude", "Gemini"]);
  });

  it("does not merge two distinct items from the SAME model into one cluster incorrectly counted as multi-model coverage", () => {
    const result = buildRankedEnumerationResult(
      perModel([["chatgpt", [item({ id: "chatgpt", label: "ChatGPT", rank: 1 }), item({ id: "claude", label: "Claude", rank: 2 })]]]),
      null
    );
    const all = [...result.items, ...result.lowConfidenceItems];
    expect(all).toHaveLength(2);
    for (const agg of all) expect(agg.coverageCount).toBe(1);
  });
});

describe("buildRankedEnumerationResult — coverage/rank/variance math", () => {
  it("computes panelRank as the mean of each model's own rank for the item", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "x", label: "X", rank: 1 })]],
        ["claude", [item({ id: "x", label: "X", rank: 3 })]],
        ["grok", [item({ id: "x", label: "X", rank: 2 })]],
      ]),
      null
    );
    const x = [...result.items, ...result.lowConfidenceItems].find((i) => i.label === "X")!;
    expect(x.panelRank).toBe(2);
  });

  it("computes rankVariance across sourceRanks when covered by 2+ models, and leaves it undefined for single-model coverage", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "x", label: "X", rank: 1 }), item({ id: "y", label: "Y", rank: 1 })]],
        ["claude", [item({ id: "x", label: "X", rank: 5 })]],
      ]),
      null
    );
    const all = [...result.items, ...result.lowConfidenceItems];
    const x = all.find((i) => i.label === "X")!;
    const y = all.find((i) => i.label === "Y")!;
    // ranks [1, 5] -> mean 3, variance = ((1-3)^2 + (5-3)^2) / 2 = 4
    expect(x.rankVariance).toBe(4);
    expect(y.rankVariance).toBeUndefined();
  });

  it("sorts the main list by coverage descending, then panelRank ascending", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "a", label: "A", rank: 2 }), item({ id: "b", label: "B", rank: 1 })]],
        ["claude", [item({ id: "a", label: "A", rank: 2 }), item({ id: "b", label: "B", rank: 1 })]],
        ["grok", [item({ id: "a", label: "A", rank: 2 }), item({ id: "b", label: "B", rank: 1 })]],
        ["perplexity", [item({ id: "a", label: "A", rank: 2 })]],
      ]),
      null
    );
    // A: covered by 4, rank 2. B: covered by 3, rank 1. A has higher coverage so sorts first despite worse rank.
    expect(result.items.map((i) => i.label)).toEqual(["A", "B"]);
  });
});

describe("buildRankedEnumerationResult — low-confidence bucket", () => {
  it("moves items covered by only 1-2 models into lowConfidenceItems when the panel has more than 2 models", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "popular", label: "Popular", rank: 1 }), item({ id: "rare", label: "Rare", rank: 5 })]],
        ["claude", [item({ id: "popular", label: "Popular", rank: 1 })]],
        ["grok", [item({ id: "popular", label: "Popular", rank: 1 })]],
        ["perplexity", [item({ id: "popular", label: "Popular", rank: 1 })]],
      ]),
      null
    );
    expect(result.items.map((i) => i.label)).toEqual(["Popular"]);
    expect(result.lowConfidenceItems.map((i) => i.label)).toEqual(["Rare"]);
  });

  it("does NOT apply the low-confidence split when the whole panel only has 2 models — full coverage must not read as low confidence", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "x", label: "X", rank: 1 })]],
        ["claude", [item({ id: "x", label: "X", rank: 1 })]],
      ]),
      null
    );
    expect(result.items.map((i) => i.label)).toEqual(["X"]);
    expect(result.lowConfidenceItems).toEqual([]);
  });
});

describe("buildRankedEnumerationResult — shortfall (never padded)", () => {
  it("states the shortfall plainly when the panel produces fewer distinct items than requested", () => {
    const result = buildRankedEnumerationResult(
      perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 }), item({ id: "y", label: "Y", rank: 2 })]]]),
      20
    );
    expect(result.actualCount).toBe(2);
    expect(result.shortfallNote).toMatch(/20/);
    expect(result.shortfallNote).toMatch(/2 distinct items/);
    // Never padded — exactly the distinct items found, no filler.
    expect(result.items.length + result.lowConfidenceItems.length).toBe(2);
  });

  it("has no shortfallNote when actualCount meets or exceeds requestedCount", () => {
    const result = buildRankedEnumerationResult(
      perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 }), item({ id: "y", label: "Y", rank: 2 })]]]),
      2
    );
    expect(result.shortfallNote).toBeUndefined();
  });

  it("has no shortfallNote when no count was requested", () => {
    const result = buildRankedEnumerationResult(perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 })]]]), null);
    expect(result.shortfallNote).toBeUndefined();
  });
});

describe("buildRankedEnumerationResult — rank correlation", () => {
  it("is null when fewer than 2 models produced usable items", () => {
    const result = buildRankedEnumerationResult(perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 })]]]), null);
    expect(result.rankCorrelation).toBeNull();
  });

  it("is 1 (perfect agreement) when two models rank the same shared items in the same order", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "a", label: "A", rank: 1 }), item({ id: "b", label: "B", rank: 2 })]],
        ["claude", [item({ id: "a", label: "A", rank: 1 }), item({ id: "b", label: "B", rank: 2 })]],
      ]),
      null
    );
    expect(result.rankCorrelation).toBe(1);
  });

  it("is negative when two models rank shared items in opposite order", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "a", label: "A", rank: 1 }), item({ id: "b", label: "B", rank: 2 })]],
        ["claude", [item({ id: "a", label: "A", rank: 2 }), item({ id: "b", label: "B", rank: 1 })]],
      ]),
      null
    );
    expect(result.rankCorrelation).toBeLessThan(0);
  });
});

describe("buildRankedEnumerationResult — producer canonicalization (absent vs. explicit-undefined own-property)", () => {
  it("omits category, rankVariance, rationale, and sources as genuinely absent keys when no model supplies them", () => {
    const result = buildRankedEnumerationResult(
      perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 })]]]),
      null
    );
    const x = result.items[0];
    expect(Object.prototype.hasOwnProperty.call(x, "category")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(x, "rankVariance")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(x, "rationale")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(x, "sources")).toBe(false);
    expect(Object.keys(JSON.parse(JSON.stringify(x)))).not.toEqual(
      expect.arrayContaining(["category", "rankVariance", "rationale", "sources"])
    );
  });

  it("preserves category, rankVariance, rationale, and sources as real own-properties when supplied", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "x", label: "X", rank: 1, category: "Tools", rationale: "Most popular.", sources: ["https://a.example"] })]],
        ["claude", [item({ id: "x", label: "X", rank: 3 })]],
      ]),
      null
    );
    const x = result.items[0];
    expect(Object.prototype.hasOwnProperty.call(x, "category")).toBe(true);
    expect(x.category).toBe("Tools");
    expect(Object.prototype.hasOwnProperty.call(x, "rankVariance")).toBe(true);
    expect(x.rankVariance).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(x, "rationale")).toBe(true);
    expect(x.rationale).toBe("Most popular.");
    expect(Object.prototype.hasOwnProperty.call(x, "sources")).toBe(true);
    expect(x.sources).toEqual(["https://a.example"]);
  });

  it("omits shortfallNote as a genuinely absent key (not just undefined-valued) on both the empty-entries and non-empty shortfall return paths", () => {
    const empty = buildRankedEnumerationResult(perModel([["chatgpt", []]]), null);
    expect(Object.prototype.hasOwnProperty.call(empty, "shortfallNote")).toBe(false);

    const metCount = buildRankedEnumerationResult(perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 })]]]), 1);
    expect(Object.prototype.hasOwnProperty.call(metCount, "shortfallNote")).toBe(false);
  });

  it("preserves shortfallNote as a real own-property on both the empty-entries-with-requestedCount and non-empty-shortfall return paths", () => {
    const emptyWithRequest = buildRankedEnumerationResult(perModel([["chatgpt", []]]), 5);
    expect(Object.prototype.hasOwnProperty.call(emptyWithRequest, "shortfallNote")).toBe(true);
    expect(emptyWithRequest.shortfallNote).toMatch(/5/);

    const shortfall = buildRankedEnumerationResult(
      perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 })]]]),
      5
    );
    expect(Object.prototype.hasOwnProperty.call(shortfall, "shortfallNote")).toBe(true);
  });
});

describe("buildRankedEnumerationResult — empty input", () => {
  it("never throws and returns an empty result when no model produced usable items", () => {
    const result = buildRankedEnumerationResult(perModel([["chatgpt", []], ["claude", []]]), 10);
    expect(result.items).toEqual([]);
    expect(result.lowConfidenceItems).toEqual([]);
    expect(result.actualCount).toBe(0);
    expect(result.rankCorrelation).toBeNull();
    expect(result.shortfallNote).toBeTruthy();
  });

  it("hasLiveQueryLogData is always false — no such capability exists", () => {
    const result = buildRankedEnumerationResult(perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 })]]]), null);
    expect(result.hasLiveQueryLogData).toBe(false);
  });
});
