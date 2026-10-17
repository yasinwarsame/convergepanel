/**
 * Consensus Integrity — Option B (R3-1): the panel's agreement is stated
 * only by deterministic text, through the real report builder.
 *
 * Every R3-1 reproduction is fed to buildAdaptiveSynthesisReport as the
 * model's narrative; whatever the narrative says, the authoritative fields
 * (Where Models Agree, the panel agreement statement in the executive summary
 * and certainty assessment, Unified Answer, Panel Verdict, Verdict Card) come
 * out exactly as the structured rows dictate, and the offending sentence
 * reaches no field of the report.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";

const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const CLAIM = { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } as const;

function row(claimText: string, status: AlignedClaim["status"], stances: (AlignedClaimCell["stance"] | null)[], extra: Partial<AlignedClaim> = {}): AlignedClaim {
  return {
    id: claimText,
    claimText,
    cells: M.map((m, i) => {
      const s = stances[i];
      return s ? { modelId: m as ModelId, stance: s, rawStance: "asserts", confidence: "settled", excerpt: `${m} excerpt`, origin: CLAIM } : null;
    }),
    agreementScore: status === "split" ? 0.3 : 0.95,
    certaintyScore: status === "split" ? 0.3 : 0.9,
    status,
    ...extra,
  };
}

const A = () => row("Inflation expectations anchor wage growth", "consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"]);
const SPLIT = () => row("Supply shocks explain persistent core inflation", "split", ["agrees", "disputes", "disputes", "agrees", "disputes"]);
const LONE = () => row("Housing costs lag policy rates by two years", "single_source", ["agrees", null, null, null, null]);
const MAJ = () => row("Rate cuts lag by a year", "majority", ["agrees", "agrees", "agrees", "disputes", null]);
const LIMITED = () => row("Only two models said this", "limited_coverage", ["agrees", "agrees", null, null, null]);
const CONTESTED = () =>
  row("Polarization has increased", "consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"], {
    contested: { marked: true, assessed: false, markedCount: 5, listedCount: 5 },
  });

const results = (): ModelResult[] => M.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "{}", latencyMs: 1 }));

function mockNarrative(n: Record<string, unknown>) {
  mockedCallGemini.mockImplementation(async (_q: any, _c: any, _k: any, opts: any) => {
    if (String(opts?.systemPromptOverride ?? "").includes("narrative portion")) {
      return {
        modelId: "gemini",
        status: "ok",
        latencyMs: 1,
        rawText: JSON.stringify({
          executiveSummary: "Wage growth tracks expectations.",
          whyModelsDisagree: [],
          disagreementStakes: [],
          certaintyAssessment: "The data end in 2024.",
          narrativeSections: [],
          ...n,
        }),
      };
    }
    return { modelId: "gemini", status: "error", rawText: null, errorMessage: "not under test", latencyMs: 1 } as any;
  });
}

function mockNarrativeDown() {
  mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, errorMessage: "down", latencyMs: 1 });
}

afterEach(() => jest.clearAllMocks());

const BOTH_STATEMENT = "Of 2 scored claims across 5 dispatched models: consensus on 1; a split on 1.";

/** Each R3-1 class, as the model's narrative, in the field R3 reproduced it in — and in every other model-written field. */
const R3_1: Array<[string, AlignedClaim[], string, string]> = [
  ["number-word counts", [A(), SPLIT()], "Every single model agrees that supply shocks explain persistent core inflation.", BOTH_STATEMENT],
  ["subgroup-word exemption", [A(), SPLIT()], "The models not only agree that supply shocks explain persistent core inflation, they cite the same data.", BOTH_STATEMENT],
  ["double negation", [A(), SPLIT()], "The models could not agree more that supply shocks explain persistent core inflation.", BOTH_STATEMENT],
  ["single_source as plural", [A(), LONE()], "Several models agree that housing costs lag policy rates by two years.", "Of 2 scored claims across 5 dispatched models: consensus on 1; a single source only on 1."],
  ["one row per sentence", [A(), SPLIT()], "Inflation expectations anchor wage growth and the panel agrees supply shocks explain persistent core inflation.", BOTH_STATEMENT],
  ["unattributed paraphrase", [A(), SPLIT()], "The panel agrees that disruptions to supply chains are the main driver of sticky core prices.", BOTH_STATEMENT],
];

