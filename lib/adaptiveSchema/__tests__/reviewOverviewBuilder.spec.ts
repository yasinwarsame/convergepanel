/**
 * Phase 10D.1, corrected in Phase 10D.1C — `buildReviewOverview()` tests.
 *
 * Covers: model-participation count accuracy (using `modelsWithUsableOutput`,
 * never the looser `successfulModels`), the non-redundancy contract (the
 * overview must never reproduce the full conclusion verbatim), real
 * schema-shaped fixtures, question handling, and the neutral
 * sourceBacked/humanReviewNeeded wording.
 */

import { buildReviewOverview, type ReviewOverviewInput } from "@/lib/adaptiveSchema/reviewOverviewBuilder";

function baseInput(overrides: Partial<ReviewOverviewInput> = {}): ReviewOverviewInput {
  return {
    question: "Some question?",
    totalModels: null,
    modelsWithUsableOutput: null,
    conclusion: "",
    sourceBacked: false,
    humanReviewNeeded: false,
    ...overrides,
  };
}

describe("buildReviewOverview — question handling", () => {
  it("includes the question verbatim, quoted", () => {
    const overview = buildReviewOverview(baseInput({ question: "Should we migrate to a new CRM?" }));
    expect(overview).toContain('This review covers the question: "Should we migrate to a new CRM?"');
  });

  it("never double-punctuates a question that already ends in ?, !, or .", () => {
    expect(buildReviewOverview(baseInput({ question: "Is this safe?" }))).toContain('"Is this safe?"');
    expect(buildReviewOverview(baseInput({ question: "Is this safe?" }))).not.toContain("?.");
    expect(buildReviewOverview(baseInput({ question: "Act now!" }))).not.toContain("!.");
    expect(buildReviewOverview(baseInput({ question: "Define recursion." }))).not.toContain("..");
  });

  it("adds a period to a question with no terminal punctuation", () => {
    expect(buildReviewOverview(baseInput({ question: "What causes inflation" }))).toContain('"What causes inflation."');
  });

  it("falls back to a generic phrase when the question is empty", () => {
    const overview = buildReviewOverview(baseInput({ question: "" }));
    expect(overview).toContain("This review covers a submitted research question.");
    expect(overview).not.toContain('""');
  });

  it("truncates a very long question at 200 characters with an ellipsis", () => {
    const longQuestion = "x".repeat(500);
    const overview = buildReviewOverview(baseInput({ question: longQuestion }));
    expect(overview).toContain(`"${"x".repeat(200)}…"`);
    expect(overview).not.toContain("x".repeat(201));
  });
});

describe("buildReviewOverview — participation count accuracy (Phase 10D.1C)", () => {
  it("5 attempted, 3 usable: reports 3, never a looser connector-success count", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 5, modelsWithUsableOutput: 3 }));
    expect(overview).toContain("Of 5 models attempted, 3 produced usable results.");
  });

  it("5 attempted, 0 usable (e.g. all connector-succeeded but failed schema validation): reports 0, never overstates", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 5, modelsWithUsableOutput: 0 }));
    expect(overview).toContain("Of 5 models attempted, 0 produced usable results.");
  });

  it("1 attempted, 1 usable: correct singular grammar, not '1 models'/'1 responses'", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 1, modelsWithUsableOutput: 1 }));
    expect(overview).toContain("Of 1 model attempted, 1 produced a usable result.");
    expect(overview).not.toMatch(/1 models/);
    expect(overview).not.toMatch(/1 produced usable results\b/); // plural "results" must not follow a count of 1
  });

  it("all models usable: still uses the numeric 'Of N attempted, M produced' phrasing, no separate 'all succeeded' branch needed", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 5, modelsWithUsableOutput: 5 }));
    expect(overview).toContain("Of 5 models attempted, 5 produced usable results.");
  });

  it("never mentions a connector-success concept — modelsWithUsableOutput is the only count field used for 'usable'", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 5, modelsWithUsableOutput: 3 }));
    expect(overview).not.toMatch(/connector|successful model/i);
  });

  it("omits the participation sentence entirely when totalModels is unavailable — never invents a count", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: null, modelsWithUsableOutput: null }));
    expect(overview).not.toMatch(/model/i);
  });

  it("omits the participation sentence when totalModels is zero", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 0, modelsWithUsableOutput: 0 }));
    expect(overview).not.toMatch(/model/i);
  });

  it("historical fallback: totalModels known but modelsWithUsableOutput unavailable — degrades to an attempted-only statement, never fabricates a usable count under a different metric", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 5, modelsWithUsableOutput: null }));
    expect(overview).toContain("A panel of 5 models was attempted for this review.");
    expect(overview).not.toMatch(/usable/i);
  });

  it("historical fallback pluralizes correctly for a single model", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 1, modelsWithUsableOutput: null }));
    expect(overview).toContain("A panel of 1 model was attempted for this review.");
  });
});

