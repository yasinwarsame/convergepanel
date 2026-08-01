/**
 * CausalExplanationView tests (Milestone 2). Renders the real component
 * (react-dom/server — no jsdom needed) against fixtures built with
 * buildCausalExplanationResult, matching the structural-check convention
 * used by the other adaptive renderer tests.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CausalExplanationView from "@/components/adaptive/CausalExplanationView";
import { buildCausalExplanationResult, CausalExplanationFields } from "@/lib/adaptiveSchema/causalAlignment";
import { ModelId } from "@/lib/types";

function fields(overrides: Partial<CausalExplanationFields> = {}): CausalExplanationFields {
  return {
    directAnswer: "",
    directCauses: [],
    contributingFactors: [],
    triggers: [],
    amplifiers: [],
    alternativeExplanations: [],
    causalLinks: [],
    confounders: [],
    disputedInterpretations: [],
    unknowns: [],
    testsOrEvidenceNeeded: [],
    sources: [],
    ...overrides,
  };
}

function perModel(entries: [string, CausalExplanationFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

describe("CausalExplanationView", () => {
  it("renders the direct answer first", () => {
    const result = buildCausalExplanationResult(perModel([["chatgpt", fields({ directAnswer: "Inflation rises when demand outpaces supply." })]]), 1);
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toContain("Inflation rises when demand outpaces supply.");
  });

  it("shows direct causes before contributing factors", () => {
    const result = buildCausalExplanationResult(
      perModel([["chatgpt", fields({ directCauses: ["Rising demand"], contributingFactors: ["Low interest rates"] })]]),
      1
    );
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toContain("Rising demand");
    expect(html).toContain("Low interest rates");
    expect(html.indexOf("Rising demand")).toBeLessThan(html.indexOf("Low interest rates"));
  });

  it("shows the causal mechanism/chain", () => {
    const result = buildCausalExplanationResult(
      perModel([["chatgpt", fields({ causalLinks: ["Higher rates raise borrowing costs, which cools demand."] })]]),
      1
    );
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toContain("Higher rates raise borrowing costs, which cools demand.");
  });

  it("shows confounders", () => {
    const result = buildCausalExplanationResult(perModel([["chatgpt", fields({ confounders: ["Seasonal demand swings"] })]]), 1);
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toContain("Seasonal demand swings");
  });

  it("shows alternative explanations with visually distinct treatment from causes", () => {
    const result = buildCausalExplanationResult(
      perModel([["chatgpt", fields({ directCauses: ["Rising demand"], alternativeExplanations: ["Currency devaluation alone"] })]]),
      1
    );
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toContain("Alternative explanations");
    expect(html).toContain("Currency devaluation alone");
  });

  it("shows disputed interpretations with their supporting models", () => {
    const result = buildCausalExplanationResult(
      perModel([["chatgpt", fields({ disputedInterpretations: ["Some economists see this as purely monetary."] })]]),
      1
    );
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toContain("Disputed interpretations");
    expect(html).toContain("Some economists see this as purely monetary.");
  });

  it("shows unknowns", () => {
    const result = buildCausalExplanationResult(perModel([["chatgpt", fields({ unknowns: ["Long-term persistence is unclear"] })]]), 1);
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toContain("Long-term persistence is unclear");
  });

  it("shows evidence/tests needed", () => {
    const result = buildCausalExplanationResult(
      perModel([["chatgpt", fields({ testsOrEvidenceNeeded: ["A controlled experiment isolating demand shocks"] })]]),
      1
    );
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toContain("Evidence that would help");
    expect(html).toContain("A controlled experiment isolating demand shocks");
  });

  it("shows a coverage badge phrased as mention coverage, never a certainty/confidence percentage", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ directCauses: ["Rising demand"] })],
        ["claude", fields({ directCauses: ["Rising demand"] })],
      ]),
      2
    );
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toContain("2 of 2 models covered this");
    expect(html).not.toMatch(/\d+%\s*confiden/i);
    // The word "certainty" may appear only to explicitly DISCLAIM it (e.g. a
    // tooltip saying "not a certainty score") — never as an actual value.
    expect(html).not.toMatch(/certainty:\s*\d/i);
    expect(html).not.toMatch(/\d+%\s*certain/i);
  });

  it("shows a 'contested' evidence-strength label only when the panel itself flagged disagreement", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ directCauses: ["Currency devaluation"] })],
        ["claude", fields({ alternativeExplanations: ["Currency devaluation"] })],
      ]),
      2
    );
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toContain("Contested");
  });

  it("shows collapsible model-level detail, not primary content", () => {
    const result = buildCausalExplanationResult(
      perModel([
        ["chatgpt", fields({ directCauses: ["Rising demand"] })],
        ["claude", fields({ directCauses: ["Rising demand"] })],
      ]),
      2
    );
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toContain("<details");
    expect(html).toMatch(/Panel detail \(2 models\)/);
  });

  it("shows a high-stakes human-review note when riskLevel is safety_critical or high_stakes", () => {
    const result = buildCausalExplanationResult(perModel([["chatgpt", fields({ directAnswer: "X causes Y." })]]), 1);
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result, riskLevel: "safety_critical" }));
    expect(html).toMatch(/professional or expert review/i);
  });

  it("omits the high-stakes note for casual/professional riskLevel", () => {
    const result = buildCausalExplanationResult(perModel([["chatgpt", fields({ directAnswer: "X causes Y." })]]), 1);
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result, riskLevel: "casual" }));
    expect(html).not.toMatch(/professional or expert review/i);
  });

  it("handles a fully empty result (every model failed to parse) without crashing", () => {
    const result = buildCausalExplanationResult([], 2);
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).toMatch(/no causal explanation could be produced/i);
  });

  it("distinguishes zero models attempted from models attempted but no usable causal account produced", () => {
    const noModels = buildCausalExplanationResult([], 0);
    const htmlNoModels = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: noModels }));
    expect(htmlNoModels).toMatch(/no model responses were available/i);

    const noUsableOutput = buildCausalExplanationResult([], 2);
    const htmlNoUsableOutput = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: noUsableOutput }));
    expect(htmlNoUsableOutput).not.toMatch(/no model responses were available/i);
    expect(htmlNoUsableOutput).toMatch(/no causal explanation could be produced/i);
  });

  it("never renders a generic research shell, Agreement Map, Panel Verdict Card, or claim matrix", () => {
    const result = buildCausalExplanationResult(perModel([["chatgpt", fields({ directAnswer: "X causes Y." })]]), 1);
    const html = renderToStaticMarkup(createElement(CausalExplanationView, { causalExplanation: result }));
    expect(html).not.toMatch(/agreement map/i);
    expect(html).not.toMatch(/panel verdict/i);
    expect(html).not.toMatch(/claim matrix/i);
    expect(html).not.toMatch(/generic sections/i);
  });
});
