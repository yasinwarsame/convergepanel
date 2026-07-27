/**
 * Panel Verdict + Unified Answer Tests (R1e)
 */

import { buildAdaptiveVerdict, buildAdaptiveUnifiedAnswer } from "@/lib/adaptiveSchema/verdict";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { AlignedClaim, AlignedClaimCell, AlignedClaimStatus } from "@/lib/adaptiveSchema/types";

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

describe("buildAdaptiveVerdict", () => {
  it("cites the core finding, converging model count, certainty, and gate", () => {
    const rows = [row("Carbon pricing works", "consensus", [cell("chatgpt"), cell("claude"), cell("grok")])];
    const gate = computeAdaptiveGate(rows, 0.9, "generic");
    const verdict = buildAdaptiveVerdict(rows, gate, 5);

    expect(verdict.summary).toBe("3/5 models converge on Carbon pricing works; certainty 90%; gate: pass.");
    expect(verdict.coreFinding).toBe("Carbon pricing works");
    expect(verdict.convergingModelCount).toBe(3);
  });

  it("falls back to a neutral finding when there are no consensus/majority claims", () => {
    const rows = [row("Disputed thing", "split", [cell("chatgpt", "disputes"), cell("claude", "agrees")])];
    const gate = computeAdaptiveGate(rows, 0.3, "generic");
    const verdict = buildAdaptiveVerdict(rows, gate, 5);
    expect(verdict.summary).toContain("gate: fail");
  });
});

describe("buildAdaptiveUnifiedAnswer", () => {
  it("cites supporting models for each consensus/majority claim", () => {
    const rows = [row("Claim A", "consensus", [cell("chatgpt"), cell("claude")])];
    const gate = computeAdaptiveGate(rows, 0.9, "generic");
    const answer = buildAdaptiveUnifiedAnswer(rows, gate);
    expect(answer).toContain("Claim A");
    // Cites the resolved display name (MODEL_INFO), not the raw modelId.
    expect(answer).toMatch(/GPT|Claude/i);
  });

  it("never returns a confident synthesis on gate fail — replaced by 'could not converge' plus split claims", () => {
    const rows = [
      row("Consensus claim", "consensus", [cell("chatgpt"), cell("claude")]),
      row("Split claim", "split", [cell("grok", "disputes"), cell("perplexity", "agrees")]),
    ];
    const gate = computeAdaptiveGate(rows, 0.2, "generic");
    expect(gate.status).toBe("fail");

    const answer = buildAdaptiveUnifiedAnswer(rows, gate);
    expect(answer).toContain("Panel could not converge");
    expect(answer).toContain("Split claim");
    expect(answer).not.toContain("Consensus claim");
  });

  it("returns a neutral message when there are no consensus/majority claims but the gate isn't fail", () => {
    const rows = [row("Only claim", "majority", [cell("chatgpt")])]; // single_source-ish, low salience
    const gate = computeAdaptiveGate(rows, 0.5, "generic");
    const answer = buildAdaptiveUnifiedAnswer(rows, gate);
    expect(answer).toContain("Only claim");
  });
});