describe("buildReviewOverview — non-redundancy contract (Phase 10D.1C)", () => {
  it("never reproduces a short (single-sentence) conclusion verbatim — uses a neutral status clause instead", () => {
    const conclusion = "Overall risk is moderate.";
    const overview = buildReviewOverview(baseInput({ conclusion, sourceBacked: true }));
    expect(overview).not.toContain(conclusion);
    expect(overview).toContain("The panel reached a source-backed conclusion.");
  });

  it("never reproduces a single-sentence conclusion even without sourceBacked", () => {
    const conclusion = "Go: HubSpot — lower cost fits the stated budget.";
    const overview = buildReviewOverview(baseInput({ conclusion, sourceBacked: false }));
    expect(overview).not.toContain(conclusion);
    expect(overview).toContain("The panel reached a conclusion, though no sources were cited.");
  });

  it("never reproduces a multi-sentence conclusion in full — only the first sentence may appear, as a strictly shorter excerpt", () => {
    const conclusion = "Remote work modestly reduces measured productivity overall. However, effects vary substantially by industry and task type.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).not.toContain(conclusion);
    expect(overview).toContain("The panel's finding begins: Remote work modestly reduces measured productivity overall.");
    expect(overview).not.toContain("However, effects vary substantially");
  });

  it("never reproduces a long conclusion in full", () => {
    const sentence1 = "A".repeat(50) + ".";
    const sentence2 = "B".repeat(300) + ".";
    const conclusion = `${sentence1} ${sentence2}`;
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).not.toContain(conclusion);
    expect(overview).not.toContain(sentence2);
  });

  it("caps an excerpt that is itself very long, never exceeding a small bounded length", () => {
    const longFirstSentence = "A".repeat(300) + ".";
    const conclusion = `${longFirstSentence} Second sentence.`;
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).not.toContain(longFirstSentence);
    expect(overview).toContain("…");
  });

  it("handles a punctuation-heavy conclusion without producing duplicated or malformed punctuation", () => {
    const conclusion = "Is this safe?! It depends on context.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).not.toContain(conclusion);
    expect(overview).not.toMatch(/[.?!]{3,}/); // no obviously broken punctuation runs
  });

  it("omits the result-kind clause entirely when the conclusion is empty — never fabricates a finding", () => {
    const overview = buildReviewOverview(baseInput({ conclusion: "" }));
    expect(overview).not.toMatch(/panel reached|panel's finding/i);
  });

  it("omits the result-kind clause when the conclusion is whitespace-only", () => {
    const overview = buildReviewOverview(baseInput({ conclusion: "   \n\t " }));
    expect(overview).not.toMatch(/panel reached|panel's finding/i);
  });

  it("does not change the meaning or add certainty beyond what the conclusion states", () => {
    const conclusion = "The evidence is inconclusive.";
    const overview = buildReviewOverview(baseInput({ conclusion, sourceBacked: false }));
    expect(overview).not.toMatch(/definitely|certainly|conclusively/i);
  });

  it("never invents consensus/disagreement language not present in the input", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 3, modelsWithUsableOutput: 2, conclusion: "Some finding." }));
    expect(overview).not.toMatch(/consensus|disagreement|converge|contested/i);
  });
});

describe("buildReviewOverview — humanReviewNeeded / sourceBacked wording", () => {
  it("includes a neutral human-review-flagged sentence only when true", () => {
    expect(buildReviewOverview(baseInput({ humanReviewNeeded: true }))).toContain("This result was flagged for human review.");
    expect(buildReviewOverview(baseInput({ humanReviewNeeded: false }))).not.toContain("flagged for human review");
  });

  it("does not translate humanReviewNeeded into a stronger unreliability claim", () => {
    const overview = buildReviewOverview(baseInput({ humanReviewNeeded: true }));
    expect(overview).not.toMatch(/unreliable|untrustworthy|incorrect/i);
  });
});

