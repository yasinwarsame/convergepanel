/**
 * BiasBlindspotAuditView tests (Milestone 2). Renders the real component
 * (react-dom/server — no jsdom needed) against fixtures built with
 * buildBiasBlindspotAuditResult (content-routed `callGemini` mock for the
 * two reused tier calls, same convention as biasBlindspotAlignment.spec.ts),
 * matching the structural-check convention used by the other adaptive
 * renderer tests.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BiasBlindspotAuditView from "@/components/adaptive/BiasBlindspotAuditView";
import { buildBiasBlindspotAuditResult, BiasBlindspotFields } from "@/lib/adaptiveSchema/biasBlindspotAlignment";
import { ModelId, ModelResult } from "@/lib/types";

function fields(overrides: Partial<BiasBlindspotFields> = {}): BiasBlindspotFields {
  return {
    summary: "",
    omittedDimensions: [],
    sharedAssumptions: [],
    missingStakeholders: [],
    geographicBiases: [],
    sourceConcentrationConcerns: [],
    evidenceTypeConcerns: [],
    followUpQuestions: [],
    sources: [],
    ...overrides,
  };
}

function perModel(entries: [string, BiasBlindspotFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

function rawResults(modelIds: string[]): ModelResult[] {
  return modelIds.map((modelId) => ({ modelId: modelId as ModelId, status: "ok", rawText: "raw text", latencyMs: 5 }));
}

function mockTierCalls(opts: { biasFindings?: any[]; coverageGaps?: any[] } = {}) {
  mockedCallGemini.mockImplementation(async (_q, _c, _k, callOpts) => {
    const prompt = callOpts?.systemPromptOverride || "";
    if (prompt.includes("biases and blind spots")) {
      return { modelId: "gemini", status: "ok", rawText: JSON.stringify({ biasAndBlindSpots: opts.biasFindings ?? [] }), latencyMs: 5 };
    }
    return { modelId: "gemini", status: "ok", rawText: JSON.stringify({ gaps: opts.coverageGaps ?? [] }), latencyMs: 5 };
  });
}

describe("BiasBlindspotAuditView", () => {
  afterEach(() => jest.clearAllMocks());

  it("renders the summary first", async () => {
    mockTierCalls();
    const result = await buildBiasBlindspotAuditResult(
      perModel([["chatgpt", fields({ summary: "This panel's coverage looks reasonably balanced overall." })], ["claude", fields()]]),
      2,
      "q",
      rawResults(["chatgpt", "claude"])
    );
    const html = renderToStaticMarkup(createElement(BiasBlindspotAuditView, { biasBlindspotAudit: result }));
    expect(html).toMatch(/This panel/);
    expect(html).toMatch(/coverage looks reasonably balanced overall\./);
  });

  it("shows Tier 1 model attribution when present", async () => {
    mockTierCalls({
      biasFindings: [
        {
          biasType: "Western-centric framing",
          description: "Assumes a US regulatory context by default.",
          modelsImplicated: ["chatgpt"],
          evidence: [{ modelId: "chatgpt", excerpt: "Under US law...", rationale: "Assumes US jurisdiction." }],
          likelyCauses: [],
          impact: "May mislead non-US readers.",
          mitigationSteps: [],
        },
      ],
    });
    const result = await buildBiasBlindspotAuditResult(perModel([["chatgpt", fields()], ["claude", fields()]]), 2, "q", rawResults(["chatgpt", "claude"]));
    const html = renderToStaticMarkup(createElement(BiasBlindspotAuditView, { biasBlindspotAudit: result }));
    expect(html).toContain("Western-centric framing");
    expect(html).toContain("Assumes a US regulatory context by default.");
  });

  it("shows the no-attribution message (not a generic empty state) when Tier 1 is empty", async () => {
    mockTierCalls({ biasFindings: [] });
    const result = await buildBiasBlindspotAuditResult(perModel([["chatgpt", fields()], ["claude", fields()]]), 2, "q", rawResults(["chatgpt", "claude"]));
    const html = renderToStaticMarkup(createElement(BiasBlindspotAuditView, { biasBlindspotAudit: result }));
    expect(html).toMatch(/No model-specific bias was confidently attributable/);
    expect(html).toMatch(/does not mean the answer is unbiased/i);
  });

  it("shows Tier 2 omission cards with a follow-up action", async () => {
    mockTierCalls({ coverageGaps: [{ dimension: "International comparisons", whyItMatters: "Only domestic data was covered.", followUpQuestion: "How does this compare internationally?" }] });
    const result = await buildBiasBlindspotAuditResult(
      perModel([["chatgpt", fields({ summary: "A domestic-focused summary." })], ["claude", fields({ summary: "Another domestic summary." })]]),
      2,
      "q",
      rawResults(["chatgpt", "claude"])
    );
    const html = renderToStaticMarkup(createElement(BiasBlindspotAuditView, { biasBlindspotAudit: result, onRunFollowUp: () => {} }));
    expect(html).toContain("What the panel did not cover");
    expect(html).toContain("International comparisons");
    expect(html).toContain("Run follow-up");
  });

  it("shows shared assumptions and missing stakeholders", async () => {
    mockTierCalls();
    const result = await buildBiasBlindspotAuditResult(
      perModel([["chatgpt", fields({ sharedAssumptions: ["Assumes stable interest rates"], missingStakeholders: ["Renters"] })]]),
      1,
      "q",
      rawResults(["chatgpt"])
    );
    const html = renderToStaticMarkup(createElement(BiasBlindspotAuditView, { biasBlindspotAudit: result }));
    expect(html).toContain("Shared assumptions");
    expect(html).toContain("Assumes stable interest rates");
    expect(html).toContain("Missing stakeholders or perspectives");
    expect(html).toContain("Renters");
  });

  it("shows the Tier 3 diagnostics strip including the homogeneity warning when flagged", async () => {
    mockTierCalls();
    const identical = "Inflation is primarily driven by demand-side pressures in this period.";
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ summary: identical, sources: ["Fed report"] })],
        ["claude", fields({ summary: identical })],
        ["grok", fields({ summary: identical })],
      ]),
      3,
      "q",
      rawResults(["chatgpt", "claude", "grok"])
    );
    const html = renderToStaticMarkup(createElement(BiasBlindspotAuditView, { biasBlindspotAudit: result }));
    expect(html).toContain("Structural diagnostics");
    expect(html).toMatch(/not independent verification/);
  });

  it("shows follow-up questions", async () => {
    mockTierCalls();
    const result = await buildBiasBlindspotAuditResult(
      perModel([["chatgpt", fields({ followUpQuestions: ["What does the data look like outside the US?"] })]]),
      1,
      "q",
      rawResults(["chatgpt"])
    );
    const html = renderToStaticMarkup(createElement(BiasBlindspotAuditView, { biasBlindspotAudit: result }));
    expect(html).toContain("Follow-up questions");
    expect(html).toContain("What does the data look like outside the US?");
  });

  it("shows collapsible model-level detail", async () => {
    mockTierCalls();
    const result = await buildBiasBlindspotAuditResult(perModel([["chatgpt", fields()], ["claude", fields()]]), 2, "q", rawResults(["chatgpt", "claude"]));
    const html = renderToStaticMarkup(createElement(BiasBlindspotAuditView, { biasBlindspotAudit: result }));
    expect(html).toMatch(/Panel detail \(2 models\)/);
  });

  it("shows Tier 1's no-attribution message (not a blank empty state) when no model produced usable data but the schema still ran", async () => {
    mockTierCalls();
    const result = await buildBiasBlindspotAuditResult([], 2, "q", []);
    const html = renderToStaticMarkup(createElement(BiasBlindspotAuditView, { biasBlindspotAudit: result }));
    expect(html).toMatch(/No model-specific bias was confidently attributable/);
    expect(html).not.toMatch(/no bias or blind-spot signals could be produced/i);
  });

  it("shows the genuine empty state only when there were no models to work with at all", async () => {
    mockTierCalls();
    const result = await buildBiasBlindspotAuditResult([], 0, "q", []);
    const html = renderToStaticMarkup(createElement(BiasBlindspotAuditView, { biasBlindspotAudit: result }));
    expect(html).toMatch(/no model responses were available/i);
  });

  it("never renders a claim matrix, Panel Verdict Card, generic research shell, or a bias score", async () => {
    mockTierCalls();
    const result = await buildBiasBlindspotAuditResult(
      perModel([["chatgpt", fields({ summary: "A summary." })]]),
      1,
      "q",
      rawResults(["chatgpt"])
    );
    const html = renderToStaticMarkup(createElement(BiasBlindspotAuditView, { biasBlindspotAudit: result }));
    expect(html).not.toMatch(/claim matrix/i);
    expect(html).not.toMatch(/panel verdict/i);
    expect(html).not.toMatch(/generic sections/i);
    expect(html).not.toMatch(/bias score/i);
  });
});