describe("Option B — no R3-1 narrative can alter, replace or contradict the authoritative fields", () => {
  it.each(R3_1)("%s", async (_cls, rows, sentence, statement) => {
    mockNarrative({
      executiveSummary: `Wage growth tracks expectations. ${sentence}`,
      certaintyAssessment: sentence,
      narrativeSections: [{ title: "Drivers", body: sentence }],
      whyModelsDisagree: rows.some((r) => r.status === "split") ? [sentence] : [],
      disagreementStakes: rows.some((r) => r.status === "split") ? ["important"] : [],
      whereModelsAgreeNarrative: [sentence],
    });
    const report = await buildAdaptiveSynthesisReport("q", "generic", rows, results());

    expect(report.degraded).toBe(false);
    // The offending sentence reaches no field.
    expect(JSON.stringify(report)).not.toContain(sentence.slice(0, -1));
    // The authoritative fields are exactly the deterministic ones.
    expect(report.whereModelsAgree).toEqual(["Inflation expectations anchor wage growth"]);
    expect(report.executiveSummary).toBe(`Wage growth tracks expectations. ${statement}`);
    expect(report.certaintyAssessment).toBe(`Run certainty ${Math.round(report.runCertainty * 100)}% (gate: ${report.gate}). ${statement}`);
    expect(report.narrativeSections).toEqual([]);
    for (const d of report.disagreements) expect(d.whyTheyDiffer).toBe("Models take different positions on this point — see each model's excerpt below.");
    expect(report.verdictCard.topConsensus).toBe("Inflation expectations anchor wage growth");
    expect(report.panelVerdict).toMatch(/^5\/5 models converge on Inflation expectations anchor wage growth;/);
  });

  it("mixed agree line: a model's 'Where models agree' lines are never used", async () => {
    mockNarrative({ whereModelsAgreeNarrative: ["Inflation expectations anchor wage growth and supply shocks explain persistent core inflation."] });
    const report = await buildAdaptiveSynthesisReport("q", "generic", [A(), SPLIT()], results());
    expect(report.whereModelsAgree).toEqual(["Inflation expectations anchor wage growth"]);
    expect(JSON.stringify(report)).not.toContain("anchor wage growth and supply shocks");
  });

  it("a narrative that forges the authoritative statement itself is removed", async () => {
    mockNarrative({ executiveSummary: "Wage growth tracks expectations. Of 2 scored claims across 5 dispatched models: consensus on 2." });
    const report = await buildAdaptiveSynthesisReport("q", "generic", [A(), SPLIT()], results());
    expect(report.executiveSummary).toBe(`Wage growth tracks expectations. ${BOTH_STATEMENT}`);
  });

  it("a narrative that contradicts consensus with division is removed from the panel-free fields", async () => {
    mockNarrative({
      executiveSummary: "Wage growth tracks expectations. The models disagree about wage growth.",
      certaintyAssessment: "Opinion is split on wage growth.",
      narrativeSections: [{ title: "Where the panel splits", body: "Wage data end in 2024." }],
    });
    const report = await buildAdaptiveSynthesisReport("q", "generic", [A()], results());
    expect(report.executiveSummary).toBe("Wage growth tracks expectations. Of 1 scored claim across 5 dispatched models: consensus on 1.");
    expect(report.certaintyAssessment).toBe(`Run certainty ${Math.round(report.runCertainty * 100)}% (gate: ${report.gate}). Of 1 scored claim across 5 dispatched models: consensus on 1.`);
    expect(report.narrativeSections).toEqual([]);
  });

  it("an executive summary with nothing left falls back to the template", async () => {
    mockNarrative({ executiveSummary: "The models agree. The panel is united." });
    const report = await buildAdaptiveSynthesisReport("q", "generic", [A()], results());
    expect(report.executiveSummary).toBe(`${report.unifiedAnswer} Of 1 scored claim across 5 dispatched models: consensus on 1.`);
  });
});

