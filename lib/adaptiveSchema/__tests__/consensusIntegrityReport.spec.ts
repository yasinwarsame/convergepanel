/**
 * Consensus Integrity — report surfaces (D4, D7, D9, D11)
 *
 * limited_coverage rows stay out of every agreement surface (Unified Answer,
 * Where Models Agree, verdict core finding, verdict card); contested rows
 * carry the canonical contested note deterministically; the narrative prompt
 * receives status, coverage and contested facts plus the never-strengthen
 * rules; and a narrative that overstates agreement can't replace the
 * deterministic lines.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { buildAdaptiveUnifiedAnswer, buildAdaptiveVerdict, coreFindingClaim } from "@/lib/adaptiveSchema/verdict";
import { buildAdaptiveVerdictCard } from "@/lib/adaptiveSchema/verdictCard";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { AlignedCellOrigin, AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";

const DISPUTED: AlignedCellOrigin = { kind: "claim", field: "disputedClaims", fieldClass: "disputed" };

function cell(modelId: string, stance: AlignedClaimCell["stance"] = "agrees", extra: Partial<AlignedClaimCell> = {}): AlignedClaimCell {
  return { modelId: modelId as ModelId, stance, rawStance: "asserts", confidence: "settled", excerpt: `${modelId} excerpt`, ...extra };
}

function row(claimText: string, status: AlignedClaim["status"], cells: (AlignedClaimCell | null)[], extra: Partial<AlignedClaim> = {}): AlignedClaim {
  return {
    id: claimText,
    claimText,
    cells,
    agreementScore: status === "split" ? 0.2 : 0.9,
    certaintyScore: status === "split" ? 0.2 : 0.9,
    status,
    ...extra,
  };
}

const FIVE = ["chatgpt", "claude", "grok", "perplexity", "gemini"];

function results(modelIds: string[]): ModelResult[] {
  return modelIds.map((modelId) => ({ modelId: modelId as ModelId, status: "ok", rawText: "{}", latencyMs: 5 }));
}

/** A consensus row all five models listed themselves as disputed, with camps — the polarization pattern. */
function contestedConsensusRow(): AlignedClaim {
  return row(
    "Polarization has increased",
    "consensus",
    FIVE.map((m) => cell(m, "agrees", { origin: DISPUTED, confidence: "contested", camps: [{ label: "A", position: "a" }] })),
    { contested: { marked: 5, assessed: 5 } }
  );
}

/** 2 of 5 agree, 3 silent: limited_coverage after applyConsensusIntegrity. */
function limitedRow(): AlignedClaim {
  return row("Only two models said this", "limited_coverage", [cell("chatgpt"), cell("claude"), null, null, null]);
}

function narrativeResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    executiveSummary: "Summary.",
    whereModelsAgreeNarrative: ["Models agree."],
    whyModelsDisagree: [],
    disagreementStakes: [],
    certaintyAssessment: "Assessment.",
    narrativeSections: [],
    ...overrides,
  });
}

function mockNarrative(overrides: Record<string, unknown> = {}) {
  mockedCallGemini.mockImplementation(async (_msg: any, _ctx: any, _key: any, opts: any) => {
    if (String(opts?.systemPromptOverride ?? "").includes("narrative portion")) {
      return { modelId: "gemini", status: "ok", rawText: narrativeResponse(overrides), latencyMs: 1 };
    }
    return { modelId: "gemini", status: "error", rawText: null, errorMessage: "not under test", latencyMs: 1 };
  });
}

function narrativeCall() {
  return mockedCallGemini.mock.calls.find(([, , , opts]) => String((opts as any)?.systemPromptOverride ?? "").includes("narrative portion"));
}

afterEach(() => jest.clearAllMocks());

