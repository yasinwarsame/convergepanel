/**
 * decision_support alignment/aggregation tests (Milestone 2).
 *
 * Covers: equivalent options merge, distinct options remain separate,
 * equivalent criteria merge, user-provided criteria remain marked as
 * user-provided, missing assessment cells remain missing (never
 * fabricated), recommendation support is reported separately from evidence
 * strength, minority recommendations remain visible (never silently
 * vote-counted away), assumptions/uncertainties/risks deduplicate,
 * sensitivity findings aggregate, failed models remain in the coverage
 * denominator, genuine action-level disagreement produces a conservative
 * (defer/escalate/conditional_go) result rather than a picked winner, and
 * malformed/empty input never throws.
 */

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

describe("buildDecisionSupportResult — options axis", () => {
  it("merges equivalent options (formatting drift)", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ options: ["HubSpot"] })],
        ["claude", fields({ options: ["Hubspot"] })],
      ])
    );
    expect(result.options).toHaveLength(1);
    expect(result.options[0].coverageCount).toBe(2);
  });

  it("keeps genuinely distinct options separate (subset-name false merge)", () => {
    const result = buildDecisionSupportResult(
      perModel([["chatgpt", fields({ options: ["HubSpot Marketing Hub", "HubSpot Sales Hub"] })]])
    );
    expect(result.options).toHaveLength(2);
  });
});

describe("buildDecisionSupportResult — criteria axis and provenance", () => {
  it("merges equivalent criteria", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ criteria: ["Total cost"] })],
        ["claude", fields({ criteria: ["Total costs"] })],
      ])
    );
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0].coverageCount).toBe(2);
  });

  it("marks a criterion 'user' when any contributing model flagged it as user-provided", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ criteria: ["Budget under $10k"], userProvidedCriteria: ["Budget under $10k"] })],
        ["claude", fields({ criteria: ["Ease of integration"] })],
      ])
    );
    const budget = result.criteria.find((c) => c.label === "Budget under $10k");
    const ease = result.criteria.find((c) => c.label === "Ease of integration");
    expect(budget?.source).toBe("user");
    expect(ease?.source).toBe("model");
  });
});

describe("buildDecisionSupportResult — assessment matrix", () => {
  it("resolves an assessment to its canonical option/criterion pair and reports coverage", () => {
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
    const option = result.options.find((o) => o.label === "HubSpot")!;
    const criterion = result.criteria.find((c) => c.label === "Total cost")!;
    const cell = result.assessments.find((a) => a.optionId === option.id && a.criterionId === criterion.id);
    expect(cell).toBeDefined();
    expect(cell!.assessment).toBe("Cheaper.");
  });

  it("never fabricates a missing option×criterion cell — a combination nobody assessed is simply absent", () => {
    const result = buildDecisionSupportResult(
      perModel([
        [
          "chatgpt",
          fields({
            options: ["HubSpot", "Salesforce"],
            criteria: ["Total cost", "Ease of integration"],
            assessments: [assessment({ optionLabel: "HubSpot", criterionLabel: "Total cost", assessment: "Cheaper." })],
          }),
        ],
      ])
    );
    // 2 options x 2 criteria = 4 possible cells; only 1 was ever assessed.
    expect(result.assessments).toHaveLength(1);
  });

  it("drops an assessment referencing an unresolvable option/criterion rather than inventing a new axis entry", () => {
    const result = buildDecisionSupportResult(
      perModel([
        [
          "chatgpt",
          fields({
            options: ["HubSpot"],
            criteria: ["Total cost"],
            assessments: [assessment({ optionLabel: "A Completely Different Product", criterionLabel: "Total cost", assessment: "x" })],
          }),
        ],
      ])
    );
    expect(result.assessments).toHaveLength(0);
    expect(result.options).toHaveLength(1);
  });
});

