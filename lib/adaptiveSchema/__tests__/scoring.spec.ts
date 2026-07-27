/**
 * Certainty Scoring Tests (R1b)
 */

import { scoreClaimCertainty, computeRunCertainty, claimSalience } from "@/lib/adaptiveSchema/scoring";
import { AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { CERTAINTY_WEIGHTS } from "@/lib/adaptiveSchema/config";

function cell(overrides: Partial<AlignedClaimCell> & Pick<AlignedClaimCell, "modelId" | "stance">): AlignedClaimCell {
  return { rawStance: "asserts", confidence: "settled", excerpt: "x", ...overrides };
}

function row(overrides: Partial<AlignedClaim> & Pick<AlignedClaim, "cells" | "agreementScore">): AlignedClaim {
  return { id: "row", claimText: "text", certaintyScore: 0, status: "single_source", ...overrides };
}

describe("scoreClaimCertainty", () => {
  it("full coverage + full agreement + settled confidence -> certainty 1.0", () => {
    const rows = scoreClaimCertainty(
      [
        row({
          agreementScore: 1,
          cells: [
            cell({ modelId: "chatgpt", stance: "agrees", confidence: "settled" }),
            cell({ modelId: "claude", stance: "agrees", confidence: "settled" }),
          ],
        }),
      ],
      2
    );
    expect(rows[0].certaintyScore).toBeCloseTo(1, 5);
  });

  it("applies the configured weights exactly", () => {
    const rows = scoreClaimCertainty(
      [
        row({
          agreementScore: 0.5,
          cells: [
            cell({ modelId: "chatgpt", stance: "agrees", confidence: "majority_view" }), // 0.75
            null as any,
          ].filter(Boolean) as AlignedClaimCell[],
        }),
      ],
      2 // only 1 of 2 models present -> coverage 0.5
    );
    const expected =
      CERTAINTY_WEIGHTS.coverage * 0.5 + CERTAINTY_WEIGHTS.agreement * 0.5 + CERTAINTY_WEIGHTS.statedConfidence * 0.75;
    expect(rows[0].certaintyScore).toBeCloseTo(expected, 5);
  });

  it("zero coverage (no cells) -> certainty 0", () => {
    const rows = scoreClaimCertainty([row({ agreementScore: 0, cells: [] })], 3);
    expect(rows[0].certaintyScore).toBe(0);
  });
});

describe("claimSalience", () => {
  it("counts non-null cells, minimum 1", () => {
    const r = row({ agreementScore: 0, cells: [cell({ modelId: "chatgpt", stance: "agrees" }), null] });
    expect(claimSalience(r)).toBe(1);
  });
});

describe("computeRunCertainty", () => {
  it("weights claims by salience — a claim more models raised pulls the run score harder", () => {
    const highSalience = row({
      agreementScore: 1,
      certaintyScore: 0.9,
      cells: [
        cell({ modelId: "a", stance: "agrees" }),
        cell({ modelId: "b", stance: "agrees" }),
        cell({ modelId: "c", stance: "agrees" }),
      ],
    });
    const lowSalience = row({
      agreementScore: 0,
      certaintyScore: 0.1,
      cells: [cell({ modelId: "a", stance: "agrees" })],
    });

    const result = computeRunCertainty([highSalience, lowSalience], "generic");
    // Weighted mean: (0.9*3 + 0.1*1) / 4 = 2.8/4 = 0.7 — closer to the
    // high-salience claim's certainty than a plain unweighted average (0.5).
    expect(result).toBeCloseTo(0.7, 5);
  });

  it("returns 0 for an empty claim set", () => {
    expect(computeRunCertainty([], "generic")).toBe(0);
  });

  it("weights medical_health claims by evidence tier (empirical 3x anecdotal)", () => {
    const empiricalRow = row({
      agreementScore: 0,
      certaintyScore: 0.2,
      cells: [
        cell({ modelId: "a", stance: "disputes", evidenceType: "empirical" }),
        cell({ modelId: "b", stance: "agrees", evidenceType: "empirical" }),
      ],
    });
    const anecdotalRow = row({
      agreementScore: 1,
      certaintyScore: 0.9,
      cells: [cell({ modelId: "a", stance: "agrees", evidenceType: "anecdotal" })],
    });

    const medical = computeRunCertainty([empiricalRow, anecdotalRow], "medical_health");
    const generic = computeRunCertainty([empiricalRow, anecdotalRow], "generic");

    // Under medical_health's tier weighting, the low-certainty empirical row
    // is weighted 3x harder relative to the anecdotal row than it would be
    // under plain salience weighting -> medical run certainty is lower.
    expect(medical).toBeLessThan(generic);
  });
});