describe("Unified Answer", () => {
  const passGate = (rows: AlignedClaim[]) => computeAdaptiveGate(rows, 0.9, "generic");

  it("appends the canonical contested note to a contested consensus claim", () => {
    const rows = [contestedConsensusRow()];
    expect(buildAdaptiveUnifiedAnswer(rows, passGate(rows))).toBe(
      "Polarization has increased (ChatGPT, Claude, Grok, Perplexity, Gemini; all 5 models that took a position mark the underlying claim contested)."
    );
  });

  it("is unchanged for an uncontested claim", () => {
    const rows = [row("Carbon pricing works", "consensus", [cell("chatgpt"), cell("claude"), cell("grok")])];
    expect(buildAdaptiveUnifiedAnswer(rows, passGate(rows))).toBe("Carbon pricing works (ChatGPT, Claude, Grok).");
  });

  it("never states a limited_coverage claim", () => {
    const rows = [row("Broad claim", "consensus", [cell("chatgpt"), cell("claude"), cell("grok")]), limitedRow()];
    const answer = buildAdaptiveUnifiedAnswer(rows, passGate(rows));
    expect(answer).toContain("Broad claim");
    expect(answer).not.toContain("Only two models said this");
  });

  it("when every claim has limited coverage, says so instead of presenting one as agreement", () => {
    const rows = [limitedRow()];
    expect(buildAdaptiveUnifiedAnswer(rows, computeAdaptiveGate(rows, 0.6, "generic"))).toBe(
      "No consensus or majority claims were identified across the panel. 1 claim had positions from half or fewer of the dispatched models — too few to count as agreement."
    );
  });
});

describe("verdict core finding and verdict card", () => {
  it("no fallback: with no consensus/majority row there is no core finding — limited_coverage, split and single_source are never picked (R1 F1)", () => {
    const split = row("Split claim", "split", [cell("chatgpt"), cell("claude", "disputes")]);
    const single = row("Lone claim", "single_source", [cell("chatgpt"), null, null, null, null]);
    expect(coreFindingClaim([limitedRow(), split, single])).toBeNull();
    expect(coreFindingClaim([limitedRow()])).toBeNull();
    const gate = computeAdaptiveGate([limitedRow()], 0.6, "generic");
    const verdict = buildAdaptiveVerdict([limitedRow(), split], gate, 5);
    expect(verdict.coreFinding).toBe("No consensus identified.");
    expect(verdict.convergingModelCount).toBe(0);
    expect(verdict.summary).toBe("No consensus identified. Certainty 60%; gate: caution.");
  });

  it("topConsensusContested carries the canonical note for a contested top claim, and is absent otherwise", () => {
    const contested = [contestedConsensusRow()];
    const card = buildAdaptiveVerdictCard("Q", contested, computeAdaptiveGate(contested, 0.9, "generic"), []);
    expect(card.topConsensus).toBe("Polarization has increased");
    expect(card.topConsensusContested).toBe("all 5 models that took a position mark the underlying claim contested");

    const plain = [row("Plain", "consensus", [cell("chatgpt"), cell("claude"), cell("grok")])];
    const plainCard = buildAdaptiveVerdictCard("Q", plain, computeAdaptiveGate(plain, 0.9, "generic"), []);
    expect("topConsensusContested" in plainCard).toBe(false);
  });

  it("a limited_coverage row never becomes the verdict card's top consensus", () => {
    const rows = [limitedRow()];
    const card = buildAdaptiveVerdictCard("Q", rows, computeAdaptiveGate(rows, 0.6, "generic"), []);
    expect(card.topConsensus).toBe("No consensus identified.");
    expect(card.consensusModelCount).toBe(0);
  });
});

describe("synthesis report: template (degraded) path", () => {
  beforeEach(() => mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, errorMessage: "down", latencyMs: 1 }));

  it("limited rows are counted separately and never listed as agreement", async () => {
    const rows = [row("Broad claim", "consensus", [cell("chatgpt"), cell("claude"), cell("grok")]), limitedRow()];
    const report = await buildAdaptiveSynthesisReport("Q", "generic", rows, results(FIVE));
    expect(report.whereModelsAgree).toEqual(["Broad claim"]);
    expect(report.certaintyAssessment).toMatch(/1 claim\(s\) at consensus\/majority, 1 with limited coverage, 0 split\.$/);
    expect(report.executiveSummary).toContain(
      "1 further claim had positions from half or fewer of the dispatched models, too few to count as agreement."
    );
  });

  it("with no limited rows the template text is exactly what it was", async () => {
    const rows = [row("Broad claim", "consensus", [cell("chatgpt"), cell("claude"), cell("grok")])];
    const report = await buildAdaptiveSynthesisReport("Q", "generic", rows, results(FIVE));
    expect(report.certaintyAssessment).toMatch(/\. 1 claim\(s\) at consensus\/majority, 0 split\.$/);
    expect(report.executiveSummary).not.toContain("further claim");
  });

  it("a contested agree row's line carries the canonical note", async () => {
    const report = await buildAdaptiveSynthesisReport("Q", "contested_empirical", [contestedConsensusRow()], results(FIVE));
    expect(report.whereModelsAgree).toEqual(["Polarization has increased — all 5 models that took a position mark the underlying claim contested"]);
  });
});

