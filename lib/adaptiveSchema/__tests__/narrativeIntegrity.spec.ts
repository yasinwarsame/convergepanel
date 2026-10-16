/**
 * D9 narrative integrity (R1 N3, R2-1)
 *
 * Unit: assertion analysis (predicate class, subject scope, counts, scoped
 * negation), the structured rules, and attribution. R2-1 regressions: counted
 * claims checked against the row's real counts, non-governing negators,
 * paraphrased agreement, contested → settled. Integration: every model-written
 * field falls back to deterministic text on a violation; legitimate consensus,
 * majority, subgroup and negated wording is kept.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import {
  agreeLinesHonest,
  analyzeSentence,
  assertionOverstates,
  attributeSentence,
  overstatingSentences,
} from "@/lib/adaptiveSchema/narrativeIntegrity";
import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";

const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"] as ModelId[];

function cell(m: ModelId, stance: AlignedClaimCell["stance"]): AlignedClaimCell {
  return { modelId: m, stance, rawStance: "asserts", confidence: "settled", excerpt: "e", origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } };
}

function row(claimText: string, status: AlignedClaim["status"], stances: AlignedClaimCell["stance"][], extra: Partial<AlignedClaim> = {}): AlignedClaim {
  return {
    id: claimText,
    claimText,
    cells: M.map((m, i) => (i < stances.length ? cell(m, stances[i]) : null)),
    agreementScore: 0.5,
    certaintyScore: 0.5,
    status,
    ...extra,
  };
}

// 5 dispatched throughout. a-one consensus 3/5, b-two limited 2/5, d-four split, lone single_source.
const A_ONE = () => row("Inflation expectations anchor wage growth", "consensus", ["agrees", "agrees", "agrees"]);
const B_TWO = () => row("Central bank credibility drives bond yields", "limited_coverage", ["agrees", "agrees"]);
const D_FOUR = () => row("Supply shocks explain persistent core inflation", "split", ["agrees", "disputes", "disputes", "agrees", "disputes"]);
const LONE = () => row("Housing costs lag policy rates by two years", "single_source", ["agrees"]);
const MAJ = () => row("Tariffs raise consumer prices measurably", "majority", ["agrees", "agrees", "agrees", "disputes", "partial"]);
const FULL = () => row("Money supply growth preceded the spike", "consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"]);
/** All five agree but every one marks it contested (D1 marked only). */
const MARKED = () =>
  row("Minimum wage increases reduce employment", "consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"], {
    contested: { marked: true, assessed: false, markedCount: 5, listedCount: 5 },
  });
/** Consensus status, but the panel's positions are divided (D1 assessed only). */
const ASSESSED = () =>
  row("Remote work raises productivity", "consensus", ["agrees", "agrees", "agrees", "agrees", "partial"], {
    contested: { marked: false, assessed: true, markedCount: 0, listedCount: 5 },
  });