describe("buildDecisionSupportResult — recommendation: never a raw vote count", () => {
  it("uses the shared action and support count when all models agree", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ recommendationAction: "go", recommendationRationale: "Strong case." })],
        ["claude", fields({ recommendationAction: "go", recommendationRationale: "Strong case." })],
      ])
    );
    expect(result.recommendation.action).toBe("go");
    expect(result.recommendation.isContested).toBe(false);
    expect(result.recommendation.supportCount).toBe(2);
    expect(result.recommendation.totalModelsWithRecommendation).toBe(2);
  });

  it("falls back to a conservative action (defer/escalate) — never silently picks the majority — when models genuinely disagree on the action", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ recommendationAction: "go" })],
        ["claude", fields({ recommendationAction: "go" })],
        ["grok", fields({ recommendationAction: "no_go" })],
      ])
    );
    expect(result.recommendation.isContested).toBe(true);
    expect(["defer", "escalate"]).toContain(result.recommendation.action);
    // Support count reports plain convergence for transparency — never the aggregate decision itself.
    expect(result.recommendation.supportCount).toBe(2);
  });

  it("preserves a minority recommendation as visible convergence data, never discarding it silently", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ recommendationAction: "go" })],
        ["claude", fields({ recommendationAction: "go" })],
        ["grok", fields({ recommendationAction: "monitor" })],
      ])
    );
    expect(result.recommendation.isContested).toBe(true);
    expect(result.recommendation.caveats.join(" ")).toMatch(/go/i);
    expect(result.recommendation.caveats.join(" ")).toMatch(/monitor/i);
  });

  it("resolves recommendedOptionId only when models agree on both the action and the option", () => {
    const result = buildDecisionSupportResult(
      perModel([
        [
          "chatgpt",
          fields({
            options: ["HubSpot", "Salesforce"],
            recommendationAction: "choose_option",
            recommendedOption: "HubSpot",
          }),
        ],
        [
          "claude",
          fields({
            options: ["HubSpot", "Salesforce"],
            recommendationAction: "choose_option",
            recommendedOption: "HubSpot",
          }),
        ],
      ])
    );
    const hubspot = result.options.find((o) => o.label === "HubSpot")!;
    expect(result.recommendation.recommendedOptionId).toBe(hubspot.id);
    expect(result.recommendation.isContested).toBe(false);
  });

  it("downgrades to conditional_go and leaves recommendedOptionId unset when models agree on choose_option but disagree on which option", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ options: ["HubSpot", "Salesforce"], recommendationAction: "choose_option", recommendedOption: "HubSpot" })],
        ["claude", fields({ options: ["HubSpot", "Salesforce"], recommendationAction: "choose_option", recommendedOption: "Salesforce" })],
      ])
    );
    expect(result.recommendation.action).toBe("conditional_go");
    expect(result.recommendation.isContested).toBe(true);
    expect(result.recommendation.recommendedOptionId).toBeUndefined();
  });

  it("keeps recommendation support separate from assessment evidence strength — support is a convergence count, not a quality signal", () => {
    const result = buildDecisionSupportResult(
      perModel([
        [
          "chatgpt",
          fields({
            options: ["HubSpot"],
            criteria: ["Total cost"],
            assessments: [assessment({ optionLabel: "HubSpot", criterionLabel: "Total cost", assessment: "Unclear.", evidenceStrength: "unknown" })],
            recommendationAction: "choose_option",
            recommendedOption: "HubSpot",
          }),
        ],
        [
          "claude",
          fields({
            options: ["HubSpot"],
            criteria: ["Total cost"],
            recommendationAction: "choose_option",
            recommendedOption: "HubSpot",
          }),
        ],
      ])
    );
    expect(result.recommendation.supportCount).toBe(2);
    expect(result.assessments[0].evidenceStrength).toBe("unknown");
    // Weak/unknown evidence specifically behind the recommended option still triggers human review,
    // even though the panel unanimously converged on it — support count and evidence quality are
    // computed independently and never conflated.
    expect(result.humanReviewNeeded).toBe(true);
  });
});

describe("buildDecisionSupportResult — risks, assumptions, uncertainties, sensitivity findings", () => {
  it("deduplicates near-duplicate assumptions/uncertainties", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ assumptions: ["Budget stays flat"], uncertainties: ["Unclear rollout timeline"] })],
        ["claude", fields({ assumptions: ["The budget stays flat"], uncertainties: ["The rollout timeline is unclear"] })],
      ])
    );
    expect(result.assumptions).toHaveLength(1);
    expect(result.uncertainties).toHaveLength(1);
  });

  it("deduplicates near-duplicate risks and preserves likelihood/impact/mitigation", () => {
    const result = buildDecisionSupportResult(
      perModel([
        [
          "chatgpt",
          fields({
            risks: [risk({ label: "Vendor lock-in", likelihood: "medium", impact: "high", mitigation: "Negotiate an exit clause." })],
          }),
        ],
        ["claude", fields({ risks: [risk({ label: "Risk of vendor lock-in", likelihood: "medium", impact: "high" })] })],
      ])
    );
    expect(result.risks).toHaveLength(1);
    expect(result.risks[0].coverageCount).toBe(2);
    expect(result.risks[0].mitigation).toBe("Negotiate an exit clause.");
  });

  it("aggregates sensitivity findings across models", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ sensitivityFindings: ["Weighting cost highest favors the cheaper option instead."] })],
        ["claude", fields({ sensitivityFindings: ["A six-month deadline would rule out the slower vendor's onboarding process."] })],
      ])
    );
    expect(result.sensitivityFindings).toHaveLength(2);
  });
});

