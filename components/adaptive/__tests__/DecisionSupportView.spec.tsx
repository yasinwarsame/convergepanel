/**
 * DecisionSupportView tests (Milestone 2). Renders the real component
 * (react-dom/server — no jsdom needed) against fixtures built with
 * buildDecisionSupportResult, matching the structural-check convention used
 * by the other adaptive renderer tests.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DecisionSupportView from "@/components/adaptive/DecisionSupportView";
import { buildDecisionSupportResult, DecisionSupportFields } from "@/lib/adaptiveSchema/decisionSupportAlignment";
import { DecisionAssessment, DecisionRisk } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function fields(overrides: Partial<DecisionSupportFields> = {}): DecisionSupportFields {
  return {
    decisionQuestion: "",
    options: [],
    criteria: [],
    userProvidedCriteria: [],
    assessments: [],
    recommendationAction: "",
    recommendedOption: "none",
    recommendationRationale: "",
    recommendationCaveats: [],
    assumptions: [],
    uncertainties: [],
    risks: [],
    sensitivityFindings: [],
    reversibleNextStep: "",
    sources: [],
    ...overrides,
  };
}

function perModel(entries: [string, DecisionSupportFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

function assessment(overrides: Partial<DecisionAssessment> & { optionLabel: string; criterionLabel: string; assessment: string }): DecisionAssessment {
  return { id: "a", ...overrides };
}

function risk(overrides: Partial<DecisionRisk> & { label: string }): DecisionRisk {
  return { id: "r", ...overrides };
}

describe("DecisionSupportView", () => {
  it("renders the recommendation first, prominently", () => {
    const result = buildDecisionSupportResult(
      perModel([["chatgpt", fields({ decisionQuestion: "Which CRM should we choose?", recommendationAction: "go", recommendationRationale: "Strong fit." })]])
    );
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("Which CRM should we choose?");
    expect(html).toContain("Go");
    expect(html).toContain("Strong fit.");
  });

  it("labels a conditional recommendation distinctly", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ recommendationAction: "conditional_go" })]]));
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("Conditional go");
  });

  it("labels a deferred recommendation distinctly", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ recommendationAction: "defer" })]]));
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("Defer");
  });

  it("displays the recommended option's label when the recommendation names one", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ options: ["HubSpot", "Salesforce"], recommendationAction: "choose_option", recommendedOption: "HubSpot" })],
      ])
    );
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("HubSpot");
  });

  it("shows options considered", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ options: ["HubSpot", "Salesforce"] })]]));
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("Options considered");
    expect(html).toContain("HubSpot");
    expect(html).toContain("Salesforce");
  });

  it("shows decision criteria, marking a user-provided one", () => {
    const result = buildDecisionSupportResult(
      perModel([
        [
          "chatgpt",
          fields({
            options: ["HubSpot"],
            criteria: ["Budget under $10k"],
            userProvidedCriteria: ["Budget under $10k"],
          }),
        ],
      ])
    );
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("Budget under $10k");
    expect(html).toContain("your criterion");
  });

  it("renders the option-by-criterion matrix with an assessment cell", () => {
    const result = buildDecisionSupportResult(
      perModel([
        [
          "chatgpt",
          fields({
            options: ["HubSpot"],
            criteria: ["Total cost"],
            assessments: [assessment({ optionLabel: "HubSpot", criterionLabel: "Total cost", assessment: "Cheaper for a small team." })],
          }),
        ],
      ])
    );
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("Cheaper for a small team.");
  });

  it("shows a missing value as an em dash, never a fabricated assessment", () => {
    const result = buildDecisionSupportResult(
      perModel([
        [
          "chatgpt",
          fields({
            options: ["HubSpot", "Salesforce"],
            criteria: ["Total cost"],
            assessments: [assessment({ optionLabel: "HubSpot", criterionLabel: "Total cost", assessment: "Cheaper." })],
          }),
        ],
      ])
    );
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("—");
  });

  it("shows risks separately, with likelihood/impact/mitigation", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ risks: [risk({ label: "Vendor lock-in", likelihood: "medium", impact: "high", mitigation: "Negotiate an exit clause." })] })],
      ])
    );
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("Risks and tradeoffs");
    expect(html).toContain("Vendor lock-in");
    expect(html).toContain("Negotiate an exit clause.");
  });

  it("shows assumptions", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ assumptions: ["Budget stays flat"] })]]));
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("Assumptions");
    expect(html).toContain("Budget stays flat");
  });

  it("shows uncertainties, never hidden", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ uncertainties: ["Unclear rollout timeline"] })]]));
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("still uncertain");
    expect(html).toContain("Unclear rollout timeline");
  });

  it("shows sensitivity findings", () => {
    const result = buildDecisionSupportResult(
      perModel([["chatgpt", fields({ sensitivityFindings: ["If cost is the top priority, Option B wins instead."] })]])
    );
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("What would change this recommendation");
    expect(html).toContain("If cost is the top priority, Option B wins instead.");
  });

  it("shows the reversible next step", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ reversibleNextStep: "Run a 2-week pilot with HubSpot." })]]));
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("Lowest-regret next step");
    expect(html).toContain("Run a 2-week pilot with HubSpot.");
  });

  it("shows a human-review note when humanReviewNeeded is true", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ recommendationAction: "escalate" })]]));
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toContain("needs human review");
  });

  it("shows collapsible model-level detail", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ options: ["HubSpot"] })], ["claude", fields({ options: ["HubSpot"] })]]));
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toMatch(/Panel detail \(2 models\)/);
  });

  it("never renders a generic research shell, claim matrix, Panel Verdict Card, or a numeric decision-certainty score", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ options: ["HubSpot"], recommendationAction: "go" })]]));
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).not.toMatch(/claim matrix/i);
    expect(html).not.toMatch(/panel verdict/i);
    expect(html).not.toMatch(/generic sections/i);
    // The renderer DOES say "not a certainty score" as an honest disclaimer —
    // what must never appear is a fabricated numeric certainty/confidence
    // figure standing in for the recommendation itself.
    expect(html).not.toMatch(/\d+%\s*(certain|confiden)/i);
  });

  it("shows the genuine empty state only when there were no models to work with at all", () => {
    const result = buildDecisionSupportResult([]);
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).toMatch(/no model responses were available/i);
  });

  it("surfaces sourceBacked near the recommendation metadata in both directions — false is never silently omitted", () => {
    const sourced = buildDecisionSupportResult(
      perModel([["chatgpt", fields({ options: ["HubSpot"], recommendationAction: "go", sources: ["Vendor comparison report"] })]])
    );
    expect(renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: sourced }))).toContain("Source-backed");

    const unsourced = buildDecisionSupportResult(perModel([["chatgpt", fields({ options: ["HubSpot"], recommendationAction: "go" })]]));
    expect(renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: unsourced }))).toContain("No source support captured");
  });

  it("phrases the source signal as evidence support, never a confidence/certainty percentage", () => {
    const result = buildDecisionSupportResult(
      perModel([["chatgpt", fields({ options: ["HubSpot"], recommendationAction: "go", sources: ["Vendor report"] })]])
    );
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: result }));
    expect(html).not.toMatch(/\d+%\s*(certain|confiden)/i);
  });
});