describe("analyzeSentence: predicate, scope and scoped negation", () => {
  it.each([
    ["The models agree that X.", "agreement", "panel"],
    ["Models broadly converge on X.", "agreement", "panel"],
    ["There is broad consensus that X.", "agreement", "panel"],
    ["The panel speaks with one voice on X.", "agreement", "panel"],
    ["The prevailing view is that X.", "agreement", "panel"],
    ["There is no disagreement that X.", "agreement", "panel"],
    ["The models endorse X.", "agreement", "panel"],
    ["The panel is united on X.", "agreement", "panel"],
    ["Every model agrees on X.", "agreement", "unanimous"],
    ["The panel was unanimous about X.", "agreement", "unanimous"],
    ["Most models agree that X.", "agreement", "majority"],
    ["A majority of models hold that X.", "agreement", "majority"],
    ["Some models agree with X.", "agreement", "subgroup"],
    ["It is settled that X.", "settled", "panel"],
    ["X is uncontested among the models.", "settled", "panel"],
    ["X is well established.", "settled", "panel"],
  ])("%s → %s / %s", (sentence, predicate, scope) => {
    const a = analyzeSentence(sentence);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ predicate, scope: { kind: scope } });
  });

  it.each([
    ["Five of five models agree that X.", 5, 5],
    ["5 of 5 models agree X.", 5, 5],
    ["Four of the five models agree X.", 4, 5],
    ["3/5 models agree X.", 3, 5],
    ["All five models agree X.", 5, 5],
    ["Two models agree that X.", 2, null],
    ["Three out of five models converge on X.", 3, 5],
  ])("counted: %s → %i of %s", (sentence, n, of) => {
    expect(analyzeSentence(sentence)[0].scope).toEqual({ kind: "counted", n, of });
  });

  it.each([
    "There is no consensus on X.",
    "The models do not agree on X.",
    "The models don't agree on X.",
    "The panel lacks consensus here.",
    "There is a lack of agreement on X.",
    "The models failed to reach a consensus on X.",
    "The models are not in agreement on X.",
    "The question is not settled.",
    "The models disagree about X.",
    "ChatGPT and Claude argue that X matters.",
  ])("no assertion: %s", (sentence) => {
    expect(analyzeSentence(sentence)).toEqual([]);
  });

  it.each([
    "Not surprisingly, the models agree that X.",
    "Without exception the models agree that X.",
    "Not only do the models agree that X, they cite the same data.",
    "Without hesitation, there is consensus that X.",
  ])("a negator that does not govern the predicate is not a negation (R2-1): %s", (sentence) => {
    expect(analyzeSentence(sentence).length).toBeGreaterThan(0);
  });
});

describe("assertionOverstates: structured rules", () => {
  const panel = { predicate: "agreement" as const, scope: { kind: "panel" as const } };
  const unanimous = { predicate: "agreement" as const, scope: { kind: "unanimous" as const } };
  const majority = { predicate: "agreement" as const, scope: { kind: "majority" as const } };
  const counted = (n: number, of: number | null) => ({ predicate: "agreement" as const, scope: { kind: "counted" as const, n, of } });
  const settled = { predicate: "settled" as const, scope: { kind: "panel" as const } };

  it("ineligible rows admit no panel, unanimous or majority claim", () => {
    for (const r of [B_TWO(), D_FOUR(), LONE()]) for (const a of [panel, unanimous, majority]) expect(assertionOverstates(a, r, 5)).toBe(true);
  });

  it("majority rows: majority claims only", () => {
    expect(assertionOverstates(majority, MAJ(), 5)).toBe(false);
    expect(assertionOverstates(panel, MAJ(), 5)).toBe(true);
    expect(assertionOverstates(unanimous, MAJ(), 5)).toBe(true);
  });

  it("consensus rows: panel claims; unanimity only when every dispatched model agreed", () => {
    expect(assertionOverstates(panel, A_ONE(), 5)).toBe(false);
    expect(assertionOverstates(unanimous, A_ONE(), 5)).toBe(true);
    expect(assertionOverstates(unanimous, FULL(), 5)).toBe(false);
  });

  it("counts are checked: the numerator against the agreeing models, the denominator against the dispatched panel or the positions", () => {
    expect(assertionOverstates(counted(5, 5), B_TWO(), 5)).toBe(true); // only 2 agree
    expect(assertionOverstates(counted(2, 5), B_TWO(), 5)).toBe(false); // accurate
    expect(assertionOverstates(counted(2, null), B_TWO(), 5)).toBe(false); // accurate subgroup
    expect(assertionOverstates(counted(2, 2), B_TWO(), 5)).toBe(false); // 2 of the 2 that took a position
    expect(assertionOverstates(counted(2, 3), B_TWO(), 5)).toBe(true); // 3 is neither the panel nor the positions
    expect(assertionOverstates(counted(3, 5), D_FOUR(), 5)).toBe(true); // only 2 agree on the split
    expect(assertionOverstates(counted(2, 5), D_FOUR(), 5)).toBe(false);
    expect(assertionOverstates(counted(5, 5), FULL(), 5)).toBe(false);
  });

  it("settledness is refused for contested rows — marked, assessed or split — and for ineligible rows", () => {
    expect(assertionOverstates(settled, MARKED(), 5)).toBe(true);
    expect(assertionOverstates(settled, ASSESSED(), 5)).toBe(true);
    expect(assertionOverstates(settled, D_FOUR(), 5)).toBe(true);
    expect(assertionOverstates(settled, B_TWO(), 5)).toBe(true);
    expect(assertionOverstates(settled, FULL(), 5)).toBe(false); // uncontested consensus
  });

  it("an unknown status is never treated as eligible", () => {
    expect(assertionOverstates(panel, { ...A_ONE(), status: "some_future_status" as any }, 5)).toBe(true);
    expect(assertionOverstates(majority, { ...A_ONE(), status: "some_future_status" as any }, 5)).toBe(true);
  });
});

