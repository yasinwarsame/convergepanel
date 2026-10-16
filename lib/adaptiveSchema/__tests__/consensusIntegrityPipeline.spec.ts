/**
 * Consensus Integrity — end-to-end through finalizeAdaptiveRun (D11)
 *
 * Real validation → alignment → comparator → applyConsensusIntegrity →
 * certainty → gate → synthesis, with only the Gemini helper calls stubbed
 * (all fail, so every helper degrades to its deterministic path and the
 * outputs are exact):
 * - the polarization pattern: every model files the claim as disputed with
 *   camps, one model "uncertain" — the row stays a position consensus, and
 *   every agreement surface says the underlying claim is contested;
 * - dispatched-panel coverage: 2 agreeing models + 3 FAILED models is
 *   limited_coverage (measured against the 5 dispatched, not the 2 that
 *   answered), while 3 + 2 failed stays consensus;
 * - the removed split→majority upgrade: a 2–2 split with identical camps is
 *   now "split", certainty is unchanged, and the gate becomes stricter
 *   (pass → caution) — the one owner-approved gate change.
 */

jest.mock("@/lib/env", () => ({
  ADAPTIVE_VERIFICATION_ENABLED: true,
  GEMINI_API_KEY: "test-key",
}));

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { CERTAINTY_WEIGHTS, STATED_CONFIDENCE_SCORE } from "@/lib/adaptiveSchema/config";
import { ModelId, ModelResult } from "@/lib/types";

type ClaimJson = { id: string; claim: string; stance: "asserts" | "disputes" | "uncertain"; confidence: string; evidenceType: string; camps?: { label: string; position: string }[] };

function contestedResponse({ settled = [], disputed = [] }: { settled?: ClaimJson[]; disputed?: ClaimJson[] }): string {
  return JSON.stringify({
    summary: "The question is debated.",
    settledClaims: settled,
    disputedClaims: disputed,
    keyMetrics: [],
    openQuestions: [],
  });
}

function ok(modelId: string, rawText: string): ModelResult {
  return { modelId: modelId as ModelId, status: "ok", rawText, latencyMs: 5 };
}

function failed(modelId: string): ModelResult {
  return { modelId: modelId as ModelId, status: "error", rawText: null, errorMessage: "provider down", latencyMs: 5 };
}

const CAMPS = [
  { label: "Structural camp", position: "Institutions drive it." },
  { label: "Media camp", position: "Media drives it." },
];

beforeEach(() => {
  mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, errorMessage: "helpers off", latencyMs: 1 });
});
afterEach(() => jest.clearAllMocks());

describe("polarization pattern (P1-A)", () => {
  it("five models file the claim as disputed with camps, one uncertain: position consensus, contested on its own axis, and every agreement surface says so", async () => {
    const disputedClaim = (stance: ClaimJson["stance"]): ClaimJson => ({
      id: "polarization-has-increased",
      claim: "Political polarization has increased over the last decade.",
      stance,
      confidence: "contested",
      evidenceType: "empirical",
      camps: CAMPS,
    });
    const results = [
      ok("chatgpt", contestedResponse({ disputed: [disputedClaim("asserts")] })),
      ok("claude", contestedResponse({ disputed: [disputedClaim("asserts")] })),
      ok("grok", contestedResponse({ disputed: [disputedClaim("asserts")] })),
      ok("gemini", contestedResponse({ disputed: [disputedClaim("asserts")] })),
      ok("perplexity", contestedResponse({ disputed: [disputedClaim("uncertain")] })),
    ];

    const out = await finalizeAdaptiveRun(SCHEMA_REGISTRY.contested_empirical, results, "Has polarization increased?");
    const [row] = out.alignedClaims!;

    // Positions: 4 agree + 1 unclear → still a position consensus (the panel does take this position)...
    expect(row.status).toBe("consensus");
    // ...but all five listed it as disputed: the contested axis, separately.
    expect(row.contested).toEqual({ marked: true, assessed: false, markedCount: 5, listedCount: 5 });
    for (const c of row.cells) expect(c!.origin).toEqual({ kind: "claim", field: "disputedClaims", fieldClass: "disputed" });

    const report = out.synthesisReport!;
    expect(report.unifiedAnswer).toBe(
      "Political polarization has increased over the last decade. (ChatGPT, Claude, Grok, Gemini; all 5 models that listed this claim mark it contested)."
    );
    expect(report.whereModelsAgree).toEqual([
      "Political polarization has increased over the last decade. — all 5 models that listed this claim mark it contested",
    ]);
    expect(report.verdictCard.topConsensusContested).toBe("all 5 models that listed this claim mark it contested");
  });

  it("a settled-field claim the panel agrees on carries no contested note", async () => {
    const settledClaim: ClaimJson = { id: "emissions-fell", claim: "Emissions fell.", stance: "asserts", confidence: "settled", evidenceType: "empirical" };
    const results = ["chatgpt", "claude", "grok"].map((m) => ok(m, contestedResponse({ settled: [settledClaim] })));
    const out = await finalizeAdaptiveRun(SCHEMA_REGISTRY.contested_empirical, results, "Q");
    const [row] = out.alignedClaims!;
    expect(row.status).toBe("consensus");
    expect(row.contested).toEqual({ marked: false, assessed: false, markedCount: 0, listedCount: 3 });
    expect(out.synthesisReport!.unifiedAnswer).toBe("Emissions fell. (ChatGPT, Claude, Grok).");
    expect("topConsensusContested" in out.synthesisReport!.verdictCard).toBe(false);
  });
});

