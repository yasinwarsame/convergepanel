/**
 * definition_explanation alignment/aggregation tests (Milestone 2).
 *
 * Covers: interpretation clustering by directAnswer similarity (merging
 * paraphrases vs preserving materially different interpretations —
 * ambiguity handling for terms like "What is a model?"), sub-field merging
 * (keyPoints/distinctions/processSteps/misconceptions/relatedConcepts/
 * sources), the "none" sentinel -> undefined conversion, analogy+limits
 * pairing staying tied to the same model, process-step renumbering, depth
 * is left entirely to the prompt (no classification field asserted here),
 * source-backed detection, and empty input.
 */

import { buildDefinitionExplanationResult, DefinitionExplanationFields } from "@/lib/adaptiveSchema/definitionAlignment";
import { ModelId } from "@/lib/types";

function fields(overrides: Partial<DefinitionExplanationFields> = {}): DefinitionExplanationFields {
  return {
    term: "none",
    directAnswer: "",
    explanation: "",
    keyPoints: [],
    example: "none",
    analogyText: "none",
    analogyLimits: "none",
    distinctions: [],
    processSteps: [],
    advancedDetail: "none",
    commonMisconceptions: [],
    relatedConcepts: [],
    sources: [],
    ...overrides,
  };
}

function perModel(entries: [string, DefinitionExplanationFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

describe("buildDefinitionExplanationResult — interpretation clustering", () => {
  it("merges paraphrased directAnswers into one primary interpretation", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        ["chatgpt", fields({ term: "CAGR", directAnswer: "CAGR is the annual growth rate of an investment smoothed over a period." })],
        ["claude", fields({ term: "CAGR", directAnswer: "CAGR is the smoothed annual growth rate of an investment over a period." })],
      ]),
      2
    );
    expect(result.alternateInterpretations).toEqual([]);
    expect(result.isAmbiguous).toBe(false);
    expect(result.primary!.coverageCount).toBe(2);
  });

  it("preserves materially different interpretations rather than forcing a merge ('What is a model?')", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        ["chatgpt", fields({ term: "model", directAnswer: "In machine learning, a model is a function trained on data to make predictions." })],
        ["claude", fields({ term: "model", directAnswer: "A fashion model is a person who displays clothing and products commercially." })],
      ]),
      2
    );
    expect(result.isAmbiguous).toBe(true);
    expect(result.alternateInterpretations).toHaveLength(1);
    expect(result.primary).not.toBeNull();
  });

  it("picks the interpretation with the most coverage as primary", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        ["chatgpt", fields({ directAnswer: "A model is a computational representation of a system." })],
        ["claude", fields({ directAnswer: "A model is a computational representation of a system." })],
        ["grok", fields({ directAnswer: "A completely different, unrelated take on the term." })],
      ]),
      3
    );
    expect(result.primary!.coverageCount).toBe(2);
    expect(result.alternateInterpretations).toHaveLength(1);
    expect(result.alternateInterpretations[0].coverageCount).toBe(1);
  });
});

