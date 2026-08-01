/**
 * evidence_review alignment/aggregation tests (Milestone 2).
 *
 * Covers: paraphrased dimensions merge, distinct dimensions remain
 * separate, per-dimension strength derived from the panel's OWN self-
 * reports (never from coverage), "contested" when models' own reads
 * genuinely conflict, the low-confidence bucket, red-flag/strength/caveat/
 * check dedup, source-backed aggregation, model coverage math, the derived
 * overallStrength roll-up, weak evidence never upgraded by repetition, and
 * empty/malformed input handling.
 */

import { buildEvidenceReviewResult, EvidenceReviewFields } from "@/lib/adaptiveSchema/evidenceReviewAlignment";
import { EvidenceDimension } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function dim(overrides: Partial<EvidenceDimension> & { id: string; dimension: string; assessment: string }): EvidenceDimension {
  return { ...overrides };
}

function fields(overrides: Partial<EvidenceReviewFields> = {}): EvidenceReviewFields {
  return {
    overallAssessment: "",
    dimensions: [],
    redFlags: [],
    strengths: [],
    applicabilityCaveats: [],
    recommendedChecks: [],
    sources: [],
    ...overrides,
  };
}

function perModel(entries: [string, EvidenceReviewFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

describe("buildEvidenceReviewResult — dimension clustering", () => {
  it("merges paraphrased dimensions into one", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        ["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Sample size", assessment: "The sample is quite small." })] })],
        ["claude", fields({ dimensions: [dim({ id: "b", dimension: "Sample size", assessment: "The sample size is small." })] })],
      ])
    );
    expect(result.dimensions).toHaveLength(1);
    expect(result.dimensions[0].coverageCount).toBe(2);
  });

  it("keeps genuinely distinct dimensions separate", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        [
          "chatgpt",
          fields({
            dimensions: [
              dim({ id: "a", dimension: "Sample size", assessment: "The sample is small." }),
              dim({ id: "b", dimension: "Conflicts of interest", assessment: "Funded by an interested party." }),
            ],
          }),
        ],
      ])
    );
    const all = [...result.dimensions, ...result.lowConfidenceDimensions];
    expect(all).toHaveLength(2);
  });
});

describe("buildEvidenceReviewResult — strength derived from model self-reports, not coverage", () => {
  it("uses the shared strength when all reporting models agree", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        ["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Methodology", assessment: "Solid RCT design.", strength: "strong" })] })],
        ["claude", fields({ dimensions: [dim({ id: "b", dimension: "Methodology", assessment: "Solid RCT design.", strength: "strong" })] })],
      ])
    );
    expect(result.dimensions[0].strength).toBe("strong");
  });

  it("is 'contested' when contributing models' own strength reads genuinely conflict", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        ["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Sample size", assessment: "Small sample.", strength: "weak" })] })],
        ["claude", fields({ dimensions: [dim({ id: "b", dimension: "Sample size", assessment: "Adequate sample.", strength: "strong" })] })],
      ])
    );
    expect(result.dimensions[0].strength).toBe("contested");
  });

  it("is 'unknown' when no contributing model reported a strength", () => {
    const result = buildEvidenceReviewResult(
      perModel([["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Methodology", assessment: "A design note." })] })]])
    );
    expect(result.dimensions[0].strength).toBe("unknown");
  });

  it("never upgrades strength purely because many models repeat the same read", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        ["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Replication", assessment: "Not independently replicated.", strength: "weak" })] })],
        ["claude", fields({ dimensions: [dim({ id: "b", dimension: "Replication", assessment: "Not independently replicated.", strength: "weak" })] })],
        ["grok", fields({ dimensions: [dim({ id: "c", dimension: "Replication", assessment: "Not independently replicated.", strength: "weak" })] })],
        ["perplexity", fields({ dimensions: [dim({ id: "d", dimension: "Replication", assessment: "Not independently replicated.", strength: "weak" })] })],
        ["gemini", fields({ dimensions: [dim({ id: "e", dimension: "Replication", assessment: "Not independently replicated.", strength: "weak" })] })],
      ])
    );
    expect(result.dimensions[0].coverageCount).toBe(5);
    expect(result.dimensions[0].strength).toBe("weak");
  });
});