describe("coverage is measured against the DISPATCHED panel, failed models included", () => {
  const sharedClaim: ClaimJson = { id: "shared-claim", claim: "A shared claim.", stance: "asserts", confidence: "settled", evidenceType: "empirical" };

  it("2 agreeing + 3 failed of 5 dispatched → limited_coverage, kept out of every agreement surface", async () => {
    const results = [
      ok("chatgpt", contestedResponse({ settled: [sharedClaim] })),
      ok("claude", contestedResponse({ settled: [sharedClaim] })),
      failed("grok"),
      failed("gemini"),
      failed("perplexity"),
    ];
    const out = await finalizeAdaptiveRun(SCHEMA_REGISTRY.contested_empirical, results, "Q");
    const [row] = out.alignedClaims!;
    expect(row.cells.filter(Boolean)).toHaveLength(2);
    expect(row.status).toBe("limited_coverage");

    const report = out.synthesisReport!;
    expect(report.whereModelsAgree).toEqual([]);
    expect(report.unifiedAnswer).toContain("too few to count as agreement");
    expect(report.verdictCard.topConsensus).toBe("No consensus identified.");
  });

  it("3 agreeing + 2 failed of 5 dispatched → stays consensus", async () => {
    const results = [
      ok("chatgpt", contestedResponse({ settled: [sharedClaim] })),
      ok("claude", contestedResponse({ settled: [sharedClaim] })),
      ok("grok", contestedResponse({ settled: [sharedClaim] })),
      failed("gemini"),
      failed("perplexity"),
    ];
    const out = await finalizeAdaptiveRun(SCHEMA_REGISTRY.contested_empirical, results, "Q");
    expect(out.alignedClaims![0].status).toBe("consensus");
    expect(out.synthesisReport!.whereModelsAgree).toEqual(["A shared claim."]);
  });

  it("the limited relabel does not move certainty or the gate: same certainty as the identical 2-of-5 consensus row", async () => {
    const results = [
      ok("chatgpt", contestedResponse({ settled: [sharedClaim] })),
      ok("claude", contestedResponse({ settled: [sharedClaim] })),
      failed("grok"),
      failed("gemini"),
      failed("perplexity"),
    ];
    const out = await finalizeAdaptiveRun(SCHEMA_REGISTRY.contested_empirical, results, "Q");
    // coverage 2/5, agreement 1 (2 agrees), stated confidence settled (1.0).
    const expected = CERTAINTY_WEIGHTS.coverage * (2 / 5) + CERTAINTY_WEIGHTS.agreement * 1 + CERTAINTY_WEIGHTS.statedConfidence * STATED_CONFIDENCE_SCORE.settled;
    expect(out.alignedClaims![0].certaintyScore).toBe(expected);
    expect(out.gate!.runCertainty).toBe(expected);
    expect(out.gate!.status).toBe("pass"); // certainty 0.79 ≥ 0.7 and no split — as before the relabel
  });
});