describe("R2-1 regressions: each reproduced bypass is now caught", () => {
  const rows = [A_ONE(), B_TWO()];
  it.each([
    "Five of five models agree that central bank credibility drives bond yields.",
    "5 of 5 models agree central bank credibility drives bond yields.",
    "Four of the five models agree central bank credibility drives bond yields.",
    "Not surprisingly, the models agree that central bank credibility drives bond yields.",
    "Without exception the models agree that central bank credibility drives bond yields.",
    "The panel speaks with one voice on central bank credibility driving bond yields.",
    "The prevailing view is that central bank credibility drives bond yields.",
    "There is no disagreement that central bank credibility drives bond yields.",
    "The models are united that central bank credibility drives bond yields.",
    "The models endorse the view that central bank credibility drives bond yields.",
  ])("limited row: %s", (sentence) => {
    expect(overstatingSentences(sentence, rows, 5)).toEqual([sentence]);
  });

  it.each([
    "Three of five models agree supply shocks explain persistent core inflation.",
    "The panel reached agreement that supply shocks explain persistent core inflation.",
  ])("split row: %s", (sentence) => {
    expect(overstatingSentences(sentence, [A_ONE(), D_FOUR()], 5)).toEqual([sentence]);
  });

  it.each([
    "It is settled that minimum wage increases reduce employment.",
    "That minimum wage increases reduce employment is uncontested among the models.",
    "Minimum wage increases reduce employment is well established.",
  ])("contested (marked) row presented as settled: %s", (sentence) => {
    expect(overstatingSentences(sentence, [MARKED()], 5)).toEqual([sentence]);
  });

  it("contested (assessed only) row presented as settled", () => {
    const s = "It is settled that remote work raises productivity.";
    expect(overstatingSentences(s, [ASSESSED()], 5)).toEqual([s]);
  });

  it("no consensus anywhere: an unattributed count above half the panel, or 'all N', is caught; a small count is not", () => {
    const rows2 = [D_FOUR(), LONE()];
    expect(overstatingSentences("Four of five models agree on the main question.", rows2, 5)).toHaveLength(1);
    expect(overstatingSentences("All five models agree on the main question.", rows2, 5)).toHaveLength(1);
    expect(overstatingSentences("Two models agree on the main question.", rows2, 5)).toHaveLength(0);
  });
});

describe("legitimate wording is kept", () => {
  it.each([
    ["consensus", "The models agree that inflation expectations anchor wage growth.", [A_ONE()]],
    ["unanimity when all five agreed", "All five models agree money supply growth preceded the spike.", [FULL()]],
    ["settled for an uncontested full consensus", "Money supply growth preceding the spike is well established.", [FULL()]],
    ["majority", "Most models agree tariffs raise consumer prices measurably.", [MAJ()]],
    ["accurate count", "Two of five models agree central bank credibility drives bond yields.", [A_ONE(), B_TWO()]],
    ["split subgroup", "Two models agree supply shocks explain persistent core inflation, while three disagree.", [A_ONE(), D_FOUR()]],
    ["contested camps", "The models describe competing camps on minimum wage increases reducing employment.", [MARKED()]],
    ["negated settledness", "Whether minimum wage increases reduce employment is not settled.", [MARKED()]],
    ["negated consensus", "There is no consensus that supply shocks explain persistent core inflation.", [A_ONE(), D_FOUR()]],
  ])("%s: %s", (_label, sentence, rows) => {
    expect(overstatingSentences(sentence as string, rows as AlignedClaim[], 5)).toEqual([]);
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
