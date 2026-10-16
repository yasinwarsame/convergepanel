/**
 * D9 narrative integrity (R1 N3)
 *
 * Unit: agreement-claim detection (panel / unanimous / majority vs subgroup
 * and negation), row attribution, and the status rules. Integration: the R1
 * addendum's reproduction — a mocked narrative that calls a limited_coverage
 * row agreement — plus split, single_source and no-consensus variants, each
 * falling back to the deterministic text; legitimate consensus, majority and
 * subgroup wording kept.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import {
  agreeLinesHonest,
  agreementClaimLevel,
  attributeSentence,
  overstatesRow,
  overstatingSentences,
} from "@/lib/adaptiveSchema/narrativeIntegrity";
import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";

const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"] as ModelId[];

function cell(m: ModelId, stance: AlignedClaimCell["stance"]): AlignedClaimCell {
  return { modelId: m, stance, rawStance: "asserts", confidence: "settled", excerpt: "e", origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } };
}

function row(claimText: string, status: AlignedClaim["status"], stances: AlignedClaimCell["stance"][]): AlignedClaim {
  return {
    id: claimText,
    claimText,
    cells: M.map((m, i) => (i < stances.length ? cell(m, stances[i]) : null)),
    agreementScore: 0.5,
    certaintyScore: 0.5,
    status,
  };
}

// The R1 addendum's reproduction shape: 5 dispatched, a-one consensus 3/5, b-two limited 2/5, d-four split.
const A_ONE = () => row("Inflation expectations anchor wage growth", "consensus", ["agrees", "agrees", "agrees"]);
const B_TWO = () => row("Central bank credibility drives bond yields", "limited_coverage", ["agrees", "agrees"]);
const D_FOUR = () => row("Supply shocks explain persistent core inflation", "split", ["agrees", "disputes", "disputes", "agrees", "disputes"]);
const LONE = () => row("Housing costs lag policy rates by two years", "single_source", ["agrees"]);
const MAJ = () => row("Tariffs raise consumer prices measurably", "majority", ["agrees", "agrees", "agrees", "disputes", "partial"]);
const FULL = () => row("Money supply growth preceded the spike", "consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"]);

describe("agreementClaimLevel: what counts as a panel/majority agreement claim", () => {
  it.each([
    ["The models agree that central bank credibility drives bond yields.", "panel"],
    ["Models broadly converge on the role of supply shocks.", "panel"],
    ["There is broad consensus that housing costs lag policy rates.", "panel"],
    ["The panel agrees supply shocks explain inflation.", "panel"],
    ["All five models agree tariffs raise prices.", "unanimous"],
    ["Every model agrees on the claim.", "unanimous"],
    ["The panel was unanimous about money supply.", "unanimous"],
    ["Most models agree tariffs raise consumer prices.", "majority"],
    ["A majority of models hold that tariffs raise prices.", "majority"],
  ])("%s → %s", (sentence, level) => {
    expect(agreementClaimLevel(sentence)).toBe(level);
  });

  it.each([
    "Two models agree that supply shocks explain inflation, while the other assessed models disagree.",
    "Three models agree on this, but two dispute it.",
    "Some models agree with this view.",
    "There is no consensus on supply shocks.",
    "The models do not agree on supply shocks.",
    "The models disagree about supply shocks.",
    "The panel lacks consensus here.",
    "ChatGPT and Claude argue that credibility matters.",
  ])("not a panel claim: %s", (sentence) => {
    expect(agreementClaimLevel(sentence)).toBeNull();
  });
});

describe("status rules", () => {
  it("ineligible rows (limited_coverage, split, single_source) admit no panel or majority agreement claim", () => {
    for (const r of [B_TWO(), D_FOUR(), LONE()]) {
      for (const level of ["majority", "panel", "unanimous"] as const) expect(overstatesRow(level, r, 5)).toBe(true);
    }
  });

  it("majority rows admit majority language only", () => {
    expect(overstatesRow("majority", MAJ(), 5)).toBe(false);
    expect(overstatesRow("panel", MAJ(), 5)).toBe(true);
    expect(overstatesRow("unanimous", MAJ(), 5)).toBe(true);
  });

  it("consensus rows admit panel language; unanimity only when every dispatched model agreed", () => {
    expect(overstatesRow("panel", A_ONE(), 5)).toBe(false);
    expect(overstatesRow("unanimous", A_ONE(), 5)).toBe(true); // 3 of 5 agreed, 2 silent
    expect(overstatesRow("unanimous", FULL(), 5)).toBe(false);
  });

  it("an unknown status is never treated as eligible", () => {
    expect(overstatesRow("panel", { ...A_ONE(), status: "some_future_status" as any }, 5)).toBe(true);
  });
});

describe("attributeSentence ties a sentence to the structured row it is about", () => {
  const rows = [A_ONE(), B_TWO(), D_FOUR()];
  it("by content, not by position", () => {
    expect(attributeSentence("Every model agrees central bank credibility drives bond yields.", rows)!.claimText).toBe(B_TWO().claimText);
    expect(attributeSentence("Models agree inflation expectations anchor wage growth.", rows)!.claimText).toBe(A_ONE().claimText);
    expect(attributeSentence("Models agree the weather was nice.", rows)).toBeNull();
  });
});

describe("overstatingSentences", () => {
  it("the R1 addendum sentence about the limited row is caught; the same claim about the consensus row is not", () => {
    const rows = [A_ONE(), B_TWO(), D_FOUR()];
    expect(overstatingSentences("Every model agrees central bank credibility drives bond yields.", rows, 5)).toHaveLength(1);
    expect(overstatingSentences("The models agree that inflation expectations anchor wage growth.", rows, 5)).toHaveLength(0);
  });

  it("split: whole-panel or majority agreement is caught, an accurate subgroup statement is not", () => {
    const rows = [A_ONE(), D_FOUR()];
    expect(overstatingSentences("The models agree supply shocks explain persistent core inflation.", rows, 5)).toHaveLength(1);
    expect(overstatingSentences("Most models agree supply shocks explain persistent core inflation.", rows, 5)).toHaveLength(1);
    expect(
      overstatingSentences("Two models agree supply shocks explain persistent core inflation, while three assessed models disagree.", rows, 5)
    ).toHaveLength(0);
  });

  it("single_source: 'the models converge' is caught", () => {
    expect(overstatingSentences("The models converge on housing costs lagging policy rates by two years.", [A_ONE(), LONE()], 5)).toHaveLength(1);
  });

  it("no consensus at all: an unattributed 'broad consensus' sentence is caught; with an eligible row it is not attributed blame", () => {
    expect(overstatingSentences("There is broad consensus that prices will fall.", [D_FOUR(), LONE()], 5)).toHaveLength(1);
    expect(overstatingSentences("There is broad consensus that prices will fall.", [A_ONE(), D_FOUR()], 5)).toHaveLength(0);
  });

  it("a subject row is used for sentences that match no row (a split topic's explanation)", () => {
    expect(overstatingSentences("Ultimately the models agree on the mechanism.", [A_ONE(), D_FOUR()], 5, D_FOUR())).toHaveLength(1);
    expect(overstatingSentences("They weigh different evidence.", [A_ONE(), D_FOUR()], 5, D_FOUR())).toHaveLength(0);
  });

  it("majority row: majority wording passes, unanimity wording is caught", () => {
    const rows = [MAJ()];
    expect(overstatingSentences("Most models agree tariffs raise consumer prices measurably.", rows, 5)).toHaveLength(0);
    expect(overstatingSentences("All models agree tariffs raise consumer prices measurably.", rows, 5)).toHaveLength(1);
  });
});

describe("agreeLinesHonest", () => {
  it("every line must be about an eligible row and not overstate it", () => {
    const rows = [A_ONE(), B_TWO(), D_FOUR()];
    expect(agreeLinesHonest(["Models agree inflation expectations anchor wage growth."], rows, 5)).toBe(true);
    expect(agreeLinesHonest(["Every model agrees central bank credibility drives bond yields."], rows, 5)).toBe(false);
    expect(agreeLinesHonest(["Something unrelated entirely."], rows, 5)).toBe(false);
    expect(agreeLinesHonest(["All five models agree inflation expectations anchor wage growth."], rows, 5)).toBe(false);
  });
});

// ─── Integration: buildAdaptiveSynthesisReport with a mocked narrative ──

function results(n: number): ModelResult[] {
  return M.slice(0, n).map((modelId) => ({ modelId, status: "ok", rawText: "{}", latencyMs: 1 }));
}

function mockNarrative(fields: Record<string, unknown>) {
  mockedCallGemini.mockImplementation(async (_m: any, _c: any, _k: any, opts: any) => {
    if (String(opts?.systemPromptOverride ?? "").includes("narrative portion")) {
      return {
        modelId: "gemini",
        status: "ok",
        rawText: JSON.stringify({
          executiveSummary: "Summary.",
          whereModelsAgreeNarrative: [],
          whyModelsDisagree: [],
          disagreementStakes: [],
          certaintyAssessment: "Assessment.",
          narrativeSections: [],
          ...fields,
        }),
        latencyMs: 1,
      };
    }
    return { modelId: "gemini", status: "error", rawText: null, errorMessage: "off", latencyMs: 1 };
  });
}

afterEach(() => jest.clearAllMocks());

describe("buildAdaptiveSynthesisReport: D9 backstop on every model-written field", () => {
  const ROWS = () => [A_ONE(), B_TWO(), D_FOUR()];

  it("R1 addendum reproduction: an agree sentence for the limited row is not shown; the deterministic lines are", async () => {
    mockNarrative({ whereModelsAgreeNarrative: ["Every model agrees central bank credibility drives bond yields."] });
    const report = await buildAdaptiveSynthesisReport("Q", "generic", ROWS(), results(5));
    expect(report.degraded).toBe(false);
    expect(report.whereModelsAgree).toEqual([A_ONE().claimText]);
  });

  it("more agree sentences than consensus/majority rows → deterministic lines, even when each sentence is honest", async () => {
    mockNarrative({
      whereModelsAgreeNarrative: [
        "Models agree inflation expectations anchor wage growth.",
        "Models also agree inflation expectations anchor wage growth over time.",
      ],
    });
    const report = await buildAdaptiveSynthesisReport("Q", "generic", ROWS(), results(5));
    expect(report.whereModelsAgree).toEqual([A_ONE().claimText]);
  });

  it("an honest agree sentence for the consensus row is kept", async () => {
    mockNarrative({ whereModelsAgreeNarrative: ["Models agree inflation expectations anchor wage growth."] });
    const report = await buildAdaptiveSynthesisReport("Q", "generic", ROWS(), results(5));
    expect(report.whereModelsAgree).toEqual(["Models agree inflation expectations anchor wage growth."]);
  });

  it("executive summary claiming the limited row as agreement → deterministic summary", async () => {
    mockNarrative({ executiveSummary: "The models agree that central bank credibility drives bond yields. Inflation expectations matter too." });
    const report = await buildAdaptiveSynthesisReport("Q", "generic", ROWS(), results(5));
    expect(report.executiveSummary).not.toContain("credibility drives bond yields");
    expect(report.executiveSummary).toContain(A_ONE().claimText);
  });

  it("executive summary with only legitimate wording is kept", async () => {
    const text = "The models agree that inflation expectations anchor wage growth. Two models agree supply shocks explain persistent core inflation, while three assessed models disagree.";
    mockNarrative({ executiveSummary: text });
    const report = await buildAdaptiveSynthesisReport("Q", "generic", ROWS(), results(5));
    expect(report.executiveSummary).toBe(text);
  });

  it("certainty assessment calling the split a majority → deterministic assessment", async () => {
    mockNarrative({ certaintyAssessment: "Most models agree supply shocks explain persistent core inflation, so certainty is high." });
    const report = await buildAdaptiveSynthesisReport("Q", "generic", ROWS(), results(5));
    expect(report.certaintyAssessment).toMatch(/^Run certainty \d+% \(gate: \w+\)\./);
  });

  it("a narrative section calling a single-source claim convergence is dropped; an honest one is kept", async () => {
    mockNarrative({
      narrativeSections: [
        { title: "Housing", body: "The models converge on housing costs lagging policy rates by two years." },
        { title: "Wages", body: "Inflation expectations anchor wage growth across the assessed models." },
      ],
    });
    const report = await buildAdaptiveSynthesisReport("Q", "generic", [A_ONE(), LONE()], results(5));
    expect(report.narrativeSections.map((s) => s.title)).toEqual(["Wages"]);
  });

  it("a 'why they disagree' explanation that calls the split topic agreement → default explanation", async () => {
    mockNarrative({ whyModelsDisagree: ["In the end the models agree on the mechanism."], disagreementStakes: ["important"] });
    const report = await buildAdaptiveSynthesisReport("Q", "generic", ROWS(), results(5));
    expect(report.disagreements[0].whyTheyDiffer).toBe("Models take different positions on this point — see each model's excerpt below.");
  });

  it("a subgroup explanation for the split topic is kept", async () => {
    const why = "Two models agree supply shocks dominate, while three assessed models weigh monetary policy instead.";
    mockNarrative({ whyModelsDisagree: [why], disagreementStakes: ["important"] });
    const report = await buildAdaptiveSynthesisReport("Q", "generic", ROWS(), results(5));
    expect(report.disagreements[0].whyTheyDiffer).toBe(why);
  });

  it("no consensus at all: 'broad consensus' in the summary → deterministic summary", async () => {
    mockNarrative({ executiveSummary: "There is broad consensus that prices will fall." });
    const report = await buildAdaptiveSynthesisReport("Q", "generic", [D_FOUR(), LONE()], results(5));
    expect(report.executiveSummary).not.toContain("broad consensus");
  });

  it("majority row: majority wording kept, unanimity wording replaced", async () => {
    mockNarrative({ executiveSummary: "Most models agree tariffs raise consumer prices measurably." });
    const kept = await buildAdaptiveSynthesisReport("Q", "generic", [MAJ()], results(5));
    expect(kept.executiveSummary).toBe("Most models agree tariffs raise consumer prices measurably.");
    mockNarrative({ executiveSummary: "All models agree tariffs raise consumer prices measurably." });
    const replaced = await buildAdaptiveSynthesisReport("Q", "generic", [MAJ()], results(5));
    expect(replaced.executiveSummary).not.toContain("All models agree");
  });

  it("the backstop never re-calls the model", async () => {
    mockNarrative({ executiveSummary: "The models agree that central bank credibility drives bond yields." });
    await buildAdaptiveSynthesisReport("Q", "generic", ROWS(), results(5));
    const narrativeCalls = mockedCallGemini.mock.calls.filter(([, , , o]) => String((o as any)?.systemPromptOverride ?? "").includes("narrative portion"));
    expect(narrativeCalls).toHaveLength(1);
  });
});