describe("buildDecisionSupportResult — producer canonicalization (absent vs. explicit-undefined own-property)", () => {
  it("omits risk optionId/likelihood/impact/mitigation as genuinely absent keys when not supplied", () => {
    const result = buildDecisionSupportResult(
      perModel([["chatgpt", fields({ risks: [risk({ label: "Vendor lock-in" })] })]])
    );
    const r = result.risks[0];
    expect(Object.prototype.hasOwnProperty.call(r, "optionId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(r, "likelihood")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(r, "impact")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(r, "mitigation")).toBe(false);
    expect(Object.keys(JSON.parse(JSON.stringify(r)))).not.toEqual(
      expect.arrayContaining(["optionId", "likelihood", "impact", "mitigation"])
    );
  });

  it("preserves risk likelihood/impact/mitigation as real own-properties when supplied", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ risks: [risk({ label: "Vendor lock-in", likelihood: "medium", impact: "high", mitigation: "Negotiate an exit clause." })] })],
      ])
    );
    const r = result.risks[0];
    expect(Object.prototype.hasOwnProperty.call(r, "likelihood")).toBe(true);
    expect(r.likelihood).toBe("medium");
    expect(Object.prototype.hasOwnProperty.call(r, "impact")).toBe(true);
    expect(r.impact).toBe("high");
    expect(Object.prototype.hasOwnProperty.call(r, "mitigation")).toBe(true);
    expect(r.mitigation).toBe("Negotiate an exit clause.");
  });

  it("omits recommendedOptionId and reversibleNextStep as genuinely absent keys when not resolvable/supplied", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ options: ["HubSpot", "Salesforce"], recommendationAction: "choose_option", recommendedOption: "HubSpot" })],
        ["claude", fields({ options: ["HubSpot", "Salesforce"], recommendationAction: "choose_option", recommendedOption: "Salesforce" })],
      ])
    );
    expect(Object.prototype.hasOwnProperty.call(result.recommendation, "recommendedOptionId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, "reversibleNextStep")).toBe(false);
    expect(Object.keys(JSON.parse(JSON.stringify(result.recommendation)))).not.toEqual(
      expect.arrayContaining(["recommendedOptionId"])
    );
    expect(Object.keys(JSON.parse(JSON.stringify(result)))).not.toEqual(expect.arrayContaining(["reversibleNextStep"]));
  });

  it("preserves recommendedOptionId and reversibleNextStep as real own-properties when resolvable/supplied", () => {
    const result = buildDecisionSupportResult(
      perModel([
        [
          "chatgpt",
          fields({
            options: ["HubSpot", "Salesforce"],
            recommendationAction: "choose_option",
            recommendedOption: "HubSpot",
            reversibleNextStep: "Run a 30-day pilot.",
          }),
        ],
        [
          "claude",
          fields({
            options: ["HubSpot", "Salesforce"],
            recommendationAction: "choose_option",
            recommendedOption: "HubSpot",
            reversibleNextStep: "Run a 30-day pilot.",
          }),
        ],
      ])
    );
    const hubspot = result.options.find((o) => o.label === "HubSpot")!;
    expect(Object.prototype.hasOwnProperty.call(result.recommendation, "recommendedOptionId")).toBe(true);
    expect(result.recommendation.recommendedOptionId).toBe(hubspot.id);
    expect(Object.prototype.hasOwnProperty.call(result, "reversibleNextStep")).toBe(true);
    expect(result.reversibleNextStep).toBe("Run a 30-day pilot.");
  });
});

describe("buildDecisionSupportResult — model coverage", () => {
  it("uses the full attempted model count as the coverage denominator, not just the successful ones", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ options: ["HubSpot"] })]]), 2);
    expect(result.options[0].coverageCount).toBe(1);
    expect(result.options[0].totalModels).toBe(2);
    expect(result.totalModels).toBe(2);
  });
});

describe("buildDecisionSupportResult — empty and malformed input", () => {
  it("never throws and returns a safe escalate default when no model produced usable data", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields()], ["claude", fields()]]));
    expect(result.options).toEqual([]);
    expect(result.recommendation.action).toBe("escalate");
    expect(result.humanReviewNeeded).toBe(true);
    expect(result.totalModels).toBe(2);
  });

  it("handles a totally empty perModel array", () => {
    const result = buildDecisionSupportResult([]);
    expect(result.options).toEqual([]);
    expect(result.recommendation.action).toBe("escalate");
    expect(result.totalModels).toBe(0);
  });

  it("ignores an unparseable recommendationAction rather than crashing or fabricating a default action", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ recommendationAction: "definitely maybe" })]]));
    expect(result.recommendation.totalModelsWithRecommendation).toBe(0);
    expect(result.recommendation.action).toBe("escalate");
  });
});

describe("buildDecisionSupportResult — sources (Phase 10D.1)", () => {
  it("preserves every model's own sources, exact-string deduplicated", () => {
    const result = buildDecisionSupportResult(
      perModel([
        ["chatgpt", fields({ sources: ["https://example.com/a", "Gartner report"] })],
        ["claude", fields({ sources: ["https://example.com/a", "https://example.com/b"] })],
      ])
    );
    expect(result.sources).toEqual(["https://example.com/a", "Gartner report", "https://example.com/b"]);
  });

  it("is an empty array when no model cited a source", () => {
    const result = buildDecisionSupportResult(perModel([["chatgpt", fields({ options: ["HubSpot"] })]]));
    expect(result.sources).toEqual([]);
  });

  it("is an empty array for a totally empty perModel input", () => {
    const result = buildDecisionSupportResult([]);
    expect(result.sources).toEqual([]);
  });
});
