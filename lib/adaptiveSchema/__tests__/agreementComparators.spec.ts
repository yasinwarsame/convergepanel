/**
 * Agreement Comparator Tests (R2)
 *
 * Covers the schema-specific scoring semantics layered on top of
 * defaultStanceBasedScore: contested_empirical's meta-level camp agreement,
 * legal_regulatory's jurisdiction_mismatch (never blended into a normal
 * score), factual_lookup's hard split on any mismatch, and the
 * evidence-tier weight helper used by medical_health's run-level scoring.
 */

import {
  defaultStanceBasedScore,
  scoreAgreement,
  rowEvidenceTierWeight,
} from "@/lib/adaptiveSchema/agreementComparators";
import { alignScalarField } from "@/lib/adaptiveSchema/fieldAlignment";
import { AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";

function cell(overrides: Partial<AlignedClaimCell> & Pick<AlignedClaimCell, "modelId" | "stance">): AlignedClaimCell {
  return {
    rawStance: "asserts",
    confidence: "settled",
    excerpt: "excerpt",
    ...overrides,
  };
}

function row(overrides: Partial<AlignedClaim> & Pick<AlignedClaim, "cells">): AlignedClaim {
  return {
    id: "row",
    claimText: "Some proposition",
    agreementScore: 0,
    certaintyScore: 0,
    status: "single_source",
    ...overrides,
  };
}

describe("defaultStanceBasedScore", () => {
  it("single non-null cell is always single_source with score 0", () => {
    const r = defaultStanceBasedScore(row({ cells: [cell({ modelId: "chatgpt", stance: "agrees" })] }));
    expect(r.status).toBe("single_source");
    expect(r.agreementScore).toBe(0);
  });

  it("all agree -> consensus with score 1", () => {
    const r = defaultStanceBasedScore(
      row({
        cells: [
          cell({ modelId: "chatgpt", stance: "agrees" }),
          cell({ modelId: "claude", stance: "agrees" }),
          cell({ modelId: "grok", stance: "agrees" }),
        ],
      })
    );
    expect(r.status).toBe("consensus");
    expect(r.agreementScore).toBe(1);
  });

  it("majority agree with one dispute -> majority status", () => {
    const r = defaultStanceBasedScore(
      row({
        cells: [
          cell({ modelId: "chatgpt", stance: "agrees" }),
          cell({ modelId: "claude", stance: "agrees" }),
          cell({ modelId: "grok", stance: "disputes" }),
        ],
      })
    );
    expect(r.status).toBe("majority");
  });

  it("even split agrees/disputes -> split status", () => {
    const r = defaultStanceBasedScore(
      row({
        cells: [
          cell({ modelId: "chatgpt", stance: "agrees" }),
          cell({ modelId: "claude", stance: "disputes" }),
        ],
      })
    );
    expect(r.status).toBe("split");
  });
});

describe("scoreAgreement: contested_empirical meta-level camp agreement", () => {
  it("boosts a stance-split row to majority when models describe the same camps", () => {
    const camps = [
      { label: "Monetarist view", position: "Money supply growth drives it." },
      { label: "Structuralist view", position: "Supply chains drive it." },
    ];
    const r = scoreAgreement("contested_empirical", [
      row({
        cells: [
          cell({ modelId: "chatgpt", stance: "agrees", camps }),
          cell({ modelId: "claude", stance: "disputes", camps }),
        ],
      }),
    ])[0];

    // Plain stance split would read as "split"; identical camps across
    // models is exactly the meta-agreement the comparator should reward.
    expect(r.status).toBe("majority");
  });

  it("does not change rows with fewer than 2 camp-bearing cells", () => {
    const r = scoreAgreement("contested_empirical", [
      row({
        cells: [
          cell({ modelId: "chatgpt", stance: "agrees" }),
          cell({ modelId: "claude", stance: "disputes" }),
        ],
      }),
    ])[0];
    expect(r.status).toBe("split");
  });
});

describe("scoreAgreement: legal_regulatory jurisdiction_mismatch", () => {
  it("flags a jurisdiction row with disagreeing values, not an ordinary split score", () => {
    const jurisdictionRow = alignScalarField(
      [
        { modelId: "chatgpt", value: "California" },
        { modelId: "claude", value: "California" },
        { modelId: "grok", value: "US federal" },
      ],
      "jurisdiction",
      "Jurisdiction",
      "hard_key"
    );

    const [scored] = scoreAgreement("legal_regulatory", [jurisdictionRow]);
    expect(scored.disagreementType).toBe("jurisdiction_mismatch");
  });

  it("does not flag a non-jurisdiction row (unsettledIssues) even if it disagrees", () => {
    const r = scoreAgreement("legal_regulatory", [
      row({
        id: "some-unsettled-issue",
        cells: [
          cell({ modelId: "chatgpt", stance: "agrees" }),
          cell({ modelId: "claude", stance: "disputes" }),
        ],
      }),
    ])[0];
    expect(r.disagreementType).toBeUndefined();
  });
});

describe("scoreAgreement: factual_lookup hard split on any mismatch", () => {
  it("marks status split when any model's normalized answer diverges", () => {
    const answerRow = alignScalarField(
      [
        { modelId: "chatgpt", value: "1969" },
        { modelId: "claude", value: "1969" },
        { modelId: "grok", value: "1971" },
      ],
      "answer",
      "Year of the event",
      "exact_normalized"
    );
    const [scored] = scoreAgreement("factual_lookup", [answerRow]);
    expect(scored.status).toBe("split");
  });
});

describe("rowEvidenceTierWeight (medical_health run-level weighting)", () => {
  it("weighs an RCT/empirical-tier row 3x an anecdotal-tier row", () => {
    const empiricalRow = row({
      cells: [
        cell({ modelId: "chatgpt", stance: "agrees", evidenceType: "empirical" }),
        cell({ modelId: "claude", stance: "disputes", evidenceType: "empirical" }),
      ],
    });
    const anecdotalRow = row({
      cells: [
        cell({ modelId: "chatgpt", stance: "agrees", evidenceType: "anecdotal" }),
        cell({ modelId: "claude", stance: "disputes", evidenceType: "anecdotal" }),
      ],
    });

    expect(rowEvidenceTierWeight(empiricalRow)).toBe(3);
    expect(rowEvidenceTierWeight(anecdotalRow)).toBe(1);
    expect(rowEvidenceTierWeight(empiricalRow) / rowEvidenceTierWeight(anecdotalRow)).toBe(3);
  });
});