describe("Option B — each status gets its deterministic statement (template and narrative paths)", () => {
  const cases: Array<[string, AlignedClaim[], string, string[]]> = [
    ["consensus", [A()], "Of 1 scored claim across 5 dispatched models: consensus on 1.", ["Inflation expectations anchor wage growth"]],
    ["majority", [MAJ()], "Of 1 scored claim across 5 dispatched models: majority agreement on 1.", ["Rate cuts lag by a year"]],
    ["split", [SPLIT()], "No consensus identified. Of 1 scored claim across 5 dispatched models: a split on 1.", []],
    [
      "limited_coverage",
      [LIMITED()],
      "No consensus identified. Of 1 scored claim across 5 dispatched models: limited coverage on 1 (half or fewer of the dispatched models took a position — too few to count as agreement).",
      [],
    ],
    ["single_source", [LONE()], "No consensus identified. Of 1 scored claim across 5 dispatched models: a single source only on 1.", []],
    ["contested", [CONTESTED()], "Of 1 scored claim across 5 dispatched models: consensus on 1.", ["Polarization has increased — all 5 models that listed this claim mark it contested"]],
  ];

  it("the cases cover both gate branches", async () => {
    mockNarrativeDown();
    const gates = new Set<string>();
    for (const [, rows] of cases) gates.add((await buildAdaptiveSynthesisReport("q", "generic", rows, results())).gate);
    expect(gates.has("fail")).toBe(true);
    expect([...gates].some((g) => g !== "fail")).toBe(true);
  });

  it.each(cases)("%s — template path", async (_s, rows, statement, agree) => {
    mockNarrativeDown();
    const report = await buildAdaptiveSynthesisReport("q", "generic", rows, results());
    expect(report.degraded).toBe(true);
    expect(report.whereModelsAgree).toEqual(agree);
    expect(report.certaintyAssessment).toBe(`Run certainty ${Math.round(report.runCertainty * 100)}% (gate: ${report.gate}). ${statement}`);
    expect(report.executiveSummary).toBe(report.gate === "fail" ? report.unifiedAnswer : `${report.unifiedAnswer} ${statement}`);
  });

  it.each(cases)("%s — narrative path keeps explanatory prose and adds the statement", async (_s, rows, statement, agree) => {
    mockNarrative({ executiveSummary: "The evidence base is thin. ChatGPT stresses lag effects; Grok stresses supply shocks." });
    const report = await buildAdaptiveSynthesisReport("q", "generic", rows, results());
    expect(report.whereModelsAgree).toEqual(agree);
    expect(report.executiveSummary).toBe(
      report.gate === "fail" ? report.unifiedAnswer : `The evidence base is thin. ChatGPT stresses lag effects; Grok stresses supply shocks. ${statement}`
    );
    expect(report.certaintyAssessment).toBe(`Run certainty ${Math.round(report.runCertainty * 100)}% (gate: ${report.gate}). ${statement} The data end in 2024.`);
  });

  it("no consensus: the no-consensus text is never followed by agreement wording", async () => {
    mockNarrativeDown();
    const report = await buildAdaptiveSynthesisReport("q", "generic", [SPLIT(), LONE(), LIMITED()], results());
    expect(report.certaintyAssessment).toContain("No consensus identified. Of 3 scored claims across 5 dispatched models:");
    expect(report.certaintyAssessment).not.toMatch(/consensus on|majority agreement on/);
    expect(report.whereModelsAgree).toEqual([]);
    expect(report.verdictCard.topConsensus).toBe("No consensus identified.");
  });
});

describe("Option B — explanatory prose around the statement stays usable", () => {
  it("split: named-model subgroup explanation in why-they-differ is kept; a counted one is not", async () => {
    mockNarrative({
      whyModelsDisagree: ["ChatGPT and Grok weigh the survey data more heavily, while Claude relies on trial results. Most models think supply shocks matter."],
      disagreementStakes: ["important"],
    });
    const report = await buildAdaptiveSynthesisReport("q", "generic", [A(), SPLIT()], results());
    expect(report.disagreements[0].whyTheyDiffer).toBe("ChatGPT and Grok weigh the survey data more heavily, while Claude relies on trial results.");
  });

  it("split: a why-they-differ explanation may say the models disagree, but not that most agree", async () => {
    mockNarrative({ whyModelsDisagree: ["The models disagree on which inflation series to use."], disagreementStakes: ["low"] });
    const report = await buildAdaptiveSynthesisReport("q", "generic", [A(), SPLIT()], results());
    expect(report.disagreements[0].whyTheyDiffer).toBe("The models disagree on which inflation series to use.");
  });

  it("contested: the explanation is kept, a settledness sentence is removed, the canonical note stays", async () => {
    mockNarrative({
      executiveSummary: "Measured polarization depends on the survey used. Polarization has increased and this is settled.",
      narrativeSections: [{ title: "Measurement", body: "Survey wording changed in 2016. It is well established that it rose." }],
    });
    const report = await buildAdaptiveSynthesisReport("q", "contested_empirical", [CONTESTED()], results());
    expect(report.executiveSummary).toBe("Measured polarization depends on the survey used. Of 1 scored claim across 5 dispatched models: consensus on 1.");
    expect(report.narrativeSections).toEqual([{ title: "Measurement", body: "Survey wording changed in 2016." }]);
    expect(report.whereModelsAgree).toEqual(["Polarization has increased — all 5 models that listed this claim mark it contested"]);
  });

  it("a narrative without the retired whereModelsAgreeNarrative field is accepted", async () => {
    mockNarrative({});
    const report = await buildAdaptiveSynthesisReport("q", "generic", [A()], results());
    expect(report.degraded).toBe(false);
  });

  it("gate fail: the executive summary is still exactly the Unified Answer", async () => {
    mockNarrative({ executiveSummary: "Everything is clear." });
    const rows = [row("Contested claim", "split", ["disputes", "agrees", null, null, null])];
    const report = await buildAdaptiveSynthesisReport("q", "generic", rows, results());
    expect(report.gate).toBe("fail");
    expect(report.executiveSummary).toBe(report.unifiedAnswer);
  });
});