describe("synthesis report: narrative prompt construction (D9)", () => {
  it("the system prompt carries every never-strengthen rule", async () => {
    mockNarrative();
    await buildAdaptiveSynthesisReport("Q", "generic", [limitedRow()], results(FIVE));
    const systemPrompt = String((narrativeCall()![3] as any).systemPromptOverride);
    expect(systemPrompt).toContain("The status of every claim is final");
    expect(systemPrompt).toContain('"limited_coverage": half or fewer of the dispatched models took a position on it. Never call it agreement, consensus or a majority view');
    expect(systemPrompt).toContain('"split": the models disagree. Never call it a majority view or consensus.');
    expect(systemPrompt).toContain("never present it as settled");
    expect(systemPrompt).toContain("A model that was silent on a claim, or failed, did not agree with it.");
    expect(systemPrompt).toContain("one short sentence per consensus/majority claim only (never a limited_coverage or split claim)");
  });

  it("each row reaches the model with explicit status, coverage and contested facts", async () => {
    mockNarrative();
    await buildAdaptiveSynthesisReport("Q", "contested_empirical", [limitedRow(), contestedConsensusRow()], results(FIVE));
    const userMessage = String(narrativeCall()![0]);
    expect(userMessage).toContain('- "Only two models said this" — status: limited_coverage, positions: 2 of 5 dispatched models,');
    expect(userMessage).toContain('- "Polarization has increased" — status: consensus, positions: 5 of 5 dispatched models,');
    expect(userMessage).toContain('contested note: "all 5 models that took a position mark the underlying claim contested"');
  });
});

describe("synthesis report: a narrative that overstates agreement can't replace the deterministic lines", () => {
  it("more agree sentences than consensus/majority rows (e.g. one for a limited_coverage claim) → deterministic lines", async () => {
    mockNarrative({
      whereModelsAgreeNarrative: ["All five models agree on the broad claim.", "All five models agree only two models said this."],
    });
    const rows = [row("Broad claim", "consensus", [cell("chatgpt"), cell("claude"), cell("grok")]), limitedRow()];
    const report = await buildAdaptiveSynthesisReport("Q", "generic", rows, results(FIVE));
    expect(report.degraded).toBe(false);
    expect(report.whereModelsAgree).toEqual(["Broad claim"]);
  });

  it("agree sentences when there is no consensus/majority row at all → none", async () => {
    mockNarrative({ whereModelsAgreeNarrative: ["Strong consensus that only two models said this."] });
    const report = await buildAdaptiveSynthesisReport("Q", "generic", [limitedRow()], results(FIVE));
    expect(report.whereModelsAgree).toEqual([]);
  });

  it("a contested agree row keeps the canonical note even when the narrative calls it settled", async () => {
    mockNarrative({ whereModelsAgreeNarrative: ["All models agree polarization has increased; this is settled."] });
    const report = await buildAdaptiveSynthesisReport("Q", "contested_empirical", [contestedConsensusRow()], results(FIVE));
    expect(report.whereModelsAgree).toEqual(["Polarization has increased — all 5 models that took a position mark the underlying claim contested"]);
  });

  it("an honest narrative (one sentence per agree row, nothing contested) is still used", async () => {
    mockNarrative({ whereModelsAgreeNarrative: ["Three models agree on the broad claim."] });
    const rows = [row("Broad claim", "consensus", [cell("chatgpt"), cell("claude"), cell("grok")]), limitedRow()];
    const report = await buildAdaptiveSynthesisReport("Q", "generic", rows, results(FIVE));
    expect(report.whereModelsAgree).toEqual(["Three models agree on the broad claim."]);
  });

  it("the deterministic surfaces never take the narrative's word: unified answer, verdict, card, gate", async () => {
    mockNarrative({ executiveSummary: "All five models agree only two models said this." });
    const rows = [limitedRow()];
    const report = await buildAdaptiveSynthesisReport("Q", "generic", rows, results(FIVE));
    expect(report.unifiedAnswer).toContain("too few to count as agreement");
    expect(report.verdictCard.topConsensus).toBe("No consensus identified.");
    expect(report.panelVerdict).toBe("No consensus identified. Certainty 90%; gate: pass.");
    expect(report.panelVerdict).not.toMatch(/converge/);
  });
});