describe("removed split→majority upgrade (D5)", () => {
  it("a 2–2 split with identical camps stays split; certainty unchanged; the gate becomes stricter (pass → caution)", async () => {
    const claimWith = (stance: ClaimJson["stance"]): ClaimJson => ({
      id: "mechanism-x-dominates",
      claim: "Mechanism X dominates.",
      stance,
      confidence: "contested",
      evidenceType: "theoretical",
      camps: CAMPS,
    });
    const results = [
      ok("chatgpt", contestedResponse({ disputed: [claimWith("asserts")] })),
      ok("claude", contestedResponse({ disputed: [claimWith("asserts")] })),
      ok("grok", contestedResponse({ disputed: [claimWith("disputes")] })),
      ok("gemini", contestedResponse({ disputed: [claimWith("disputes")] })),
    ];
    const out = await finalizeAdaptiveRun(SCHEMA_REGISTRY.contested_empirical, results, "Q");
    const [row] = out.alignedClaims!;

    // Before Consensus Integrity the camp overlap (Jaccard 1 ≥ 0.6) relabelled this "majority".
    expect(row.status).toBe("split");
    // The blended score is untouched: 0.5 × stance (0.5) + 0.5 × camps (1) = 0.75.
    expect(row.agreementScore).toBeCloseTo(0.75, 12);
    const expectedCertainty =
      CERTAINTY_WEIGHTS.coverage * 1 + CERTAINTY_WEIGHTS.agreement * row.agreementScore + CERTAINTY_WEIGHTS.statedConfidence * STATED_CONFIDENCE_SCORE.contested;
    expect(row.certaintyScore).toBe(expectedCertainty);
    expect(out.gate!.runCertainty).toBe(expectedCertainty);
    expect(expectedCertainty).toBeGreaterThanOrEqual(0.7);

    // Old: 0 load-bearing splits at certainty ≥ 0.7 → "pass". Now 1 → "caution" (owner-approved, stricter only).
    expect(out.gate!.loadBearingSplitCount).toBe(1);
    expect(out.gate!.status).toBe("caution");
    expect(out.synthesisReport!.whereModelsDisagree).toEqual(["Mechanism X dominates."]);
    // R1 F1: the corrected split is never presented as agreement on the verdict card or panel verdict.
    expect(out.synthesisReport!.verdictCard.topConsensus).toBe("No consensus identified.");
    expect(out.synthesisReport!.verdictCard.consensusModelCount).toBe(0);
    expect(out.synthesisReport!.verdictCard.keyDisagreement).toBe("Mechanism X dominates.");
    expect(out.synthesisReport!.panelVerdict).toBe(`No consensus identified. Certainty ${Math.round(expectedCertainty * 100)}%; gate: caution.`);
  });
});

describe("D1: marked and assessed are independent on the real pipeline (all four states)", () => {
  const claimAs = (stance: ClaimJson["stance"], confidence: string): ClaimJson => ({
    id: "same-claim",
    claim: "Same claim about the evidence.",
    stance,
    confidence,
    evidenceType: "empirical",
  });
  const four = ["chatgpt", "claude", "grok", "gemini"];
  async function contestedOf(responses: string[]) {
    const out = await finalizeAdaptiveRun(SCHEMA_REGISTRY.contested_empirical, responses.map((r, i) => ok(four[i], r)), "Q");
    return out.alignedClaims![0];
  }

  it("neither: settled field, everyone asserts", async () => {
    const row = await contestedOf(four.map(() => contestedResponse({ settled: [claimAs("asserts", "settled")] })));
    expect(row.contested).toEqual({ marked: false, assessed: false, markedCount: 0, listedCount: 4 });
  });

  it("marked only: disputed field, everyone asserts — the polarization pattern", async () => {
    const row = await contestedOf(four.map(() => contestedResponse({ disputed: [claimAs("asserts", "contested")] })));
    expect(row.status).toBe("consensus");
    expect(row.contested).toEqual({ marked: true, assessed: false, markedCount: 4, listedCount: 4 });
  });

  it("assessed only: settled field, 2 assert / 2 dispute", async () => {
    const row = await contestedOf(four.map((_, i) => contestedResponse({ settled: [claimAs(i < 2 ? "asserts" : "disputes", "settled")] })));
    expect(row.status).toBe("split");
    expect(row.contested).toEqual({ marked: false, assessed: true, markedCount: 0, listedCount: 4 });
  });

  it("both: disputed field, 2 assert / 2 dispute", async () => {
    const row = await contestedOf(four.map((_, i) => contestedResponse({ disputed: [claimAs(i < 2 ? "asserts" : "disputes", "contested")] })));
    expect(row.contested).toEqual({ marked: true, assessed: true, markedCount: 4, listedCount: 4 });
  });

  it("the contested dimensions never move certainty or the gate: same rows with the axis stripped score identically", async () => {
    const responses = four.map((_, i) => contestedResponse({ disputed: [claimAs(i < 2 ? "asserts" : "disputes", "contested")] }));
    const out = await finalizeAdaptiveRun(SCHEMA_REGISTRY.contested_empirical, responses.map((r, i) => ok(four[i], r)), "Q");
    const { computeRunCertainty } = await import("@/lib/adaptiveSchema/scoring");
    const { computeAdaptiveGate } = await import("@/lib/adaptiveSchema/gate");
    const stripped = out.alignedClaims!.map(({ contested: _c, ...r }) => r);
    const certainty = computeRunCertainty(stripped, "contested_empirical");
    expect(certainty).toBe(out.gate!.runCertainty);
    expect(computeAdaptiveGate(stripped, certainty, "contested_empirical").status).toBe(out.gate!.status);
  });
});