describe("buildEvidenceReviewResult — overallStrength derivation", () => {
  it("derives 'contested' when dimensions disagree", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        ["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Methodology", assessment: "x", strength: "strong" })] })],
        ["claude", fields({ dimensions: [dim({ id: "b", dimension: "Sample size", assessment: "y", strength: "weak" })] })],
      ])
    );
    expect(result.overallStrength).toBe("contested");
  });

  it("derives the shared value when dimensions with a real signal agree", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        ["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Methodology", assessment: "x", strength: "strong" })] })],
        ["claude", fields({ dimensions: [dim({ id: "b", dimension: "Sample size", assessment: "y", strength: "strong" })] })],
      ])
    );
    expect(result.overallStrength).toBe("strong");
  });

  it("is 'unknown' when no dimension carries a real signal", () => {
    const result = buildEvidenceReviewResult(
      perModel([["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Methodology", assessment: "x" })] })]])
    );
    expect(result.overallStrength).toBe("unknown");
  });
});

describe("buildEvidenceReviewResult — low-confidence bucket", () => {
  it("moves dimensions covered by only 1-2 models into lowConfidenceDimensions when the panel has more than 2 models", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        [
          "chatgpt",
          fields({
            dimensions: [
              dim({ id: "popular", dimension: "Methodology", assessment: "Widely discussed." }),
              dim({ id: "rare", dimension: "Funding transparency", assessment: "Rarely discussed." }),
            ],
          }),
        ],
        ["claude", fields({ dimensions: [dim({ id: "popular2", dimension: "Methodology", assessment: "Widely discussed." })] })],
        ["grok", fields({ dimensions: [dim({ id: "popular3", dimension: "Methodology", assessment: "Widely discussed." })] })],
        ["perplexity", fields({ dimensions: [dim({ id: "popular4", dimension: "Methodology", assessment: "Widely discussed." })] })],
      ])
    );
    expect(result.dimensions.map((d) => d.dimension)).toEqual(["Methodology"]);
    expect(result.lowConfidenceDimensions.map((d) => d.dimension)).toEqual(["Funding transparency"]);
  });
});

describe("buildEvidenceReviewResult — list field dedup", () => {
  it("deduplicates near-duplicate red flags, strengths, caveats, and checks", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        ["chatgpt", fields({ redFlags: ["No control group was used"], strengths: ["The study was peer-reviewed"] })],
        ["claude", fields({ redFlags: ["There was no control group"], strengths: ["This study was peer reviewed"] })],
      ])
    );
    expect(result.redFlags).toHaveLength(1);
    expect(result.strengths).toHaveLength(1);
  });
});

describe("buildEvidenceReviewResult — source-backed and model coverage", () => {
  it("is sourceBacked when any model cited a source", () => {
    const result = buildEvidenceReviewResult(perModel([["chatgpt", fields({ sources: ["Journal of Medicine"] })]]));
    expect(result.sourceBacked).toBe(true);
  });

  it("is not sourceBacked when no model cited a source", () => {
    const result = buildEvidenceReviewResult(perModel([["chatgpt", fields({})]]));
    expect(result.sourceBacked).toBe(false);
  });

  it("uses the full attempted model count as the coverage denominator, not just the successful ones", () => {
    const result = buildEvidenceReviewResult(
      perModel([["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Methodology", assessment: "x" })] })]]),
      2
    );
    expect(result.dimensions[0].coverageCount).toBe(1);
    expect(result.dimensions[0].totalModels).toBe(2);
  });
});

describe("buildEvidenceReviewResult — empty and malformed input", () => {
  it("never throws and returns an empty result when no model produced usable data", () => {
    const result = buildEvidenceReviewResult(perModel([["chatgpt", fields()], ["claude", fields()]]));
    expect(result.dimensions).toEqual([]);
    expect(result.overallStrength).toBe("unknown");
    expect(result.sourceBacked).toBe(false);
    expect(result.totalModels).toBe(2);
  });

  it("handles a totally empty perModel array", () => {
    const result = buildEvidenceReviewResult([]);
    expect(result.dimensions).toEqual([]);
    expect(result.totalModels).toBe(0);
  });
});
