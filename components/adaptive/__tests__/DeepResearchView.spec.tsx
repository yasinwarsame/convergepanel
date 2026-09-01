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

  describe("Phase 11A.4 — 'Verify this claim' action", () => {
    const CLAIM_ID = "v1:findings:0:" + "a".repeat(43);

    async function buildResultWithOneFinding(claimId: string | null | undefined) {
      mockGaps();
      const result = await buildDeepResearchResult(
        perModel([["chatgpt", fields({ findings: [finding({ id: "raw-id-0", title: "X", summary: "A finding." })] })]])
      );
      // buildDeepResearchResult never attaches claimId itself (that's this
      // phase's server-response-time attachment, tested separately in
      // attachDeepResearchClaimIds.spec.ts) — attach it here the same way
      // the real response-shaping code would, to test the RENDERER's own
      // eligibility/wiring logic in isolation.
      return { ...result, findings: [{ ...result.findings[0], claimId }] };
    }

    it("an eligible finding (runId present, claimId present) shows 'Verify this claim'", async () => {
      const result = await buildResultWithOneFinding(CLAIM_ID);
      const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result, runId: "run-1" }));
      expect(html).toContain("Verify this claim");
    });

    it("a finding with claimId: null does not show the action", async () => {
      const result = await buildResultWithOneFinding(null);
      const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result, runId: "run-1" }));
      expect(html).not.toContain("Verify this claim");
    });

    it("a finding with claimId absent (undefined) does not show the action — e.g. a non-deep_research or legacy path that never attached one", async () => {
      const result = await buildResultWithOneFinding(undefined);
      const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result, runId: "run-1" }));
      expect(html).not.toContain("Verify this claim");
    });

    it("no runId at all -> the action is withheld even for a finding with a valid claimId", async () => {
      const result = await buildResultWithOneFinding(CLAIM_ID);
      const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result, runId: null }));
      expect(html).not.toContain("Verify this claim");
    });

    it("the button's locator data carries the CANONICAL claimId attached to the finding — never the raw finding.id, never derived from array position", async () => {
      const result = await buildResultWithOneFinding(CLAIM_ID);
      const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result, runId: "run-1" }));
      expect(html).toContain(`data-claim-id="${CLAIM_ID}"`);
      // The raw finding id ("raw-id-0") must never appear as the locator —
      // proves this isn't silently falling back to finding.id anywhere.
      expect(html).not.toContain('data-claim-id="raw-id-0"');
      expect(html).toContain('data-run-id="run-1"');
    });
  });

  describe("Phase 11A.6 — exact-finding focus targeting", () => {
    const CLAIM_ID_A = "v1:findings:0:" + "a".repeat(43);
    const CLAIM_ID_B = "v1:findings:1:" + "b".repeat(43);

    async function buildResultWithTwoFindings(claimIdA: string | null | undefined, claimIdB: string | null | undefined) {
      mockGaps();
      const result = await buildDeepResearchResult(
        perModel([
          [
            "chatgpt",
            fields({
              findings: [
                finding({
                  id: "raw-id-0",
                  title: "Finding A",
                  summary: "Remote work modestly reduces measured productivity across most sampled industries.",
                }),
                finding({
                  id: "raw-id-1",
                  title: "Finding B",
                  summary: "Employee retention rates improved significantly after the policy change was implemented in 2024.",
                }),
              ],
            }),
          ],
        ])
      );
      return {
        ...result,
        findings: [
          { ...result.findings[0], claimId: claimIdA },
          { ...result.findings[1], claimId: claimIdB },
        ],
      };
    }

    it("a finding whose claimId exactly matches focusClaimId is visually emphasized", async () => {
      const result = await buildResultWithTwoFindings(CLAIM_ID_A, CLAIM_ID_B);
      const html = renderToStaticMarkup(
        createElement(DeepResearchView, { deepResearch: result, runId: "run-1", focusClaimId: CLAIM_ID_A })
      );
      expect(html).toContain("border-sky-300");
    });

    it("only the exactly-matching finding is emphasized — its sibling is not, even though both are eligible", async () => {
      const result = await buildResultWithTwoFindings(CLAIM_ID_A, CLAIM_ID_B);
      const html = renderToStaticMarkup(
        createElement(DeepResearchView, { deepResearch: result, runId: "run-1", focusClaimId: CLAIM_ID_B })
      );
      // Exactly one emphasized <li> should exist — count occurrences of the emphasis marker.
      const emphasizedCount = (html.match(/border-sky-300/g) ?? []).length;
      expect(emphasizedCount).toBe(1);
    });

    it("no focusClaimId at all -> no finding is emphasized", async () => {
      const result = await buildResultWithTwoFindings(CLAIM_ID_A, CLAIM_ID_B);
      const html = renderToStaticMarkup(createElement(DeepResearchView, { deepResearch: result, runId: "run-1" }));
      expect(html).not.toContain("border-sky-300");
    });

    it("focusClaimId that matches nothing in this run's findings -> no finding is emphasized (never falls back to a nearest/summary match)", async () => {
      const result = await buildResultWithTwoFindings(CLAIM_ID_A, CLAIM_ID_B);
      const html = renderToStaticMarkup(
        createElement(DeepResearchView, { deepResearch: result, runId: "run-1", focusClaimId: "v1:findings:9:" + "z".repeat(43) })
      );
      expect(html).not.toContain("border-sky-300");
    });

    it("a finding with claimId: null is never matched by a non-null focusClaimId", async () => {
      const result = await buildResultWithTwoFindings(null, CLAIM_ID_B);
      const html = renderToStaticMarkup(
        createElement(DeepResearchView, { deepResearch: result, runId: "run-1", focusClaimId: CLAIM_ID_A })
      );
      expect(html).not.toContain("border-sky-300");
    });
  });
});
