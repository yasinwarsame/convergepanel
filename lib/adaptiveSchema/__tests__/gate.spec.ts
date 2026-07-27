/**
 * Adaptive Verification Gate Tests (R1d)
 */

import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { AlignedClaim, AlignedClaimCell, AlignedClaimStatus } from "@/lib/adaptiveSchema/types";

function cell(modelId: string): AlignedClaimCell {
  return { modelId: modelId as any, stance: "agrees", rawStance: "asserts", confidence: "settled", excerpt: "x" };
}

function row(id: string, status: AlignedClaimStatus, modelCount: number): AlignedClaim {
  return {
    id,
    claimText: id,
    cells: Array.from({ length: modelCount }, (_, i) => cell(`m${i}`)),
    agreementScore: status === "split" ? 0 : 1,
    certaintyScore: status === "split" ? 0.2 : 0.9,
    status,
  };
}

describe("computeAdaptiveGate", () => {
  it("pass: certainty >= 0.7 and no split among load-bearing claims", () => {
    const rows = [row("a", "consensus", 5), row("b", "consensus", 4), row("c", "majority", 3)];
    const result = computeAdaptiveGate(rows, 0.85, "generic");
    expect(result.status).toBe("pass");
  });

  it("caution: certainty in [0.45, 0.7)", () => {
    const rows = [row("a", "majority", 5)];
    const result = computeAdaptiveGate(rows, 0.55, "generic");
    expect(result.status).toBe("caution");
  });

  it("caution: high certainty but exactly one load-bearing split", () => {
    const rows = [row("a", "split", 5), row("b", "consensus", 4), row("c", "consensus", 3)];
    const result = computeAdaptiveGate(rows, 0.9, "generic");
    expect(result.status).toBe("caution");
    expect(result.loadBearingSplitCount).toBe(1);
  });

  it("fail: certainty below 0.45", () => {
    const rows = [row("a", "split", 5)];
    const result = computeAdaptiveGate(rows, 0.3, "generic");
    expect(result.status).toBe("fail");
  });

  it("fail: two or more load-bearing splits even at high certainty", () => {
    const rows = [row("a", "split", 5), row("b", "split", 4), row("c", "consensus", 3)];
    const result = computeAdaptiveGate(rows, 0.9, "generic");
    expect(result.status).toBe("fail");
    expect(result.loadBearingSplitCount).toBe(2);
  });

  it("only considers the top-3 most-salient claims as load-bearing", () => {
    // 4th claim (lowest salience) is split, but only top 3 count.
    const rows = [
      row("a", "consensus", 5),
      row("b", "consensus", 4),
      row("c", "consensus", 3),
      row("d", "split", 1),
    ];
    const result = computeAdaptiveGate(rows, 0.9, "generic");
    expect(result.status).toBe("pass");
    expect(result.loadBearingClaims.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("factual_lookup: any mismatch caps the gate at caution even with high certainty", () => {
    const rows = [row("answer", "split", 5)];
    const result = computeAdaptiveGate(rows, 0.95, "factual_lookup");
    expect(result.status).toBe("caution");
  });
});
