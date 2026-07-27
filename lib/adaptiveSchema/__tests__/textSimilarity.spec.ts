/**
 * Text similarity / dedup-merge tests (Part B6).
 *
 * Covers the cheap deterministic near-duplicate merge used for
 * Uncertainties/Follow-ups (no model call — see textSimilarity.ts and
 * GenericSectionsView.tsx), plus slugsMatch's re-export continuing to work
 * (it moved out of alignment.ts into this module).
 */

import { slugsMatch, textsAreNearDuplicates, mergeAndRankTextItems, TextItemSource } from "@/lib/adaptiveSchema/textSimilarity";

const THRESHOLDS = { levenshteinMaxRatio: 0.2, tokenOverlapMin: 0.7 };

describe("slugsMatch (re-exported from textSimilarity.ts)", () => {
  it("still matches identical and fuzzy slugs", () => {
    expect(slugsMatch("demand-pull-inflation", "demand-pull-inflation")).toBe(true);
    expect(slugsMatch("demand-pull-inflation", "demand-pull-inflaton")).toBe(true);
    expect(slugsMatch("demand-pull-inflation", "supply-chain-disruption")).toBe(false);
  });
});

describe("textsAreNearDuplicates", () => {
  it("matches two paraphrases of the same point at the B6 threshold", () => {
    expect(
      textsAreNearDuplicates(
        "It's unclear how much of the inflation spike was driven by supply chain disruption versus monetary policy.",
        "The relative contribution of supply chain disruption vs monetary policy to the inflation spike is unclear.",
        THRESHOLDS
      )
    ).toBe(true);
  });

  it("does not merge genuinely distinct points that happen to share a few words", () => {
    expect(
      textsAreNearDuplicates(
        "It's unclear how much of the inflation spike was driven by supply chain disruption.",
        "It's unclear whether the Fed will cut rates again this year.",
        THRESHOLDS
      )
    ).toBe(false);
  });
});

describe("mergeAndRankTextItems", () => {
  function item(modelId: string, text: string): TextItemSource {
    return { modelId: modelId as any, text };
  }

  it("B6 required case: two paraphrases of the same uncertainty from different models merge into one item", () => {
    const items: TextItemSource[] = [
      item("chatgpt", "It's unclear how much of the inflation spike came from supply chain disruption versus monetary policy."),
      item("claude", "The relative contribution of supply chain disruption vs monetary policy to inflation is unclear."),
    ];

    const result = mergeAndRankTextItems(items, { ...THRESHOLDS, cap: 8 });

    expect(result).toHaveLength(1);
    expect(result[0].modelCount).toBe(2);
    expect(result[0].modelIds.sort()).toEqual(["chatgpt", "claude"]);
  });

  it("keeps genuinely distinct items separate", () => {
    const items: TextItemSource[] = [
      item("chatgpt", "It's unclear how much of the inflation spike came from supply chain disruption."),
      item("claude", "It's unclear whether the Fed will cut rates again this year."),
      item("grok", "It's unclear how durable the labor market strength will prove to be."),
    ];

    const result = mergeAndRankTextItems(items, { ...THRESHOLDS, cap: 8 });
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.modelCount === 1)).toBe(true);
  });

  it("ranks by distinct model count descending, and caps the result", () => {
    const items: TextItemSource[] = [
      item("chatgpt", "It's unclear how much of the inflation spike was driven by supply chain disruption versus monetary policy."),
      item("claude", "The relative contribution of supply chain disruption vs monetary policy to the inflation spike is unclear."),
      item("grok", "How much of the inflation spike was driven by supply chain disruption versus monetary policy is unclear."),
      item("perplexity", "It's unclear whether the labor market will stay this tight through next year."),
      item("gemini", "Whether the labor market stays this tight through next year is unclear."),
      item("chatgpt", "The long-run neutral interest rate is difficult to estimate precisely."),
    ];

    const result = mergeAndRankTextItems(items, { ...THRESHOLDS, cap: 2 });

    expect(result).toHaveLength(2);
    expect(result[0].modelCount).toBe(3); // supply-chain point: chatgpt/claude/grok
    expect(result[1].modelCount).toBe(2); // labor-market point: perplexity/gemini
    // Neutral-rate point (modelCount 1) dropped by the cap.
  });

  it("does not double-count the same model raising near-duplicate items in its own list", () => {
    const items: TextItemSource[] = [
      item("chatgpt", "It's unclear how much inflation came from supply chain issues."),
      item("chatgpt", "The role of supply chain issues in the inflation spike is unclear."),
      item("claude", "It's unclear how much inflation came from supply chain issues."),
    ];

    const result = mergeAndRankTextItems(items, { ...THRESHOLDS, cap: 8 });
    expect(result).toHaveLength(1);
    expect(result[0].modelCount).toBe(2); // chatgpt counted once, not twice
  });

  it("returns an empty array for no items", () => {
    expect(mergeAndRankTextItems([], { ...THRESHOLDS, cap: 8 })).toEqual([]);
  });
});