describe("buildDefinitionExplanationResult — sub-field merging within a cluster", () => {
  it("merges keyPoints/misconceptions/relatedConcepts across models and dedupes near-duplicates", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        [
          "chatgpt",
          fields({
            directAnswer: "X is Y.",
            keyPoints: ["It scales linearly", "Easy to compute"],
            commonMisconceptions: ["People think it means Z"],
            relatedConcepts: ["Compound interest"],
          }),
        ],
        [
          "claude",
          fields({
            directAnswer: "X is Y.",
            keyPoints: ["It scales linearly", "Requires clean data"],
            commonMisconceptions: ["People think it means Z"],
            relatedConcepts: ["Net present value"],
          }),
        ],
      ]),
      2
    );
    const kp = result.primary!.keyPoints;
    expect(kp).toContain("Requires clean data");
    expect(kp.filter((p) => p.includes("scales linearly"))).toHaveLength(1);
    expect(result.primary!.commonMisconceptions).toHaveLength(1);
    expect(result.primary!.relatedConcepts.sort()).toEqual(["Compound interest", "Net present value"]);
  });

  it("picks the longest explanation among cluster members rather than merging prose", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        ["chatgpt", fields({ directAnswer: "X is Y.", explanation: "Short explanation." })],
        ["claude", fields({ directAnswer: "X is Y.", explanation: "A much longer and more thorough explanation of the concept." })],
      ]),
      2
    );
    expect(result.primary!.explanation).toBe("A much longer and more thorough explanation of the concept.");
  });

  it("converts the 'none' sentinel to undefined for example/analogy/advancedDetail", () => {
    const result = buildDefinitionExplanationResult(perModel([["chatgpt", fields({ directAnswer: "X is Y." })]]), 1);
    expect(result.primary!.example).toBeUndefined();
    expect(result.primary!.analogy).toBeUndefined();
    expect(result.primary!.advancedDetail).toBeUndefined();
  });

  it("keeps an analogy's text and limits paired from the same model, never mixed across models", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        ["chatgpt", fields({ directAnswer: "X is Y.", analogyText: "It's like a banking ledger.", analogyLimits: "Ledgers don't self-update, though." })],
        ["claude", fields({ directAnswer: "X is Y." })],
      ]),
      2
    );
    expect(result.primary!.analogy).toEqual({ text: "It's like a banking ledger.", limits: "Ledgers don't self-update, though." });
  });

  it("merges near-duplicate distinctions by concept and keeps the longest explanation", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        ["chatgpt", fields({ directAnswer: "X is Y.", distinctions: [{ concept: "precision", explanation: "Short." }] })],
        ["claude", fields({ directAnswer: "X is Y.", distinctions: [{ concept: "precision", explanation: "A longer, more complete distinction." }] })],
      ]),
      2
    );
    expect(result.primary!.distinctions).toHaveLength(1);
    expect(result.primary!.distinctions[0].explanation).toBe("A longer, more complete distinction.");
  });

  it("merges process steps by title and renumbers sequentially", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        [
          "chatgpt",
          fields({
            directAnswer: "X is Y.",
            processSteps: [
              { number: 1, title: "Key generation", explanation: "Generate a key pair." },
              { number: 2, title: "Encryption", explanation: "Encrypt with the public key." },
            ],
          }),
        ],
        [
          "claude",
          fields({
            directAnswer: "X is Y.",
            processSteps: [{ number: 1, title: "Key generation", explanation: "Generate a public/private key pair using an algorithm." }],
          }),
        ],
      ]),
      2
    );
    expect(result.primary!.processSteps.map((s) => s.number)).toEqual([1, 2]);
    expect(result.primary!.processSteps[0].explanation).toBe("Generate a public/private key pair using an algorithm.");
  });
});

describe("buildDefinitionExplanationResult — source-backed detection", () => {
  it("is sourceBacked when the primary interpretation has at least one source", () => {
    const result = buildDefinitionExplanationResult(perModel([["chatgpt", fields({ directAnswer: "X is Y.", sources: ["NIST glossary"] })]]), 1);
    expect(result.sourceBacked).toBe(true);
  });

  it("is not sourceBacked when no contributing model cited a source", () => {
    const result = buildDefinitionExplanationResult(perModel([["chatgpt", fields({ directAnswer: "X is Y." })]]), 1);
    expect(result.sourceBacked).toBe(false);
  });
});

describe("buildDefinitionExplanationResult — empty input", () => {
  it("never throws and returns a null primary when no model produced usable data", () => {
    const result = buildDefinitionExplanationResult([], 2);
    expect(result.primary).toBeNull();
    expect(result.alternateInterpretations).toEqual([]);
    expect(result.isAmbiguous).toBe(false);
    expect(result.sourceBacked).toBe(false);
  });
});
