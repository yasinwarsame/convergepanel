/**
 * deep_research alignment/aggregation tests (Milestone 2).
 *
 * Covers: paraphrased findings merge, distinct research dimensions remain
 * separate, disagreements are preserved (never coverage-filtered), minority
 * findings remain visible in lowConfidenceFindings, gaps/open-questions
 * dedupe, source support aggregates correctly, model coverage aggregates
 * correctly, panel omissions surface via the reused Tier 2 audit, uniform
 * agreement never implies independent verification (no certainty score
 * anywhere), weak evidence is not upgraded by repetition, and malformed/
 * empty inputs fail safely.
 *
 * `auditPanelCoverage` (a real Gemini call) is mocked at the connector
 * level, same convention as classifierV2.spec.ts/coverageAudit.spec.ts.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { buildDeepResearchResult, DeepResearchFields } from "@/lib/adaptiveSchema/deepResearchAlignment";
import { ResearchFinding } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function finding(overrides: Partial<ResearchFinding> & { id: string; title: string; summary: string }): ResearchFinding {
  return { ...overrides };
}

function fields(overrides: Partial<DeepResearchFields> = {}): DeepResearchFields {
  return {
    executiveSummary: "",
    findings: [],
    disagreements: [],
    evidenceGaps: [],
    openQuestions: [],
    researchBoundaries: [],
    recommendedNextSteps: [],
    sources: [],
    ...overrides,
  };
}

function perModel(entries: [string, DeepResearchFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

function mockNoGaps() {
  mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "ok", rawText: JSON.stringify({ gaps: [] }), latencyMs: 5 });
}

describe("buildDeepResearchResult — finding clustering", () => {
  beforeEach(() => mockNoGaps());
  afterEach(() => jest.clearAllMocks());

  it("merges paraphrased findings into one", async () => {
    const result = await buildDeepResearchResult(
      perModel([
        ["chatgpt", fields({ findings: [finding({ id: "a", title: "Remote work", summary: "Remote work modestly reduces measured productivity in several studies." })] })],
        ["claude", fields({ findings: [finding({ id: "b", title: "Remote work", summary: "Several studies find remote work modestly reduces measured productivity." })] })],
      ])
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].coverageCount).toBe(2);
  });

  it("keeps distinct research dimensions separate", async () => {
    const result = await buildDeepResearchResult(
      perModel([
        [
          "chatgpt",
          fields({
            findings: [
              finding({ id: "a", title: "Productivity", summary: "Remote work modestly reduces measured productivity in several studies." }),
              finding({ id: "b", title: "Wellbeing", summary: "Remote work is associated with improved self-reported wellbeing in surveys." }),
            ],
          }),
        ],
      ])
    );
    const all = [...result.findings, ...result.lowConfidenceFindings];
    expect(all).toHaveLength(2);
  });
});

describe("buildDeepResearchResult — disagreements preserved", () => {
  beforeEach(() => mockNoGaps());
  afterEach(() => jest.clearAllMocks());

  it("preserves a minority disagreement raised by only one model", async () => {
    const result = await buildDeepResearchResult(
      perModel([
        ["chatgpt", fields({ disagreements: ["Some researchers argue the productivity effect is entirely selection bias."] })],
        ["claude", fields({})],
        ["grok", fields({})],
        ["perplexity", fields({})],
      ])
    );
    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0].supportingModels).toEqual(["chatgpt"]);
  });

  it("keeps genuinely distinct disagreements separate", async () => {
    const result = await buildDeepResearchResult(
      perModel([
        ["chatgpt", fields({ disagreements: ["Some argue the effect is purely selection bias."] })],
        ["claude", fields({ disagreements: ["Others argue the effect is driven entirely by industry composition."] })],
      ])
    );
    expect(result.disagreements).toHaveLength(2);
  });
});

describe("buildDeepResearchResult — minority findings visible via low-confidence bucket", () => {
  beforeEach(() => mockNoGaps());
  afterEach(() => jest.clearAllMocks());

  it("moves findings covered by only 1-2 models into lowConfidenceFindings when the panel has more than 2 models", async () => {
    const result = await buildDeepResearchResult(
      perModel([
        [
          "chatgpt",
          fields({
            findings: [
              finding({ id: "popular", title: "Popular", summary: "A widely replicated finding across many studies in this area." }),
              finding({ id: "rare", title: "Rare", summary: "A rarely-cited niche finding only one study really supports." }),
            ],
          }),
        ],
        ["claude", fields({ findings: [finding({ id: "popular2", title: "Popular", summary: "A widely replicated finding across many studies in this area." })] })],
        ["grok", fields({ findings: [finding({ id: "popular3", title: "Popular", summary: "A widely replicated finding across many studies in this area." })] })],
        ["perplexity", fields({ findings: [finding({ id: "popular4", title: "Popular", summary: "A widely replicated finding across many studies in this area." })] })],
      ])
    );
    expect(result.findings.map((f) => f.title)).toEqual(["Popular"]);
    expect(result.lowConfidenceFindings.map((f) => f.title)).toEqual(["Rare"]);
  });
});

describe("buildDeepResearchResult — gaps/open-questions dedup", () => {
  beforeEach(() => mockNoGaps());
  afterEach(() => jest.clearAllMocks());

  it("deduplicates near-duplicate evidence gaps and open questions", async () => {
    const result = await buildDeepResearchResult(
      perModel([
        ["chatgpt", fields({ evidenceGaps: ["Long-term effects are under-studied"], openQuestions: ["Does this hold across industries?"] })],
        ["claude", fields({ evidenceGaps: ["Long-term effects remain under-studied"], openQuestions: ["Does this hold across different industries?"] })],
      ])
    );
    expect(result.evidenceGaps).toHaveLength(1);
    expect(result.openQuestions).toHaveLength(1);
  });
});

describe("buildDeepResearchResult — source support and model coverage", () => {
  beforeEach(() => mockNoGaps());
  afterEach(() => jest.clearAllMocks());

  it("marks a finding source-backed when it carries its own sources", async () => {
    const result = await buildDeepResearchResult(
      perModel([["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "A specific well-documented finding.", sources: ["Journal of Labor Economics"] })] })]])
    );
    expect(result.findings[0].sourceBacked).toBe(true);
    expect(result.sourceCoverage).toEqual({ findingsWithSources: 1, totalFindings: 1, coverageRatio: 1 });
  });

  it("falls back to response-level sources when a finding itself has none", async () => {
    const result = await buildDeepResearchResult(
      perModel([["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "A specific well-documented finding." })], sources: ["General survey report"] })]])
    );
    expect(result.findings[0].sourceBacked).toBe(true);
  });

  it("computes coverageRatio from the full attempted model count", async () => {
    const result = await buildDeepResearchResult(
      perModel([
        ["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "A specific well-documented finding." })] })],
        ["claude", fields({ findings: [finding({ id: "b", title: "X", summary: "A specific well-documented finding." })] })],
        ["grok", fields({})],
        ["perplexity", fields({})],
      ])
    );
    const all = [...result.findings, ...result.lowConfidenceFindings];
    expect(all[0].totalModels).toBe(4);
    expect(all[0].coverageRatio).toBe(0.5);
  });
});

describe("buildDeepResearchResult — panel blind spots (reused Tier 2 audit)", () => {
  afterEach(() => jest.clearAllMocks());

  it("surfaces a panel omission detected by the reused coverageAudit.ts call", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: JSON.stringify({
        gaps: [{ dimension: "International comparisons", whyItMatters: "The panel only covered US data.", followUpQuestion: "How does this compare internationally?" }],
      }),
      latencyMs: 5,
    });
    const result = await buildDeepResearchResult(
      perModel([["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "A US-only finding." })] })]])
    );
    expect(result.panelBlindSpots).toHaveLength(1);
    expect(result.panelBlindSpots[0].dimension).toBe("International comparisons");
  });

  it("degrades to an empty panelBlindSpots array when the audit call fails, never throws", async () => {
    mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, errorMessage: "boom", latencyMs: 5 });
    const result = await buildDeepResearchResult(
      perModel([["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "A finding." })] })]])
    );
    expect(result.panelBlindSpots).toEqual([]);
  });
});

describe("buildDeepResearchResult — repetition never becomes proof", () => {
  beforeEach(() => mockNoGaps());
  afterEach(() => jest.clearAllMocks());

  it("never upgrades evidenceStrength from 'unknown' purely because many models agree", async () => {
    const result = await buildDeepResearchResult(
      perModel([
        ["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "A widely repeated but never independently verified finding." })] })],
        ["claude", fields({ findings: [finding({ id: "b", title: "X", summary: "A widely repeated but never independently verified finding." })] })],
        ["grok", fields({ findings: [finding({ id: "c", title: "X", summary: "A widely repeated but never independently verified finding." })] })],
        ["perplexity", fields({ findings: [finding({ id: "d", title: "X", summary: "A widely repeated but never independently verified finding." })] })],
        ["gemini", fields({ findings: [finding({ id: "e", title: "X", summary: "A widely repeated but never independently verified finding." })] })],
      ])
    );
    expect(result.findings[0].coverageCount).toBe(5);
    expect(result.findings[0].evidenceStrength).toBe("unknown");
  });

  it("marks a finding 'contested' only via a genuine independent signal (matching disagreement), not from low coverage", async () => {
    const result = await buildDeepResearchResult(
      perModel([
        ["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "Minimum wage increases cause modest job losses in the fast food sector." })] })],
        ["claude", fields({ disagreements: ["Minimum wage increases causing modest job losses in the fast food sector is disputed by several economists."] })],
      ])
    );
    expect(result.findings[0].evidenceStrength).toBe("contested");
  });

  it("never computes an overall certainty/confidence score anywhere in the result", async () => {
    const result = (await buildDeepResearchResult(
      perModel([["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "A finding." })] })]])
    )) as any;
    expect(result.certaintyScore).toBeUndefined();
    expect(result.confidence).toBeUndefined();
    expect(result.gate).toBeUndefined();
  });
});

describe("buildDeepResearchResult — empty and malformed input", () => {
  afterEach(() => jest.clearAllMocks());

  it("never throws and returns an empty result when no model produced usable data", async () => {
    const result = await buildDeepResearchResult(perModel([["chatgpt", fields()], ["claude", fields()]]), "");
    expect(result.findings).toEqual([]);
    expect(result.disagreements).toEqual([]);
    expect(result.panelBlindSpots).toEqual([]);
    expect(result.sourceCoverage).toEqual({ findingsWithSources: 0, totalFindings: 0, coverageRatio: 0 });
    expect(result.totalModels).toBe(2);
    expect(mockedCallGemini).not.toHaveBeenCalled();
  });

  it("handles a totally empty perModel array", async () => {
    const result = await buildDeepResearchResult([], "");
    expect(result.findings).toEqual([]);
    expect(result.totalModels).toBe(0);
  });
});
