/**
 * Panel Verdict Card Tests (A4)
 */

import { buildAdaptiveVerdictCard } from "@/lib/adaptiveSchema/verdictCard";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { AlignedClaim, AlignedClaimCell, AlignedClaimStatus, AdaptiveBiasFinding } from "@/lib/adaptiveSchema/types";

function cell(modelId: string, stance: AlignedClaimCell["stance"] = "agrees"): AlignedClaimCell {
  return { modelId: modelId as any, stance, rawStance: "asserts", confidence: "settled", excerpt: "x" };
}

function row(id: string, status: AlignedClaimStatus, cells: AlignedClaimCell[]): AlignedClaim {
  return {
    id,
    claimText: id,
    cells,
    agreementScore: status === "split" ? 0.2 : 0.9,
    certaintyScore: status === "split" ? 0.2 : 0.9,
    status,
  };
}

function bias(description: string): AdaptiveBiasFinding {
  return {
    biasType: "Test bias",
    description,
    modelsImplicated: ["chatgpt" as any],
    evidence: [{ modelId: "chatgpt" as any, excerpt: "x", rationale: "y" }],
    likelyCauses: [],
    impact: "",
    mitigationSteps: [],
  };
}

describe("buildAdaptiveVerdictCard", () => {
  it("restates the question and cites the top consensus claim with its supporting model count", () => {
    const rows = [row("Carbon pricing works", "consensus", [cell("chatgpt"), cell("claude"), cell("grok")])];
    const gate = computeAdaptiveGate(rows, 0.9, "generic");
    const card = buildAdaptiveVerdictCard("Does carbon pricing work?", rows, gate, []);

    expect(card.question).toBe("Does carbon pricing work?");
    expect(card.topConsensus).toBe("Carbon pricing works");
    expect(card.consensusModelCount).toBe(3);
    expect(card.keyDisagreement).toBeNull();
    expect(card.caveat).toBeNull();
  });

  it("cites the top split claim as keyDisagreement with a detail line", () => {
    const rows = [
      row("Consensus claim", "consensus", [cell("chatgpt"), cell("claude")]),
      row("Split claim", "split", [cell("grok", "disputes"), cell("perplexity", "agrees")]),
    ];
    const gate = computeAdaptiveGate(rows, 0.5, "generic");
    const card = buildAdaptiveVerdictCard("Q", rows, gate, []);

    expect(card.keyDisagreement).toBe("Split claim");
    expect(card.disagreementDetail).toBeTruthy();
    expect(card.disagreementModelCount).toBe(2);
  });

  it("surfaces a jurisdiction_mismatch disagreementType as the detail line", () => {
    const splitRow = row("Jurisdiction claim", "split", [cell("chatgpt", "disputes"), cell("claude", "agrees")]);
    splitRow.disagreementType = "jurisdiction_mismatch";
    const gate = computeAdaptiveGate([splitRow], 0.5, "legal_regulatory");
    const card = buildAdaptiveVerdictCard("Q", [splitRow], gate, []);

    expect(card.disagreementDetail).toContain("jurisdiction mismatch");
  });

  it("uses the top bias finding's description as the caveat", () => {
    const rows = [row("Consensus claim", "consensus", [cell("chatgpt"), cell("claude")])];
    const gate = computeAdaptiveGate(rows, 0.9, "generic");
    const card = buildAdaptiveVerdictCard("Q", rows, gate, [bias("Models over-rely on Western examples.")]);

    expect(card.caveat).toBe("Models over-rely on Western examples.");
  });

  it("returns gate-appropriate recommended next steps, capped at 3", () => {
    const rows = [row("Consensus claim", "consensus", [cell("chatgpt"), cell("claude")])];
    const passGate = computeAdaptiveGate(rows, 0.9, "generic");
    const failRows = [row("Split claim", "split", [cell("chatgpt", "disputes"), cell("claude", "agrees")])];
    const failGate = computeAdaptiveGate(failRows, 0.1, "generic");

    const passCard = buildAdaptiveVerdictCard("Q", rows, passGate, []);
    const failCard = buildAdaptiveVerdictCard("Q", failRows, failGate, []);

    expect(passCard.recommendedNextSteps.length).toBeLessThanOrEqual(3);
    expect(failCard.recommendedNextSteps.length).toBeLessThanOrEqual(3);
    expect(passCard.recommendedNextSteps).not.toEqual(failCard.recommendedNextSteps);
    expect(failCard.recommendedNextSteps.join(" ")).toMatch(/[Dd]on't act|not converge/);
  });

  it("falls back to a neutral message when there are no claims at all", () => {
    const gate = computeAdaptiveGate([], 0, "generic");
    const card = buildAdaptiveVerdictCard("Q", [], gate, []);
    expect(card.topConsensus).toBe("No consensus identified.");
    expect(card.keyDisagreement).toBeNull();
  });

  it("falls back to the top split claim (not a neutral message) when there are claims but no consensus/majority among them", () => {
    // coreFindingClaim's pool falls back to ALL rows when none are consensus/majority —
    // this mirrors legacy behavior exactly (verdict.spec.ts's equivalent test only
    // asserts the gate, not a "No consensus" placeholder, for this exact case).
    const rows = [row("Split claim", "split", [cell("chatgpt", "disputes"), cell("claude", "agrees")])];
    const gate = computeAdaptiveGate(rows, 0.2, "generic");
    const card = buildAdaptiveVerdictCard("Q", rows, gate, []);
    expect(card.topConsensus).toBe("Split claim");
  });
});
