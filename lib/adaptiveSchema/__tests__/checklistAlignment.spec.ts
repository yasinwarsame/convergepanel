/**
 * checklist_taxonomy alignment/aggregation tests (Milestone 2).
 *
 * Covers: item clustering across category phrasing (merging the SAME item
 * even when models file it under different categories, resolving the
 * canonical category by majority vote — the deliberate opposite of
 * causal_explanation's per-category isolation), the "General" sentinel for
 * an uncategorized (flat-checklist) panel, the low-confidence bucket
 * (>2-model rule, shared with enumAlignment.ts), critical majority-vote
 * (not from raw item count), notes dedup, coverage math, and empty input.
 */

import { buildChecklistTaxonomyResult, ChecklistTaxonomyFields } from "@/lib/adaptiveSchema/checklistAlignment";
import { ChecklistItem } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function item(overrides: Partial<ChecklistItem> & { id: string; label: string }): ChecklistItem {
  return { ...overrides };
}

function fields(overrides: Partial<ChecklistTaxonomyFields> = {}): ChecklistTaxonomyFields {
  return { summary: "", items: [], notes: [], ...overrides };
}

function perModel(entries: [string, ChecklistTaxonomyFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

describe("buildChecklistTaxonomyResult — item clustering", () => {
  it("merges near-duplicate items across models into one, counting distinct models once", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        ["chatgpt", fields({ items: [item({ id: "dpa", label: "Data processing agreement" })] })],
        ["claude", fields({ items: [item({ id: "data-processing-agreement", label: "Data Processing Agreement" })] })],
      ])
    );
    const allItems = result.categories.flatMap((c) => c.items);
    expect(allItems).toHaveLength(1);
    expect(allItems[0].coverageCount).toBe(2);
  });

  it("merges the same item even when models file it under different category phrasing, resolving one canonical category", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        ["chatgpt", fields({ items: [item({ id: "encryption", label: "Encryption at rest", category: "Security" })] })],
        ["claude", fields({ items: [item({ id: "encryption", label: "Encryption at rest", category: "Security" })] })],
        ["grok", fields({ items: [item({ id: "encryption", label: "Encryption at rest", category: "Technical" })] })],
      ])
    );
    const allItems = result.categories.flatMap((c) => c.items);
    expect(allItems).toHaveLength(1);
    expect(allItems[0].coverageCount).toBe(3);
    expect(allItems[0].category).toBe("Security");
  });

  it("keeps genuinely distinct items separate", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([["chatgpt", fields({ items: [item({ id: "a", label: "Data processing agreement" }), item({ id: "b", label: "Insurance certificate" })] })]])
    );
    const all = [...result.categories.flatMap((c) => c.items), ...result.lowConfidenceItems];
    expect(all).toHaveLength(2);
  });
});

describe("buildChecklistTaxonomyResult — category grouping / General sentinel", () => {
  it("puts everything in a single 'General' group when no model provides a meaningful category (a flat checklist)", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([["chatgpt", fields({ items: [item({ id: "a", label: "Insurance certificate" }), item({ id: "b", label: "Lease agreement" })] })]])
    );
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].category).toBe("General");
    expect(result.categories[0].items).toHaveLength(2);
  });

  it("treats an explicit 'none' category the same as an omitted one", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([["chatgpt", fields({ items: [item({ id: "a", label: "Insurance certificate", category: "none" })] })]])
    );
    expect(result.categories[0].category).toBe("General");
  });

  it("groups items into named categories when the panel provides them (a taxonomy)", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        [
          "chatgpt",
          fields({
            items: [
              item({ id: "rule-based", label: "Rule-based agents", category: "Reactive" }),
              item({ id: "learning", label: "Learning agents", category: "Adaptive" }),
            ],
          }),
        ],
      ])
    );
    expect(result.categories.map((c) => c.category).sort()).toEqual(["Adaptive", "Reactive"]);
  });
});

describe("buildChecklistTaxonomyResult — low-confidence bucket", () => {
  it("moves items covered by only 1-2 models into lowConfidenceItems when the panel has more than 2 models", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        ["chatgpt", fields({ items: [item({ id: "popular", label: "Popular item" }), item({ id: "rare", label: "Rare item" })] })],
        ["claude", fields({ items: [item({ id: "popular", label: "Popular item" })] })],
        ["grok", fields({ items: [item({ id: "popular", label: "Popular item" })] })],
        ["perplexity", fields({ items: [item({ id: "popular", label: "Popular item" })] })],
      ])
    );
    const mainLabels = result.categories.flatMap((c) => c.items).map((i) => i.label);
    expect(mainLabels).toEqual(["Popular item"]);
    expect(result.lowConfidenceItems.map((i) => i.label)).toEqual(["Rare item"]);
  });

  it("does NOT apply the low-confidence split when the whole panel only has 2 models", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        ["chatgpt", fields({ items: [item({ id: "a", label: "X" })] })],
        ["claude", fields({ items: [item({ id: "a", label: "X" })] })],
      ])
    );
    expect(result.categories.flatMap((c) => c.items)).toHaveLength(1);
    expect(result.lowConfidenceItems).toEqual([]);
  });
});

describe("buildChecklistTaxonomyResult — critical majority vote", () => {
  it("marks an item critical when at least half of contributing models flagged it critical", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        ["chatgpt", fields({ items: [item({ id: "a", label: "Signed contract", critical: true })] })],
        ["claude", fields({ items: [item({ id: "a", label: "Signed contract", critical: true })] })],
      ])
    );
    const allItems = result.categories.flatMap((c) => c.items);
    expect(allItems[0].critical).toBe(true);
  });

  it("does NOT mark an item critical when only a minority of contributing models flagged it critical", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        ["chatgpt", fields({ items: [item({ id: "a", label: "Optional review", critical: true })] })],
        ["claude", fields({ items: [item({ id: "a", label: "Optional review" })] })],
        ["grok", fields({ items: [item({ id: "a", label: "Optional review" })] })],
      ])
    );
    const allItems = result.categories.flatMap((c) => c.items);
    expect(allItems[0].critical).toBe(false);
  });
});

describe("buildChecklistTaxonomyResult — notes and summary", () => {
  it("merges near-duplicate notes across models", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        ["chatgpt", fields({ notes: ["This checklist is not exhaustive"] })],
        ["claude", fields({ notes: ["This list is not exhaustive"] })],
      ])
    );
    expect(result.notes).toHaveLength(1);
  });

  it("picks a representative summary across models", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([["chatgpt", fields({ summary: "A checklist for launching a SaaS product." })]])
    );
    expect(result.summary).toBe("A checklist for launching a SaaS product.");
  });
});

describe("buildChecklistTaxonomyResult — empty input", () => {
  it("never throws and returns an empty result when no model produced usable items", () => {
    const result = buildChecklistTaxonomyResult(perModel([["chatgpt", fields()], ["claude", fields()]]));
    expect(result.categories).toEqual([]);
    expect(result.lowConfidenceItems).toEqual([]);
    expect(result.totalModels).toBe(2);
  });

  it("handles a totally empty perModel array", () => {
    const result = buildChecklistTaxonomyResult([]);
    expect(result.categories).toEqual([]);
    expect(result.totalModels).toBe(0);
  });
});