describe("buildReviewOverview — real schema-shaped fixtures (Phase 10D.1C, Part G/O)", () => {
  it("definition_explanation: single-sentence conclusion, no verbatim duplication", () => {
    const conclusion = "A recursive function is one that calls itself to solve smaller instances of the same problem.";
    const overview = buildReviewOverview(
      baseInput({ question: "What is recursion?", totalModels: 4, modelsWithUsableOutput: 4, conclusion, sourceBacked: false })
    );
    expect(overview).not.toContain(conclusion);
    expect(overview).toMatch(/^This review covers the question: "What is recursion\?" Of 4 models attempted, 4 produced usable results\. The panel reached a conclusion, though no sources were cited\.$/);
  });

  it("causal_explanation: single-sentence conclusion", () => {
    const conclusion = "Sleep deprivation impairs next-day cognitive performance.";
    const overview = buildReviewOverview(
      baseInput({ question: "Why does lack of sleep hurt performance?", totalModels: 3, modelsWithUsableOutput: 2, conclusion, sourceBacked: true })
    );
    expect(overview).not.toContain(conclusion);
    expect(overview).toContain("Of 3 models attempted, 2 produced usable results.");
    expect(overview).toContain("The panel reached a source-backed conclusion.");
  });

  it("deep_research: multi-sentence executive summary, only the first sentence excerpted", () => {
    const conclusion = "Remote work modestly reduces measured productivity in most studies. Effects vary substantially by industry and role.";
    const overview = buildReviewOverview(
      baseInput({ question: "Does remote work reduce productivity?", totalModels: 5, modelsWithUsableOutput: 4, conclusion })
    );
    expect(overview).not.toContain(conclusion);
    expect(overview).toContain("The panel's finding begins: Remote work modestly reduces measured productivity in most studies.");
  });

  it("evidence_review: single-sentence overallAssessment", () => {
    const conclusion = "The evidence is moderately strong but methodologically limited.";
    const overview = buildReviewOverview(
      baseInput({ question: "Is this study's evidence strong?", totalModels: 3, modelsWithUsableOutput: 3, conclusion, sourceBacked: true })
    );
    expect(overview).not.toContain(conclusion);
    expect(overview).toContain("The panel reached a source-backed conclusion.");
  });

  it("bias_blindspot_audit: single-sentence summary", () => {
    const conclusion = "The panel's analysis shows a moderate US-centric framing.";
    const overview = buildReviewOverview(
      baseInput({ question: "Is this analysis geographically biased?", totalModels: 3, modelsWithUsableOutput: 2, conclusion, sourceBacked: false })
    );
    expect(overview).not.toContain(conclusion);
    expect(overview).toContain("Of 3 models attempted, 2 produced usable results.");
  });

  it("decision_support: templated conclusion (action + rationale)", () => {
    const conclusion = "Go: HubSpot — lower cost fits the stated budget.";
    const overview = buildReviewOverview(
      baseInput({ question: "Which CRM should we choose?", totalModels: 2, modelsWithUsableOutput: 2, conclusion, sourceBacked: false })
    );
    expect(overview).not.toContain(conclusion);
    expect(overview).not.toMatch(/1 models|1 responses/);
    expect(overview).not.toMatch(/[.?!]{2,}/);
  });

  it("partial-degradation fixture: connector calls succeeded but schema validation failed for some — modelsWithUsableOutput reflects the true usable count, not the connector-success count", () => {
    // Models attempted a valid API call, but only 2 of 4 produced schema-valid output.
    const overview = buildReviewOverview(
      baseInput({ question: "What are the risks?", totalModels: 4, modelsWithUsableOutput: 2, conclusion: "Risk is elevated in Q3." })
    );
    expect(overview).toContain("Of 4 models attempted, 2 produced usable results.");
  });
});

describe("buildReviewOverview — determinism", () => {
  it("is pure and deterministic — identical input always produces identical output", () => {
    const input = baseInput({ totalModels: 2, modelsWithUsableOutput: 2, conclusion: "C.", humanReviewNeeded: true });
    expect(buildReviewOverview(input)).toBe(buildReviewOverview(input));
  });
});
