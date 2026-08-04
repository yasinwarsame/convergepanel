/**
 * DeepResearchView tests (Milestone 2). Renders the real component
 * (react-dom/server — no jsdom needed) against fixtures built with
 * buildDeepResearchResult (mocking the reused Tier 2 auditPanelCoverage
 * call), matching the structural-check convention used by the other
 * adaptive renderer tests.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DeepResearchView from "@/components/adaptive/DeepResearchView";
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

function mockGaps(gaps: Array<{ dimension: string; whyItMatters: string; followUpQuestion: string }> = []) {
  mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "ok", rawText: JSON.stringify({ gaps }), latencyMs: 5 });
}

describe("DeepResearchView", () => {
  afterEach(() => jest.clearAllMocks());

  it("renders the executive summary first", async () => {
    mockGaps();
    const result = await buildDeepResearchResult(
      perModel([["chatgpt", fields({ executiveSummary: "Remote work modestly reduces measured productivity overall." })]])
    );
    const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result }));
    expect(html).toContain("Remote work modestly reduces measured productivity overall.");
  });

  it("renders findings with a coverage badge", async () => {
    mockGaps();
    const result = await buildDeepResearchResult(
      perModel([
        ["chatgpt", fields({ findings: [finding({ id: "a", title: "Productivity decline", summary: "Several studies find a modest productivity decline." })] })],
        ["claude", fields({ findings: [finding({ id: "b", title: "Productivity decline", summary: "Several studies find a modest productivity decline." })] })],
      ])
    );
    const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result }));
    expect(html).toContain("Productivity decline");
    expect(html).toContain("2 of 2 models covered this");
  });

  it("renders disagreements in a separate section from findings", async () => {
    mockGaps();
    const result = await buildDeepResearchResult(
      perModel([
        ["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "An established finding." })] })],
        ["claude", fields({ disagreements: ["Some researchers dispute whether the effect is causal at all."] })],
      ])
    );
    const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result }));
    expect(html).toContain("Areas of disagreement");
    expect(html).toContain("Some researchers dispute whether the effect is causal at all.");
  });

  it("shows source coverage", async () => {
    mockGaps();
    const result = await buildDeepResearchResult(
      perModel([["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "A sourced finding.", sources: ["Journal X"] })] })]])
    );
    const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result }));
    expect(html).toContain("Source coverage");
    expect(html).toContain("1 of 1 findings are source-cited");
  });

  it("shows evidence gaps and open questions", async () => {
    mockGaps();
    const result = await buildDeepResearchResult(
      perModel([["chatgpt", fields({ evidenceGaps: ["Long-term effects are under-studied"], openQuestions: ["Does this hold across industries?"] })]])
    );
    const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result }));
    expect(html).toContain("Evidence gaps");
    expect(html).toContain("Long-term effects are under-studied");
    expect(html).toContain("Open questions");
    expect(html).toContain("Does this hold across industries?");
  });

  it("shows panel blind spots in an expandable section", async () => {
    mockGaps([{ dimension: "International comparisons", whyItMatters: "Only US data was covered.", followUpQuestion: "How does this compare internationally?" }]);
    const result = await buildDeepResearchResult(
      perModel([["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "A US-only finding." })] })]])
    );
    const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result }));
    expect(html).toContain("<details");
    expect(html).toContain("Panel blind spots");
    expect(html).toContain("International comparisons");
  });

  it("shows research boundaries and recommended next steps", async () => {
    mockGaps();
    const result = await buildDeepResearchResult(
      perModel([["chatgpt", fields({ researchBoundaries: ["Does not cover non-English-language studies"], recommendedNextSteps: ["Run a meta-analysis across sectors"] })]])
    );
    const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result }));
    expect(html).toContain("Research boundaries");
    expect(html).toContain("Does not cover non-English-language studies");
    expect(html).toContain("Recommended next steps");
    expect(html).toContain("Run a meta-analysis across sectors");
  });

  it("shows collapsible model-level detail", async () => {
    mockGaps();
    const result = await buildDeepResearchResult(
      perModel([
        ["chatgpt", fields({ findings: [finding({ id: "a", title: "X", summary: "A finding." })] })],
        ["claude", fields({ findings: [finding({ id: "b", title: "X", summary: "A finding." })] })],
      ])
    );
    const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result }));
    expect(html).toMatch(/Panel detail \(2 models\)/);
  });

  it("handles a fully empty result without crashing", async () => {
    mockGaps();
    const result = await buildDeepResearchResult([]);
    const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result }));
    expect(html).toMatch(/no model responses were available/i);
  });

  it("distinguishes zero models attempted from models attempted but no usable research synthesis produced", async () => {
    mockGaps();
    const noModels = await buildDeepResearchResult([]);
    const htmlNoModels = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: noModels }));
    expect(htmlNoModels).toMatch(/no model responses were available/i);

    const noUsableOutput = await buildDeepResearchResult(perModel([["chatgpt", fields()], ["claude", fields()]]));
    const htmlNoUsableOutput = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: noUsableOutput }));
    expect(htmlNoUsableOutput).not.toMatch(/no model responses were available/i);
    expect(htmlNoUsableOutput).toMatch(/no research synthesis could be produced/i);
  });

  it("never renders a generic research shell, claim matrix as the main view, or a certainty/confidence score", async () => {
    mockGaps();
    const result = await buildDeepResearchResult(
      perModel([["chatgpt", fields({ executiveSummary: "X.", findings: [finding({ id: "a", title: "X", summary: "A finding." })] })]])
    );
    const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result }));
    expect(html).not.toMatch(/generic sections/i);
    expect(html).not.toMatch(/claim matrix/i);
    expect(html).not.toMatch(/panel verdict/i);
    expect(html).not.toMatch(/\d+%\s*confiden/i);
  });
});
