import { buildReviewOverview } from "@/lib/adaptiveSchema/reviewOverviewBuilder";

describe("buildReviewOverview", () => {
  it("includes the question, model counts, conclusion, and human-review flag when all are present", () => {
    const overview = buildReviewOverview({
      question: "Should we migrate to a new CRM?",
      totalModels: 4,
      successfulModels: 3,
      conclusion: "Go: HubSpot — lower cost fits the stated budget.",
      humanReviewNeeded: true,
    });
    expect(overview).toContain('This review covers the question: "Should we migrate to a new CRM?"');
    expect(overview).toContain("A panel of 4 models was consulted, with 3 models producing usable results.");
    expect(overview).toContain("The panel's overall finding: Go: HubSpot — lower cost fits the stated budget.");
    expect(overview).toContain("This result was flagged for human review.");
  });

  it("uses 'all produced usable results' phrasing when successfulModels equals totalModels", () => {
    const overview = buildReviewOverview({
      question: "What causes inflation?",
      totalModels: 3,
      successfulModels: 3,
      conclusion: "Demand exceeds supply.",
      humanReviewNeeded: false,
    });
    expect(overview).toContain("A panel of 3 models was consulted, and all produced usable results.");
    expect(overview).not.toContain("This result was flagged for human review.");
  });

  it("handles a single model without pluralizing incorrectly", () => {
    const overview = buildReviewOverview({
      question: "Define recursion.",
      totalModels: 1,
      successfulModels: 1,
      conclusion: "A function that calls itself.",
      humanReviewNeeded: false,
    });
    expect(overview).toContain("A panel of 1 model was consulted, and all produced usable results.");
  });

  it("omits the model-count sentence entirely when totalModels/successfulModels are unavailable — never invents a count", () => {
    const overview = buildReviewOverview({
      question: "Some question.",
      totalModels: null,
      successfulModels: null,
      conclusion: "Some finding.",
      humanReviewNeeded: false,
    });
    expect(overview).not.toMatch(/panel of/i);
    expect(overview).not.toMatch(/model/i);
  });

  it("omits the model-count sentence when totalModels is zero — a structurally impossible but defensively handled case", () => {
    const overview = buildReviewOverview({
      question: "Some question.",
      totalModels: 0,
      successfulModels: 0,
      conclusion: "Some finding.",
      humanReviewNeeded: false,
    });
    expect(overview).not.toMatch(/panel of/i);
  });

  it("omits the conclusion sentence when conclusion is empty — never invents a finding", () => {
    const overview = buildReviewOverview({
      question: "Some question.",
      totalModels: 2,
      successfulModels: 2,
      conclusion: "",
      humanReviewNeeded: false,
    });
    expect(overview).not.toMatch(/overall finding/i);
  });

  it("omits the conclusion sentence when conclusion is whitespace-only", () => {
    const overview = buildReviewOverview({
      question: "Some question.",
      totalModels: 2,
      successfulModels: 2,
      conclusion: "   ",
      humanReviewNeeded: false,
    });
    expect(overview).not.toMatch(/overall finding/i);
  });

  it("falls back to a generic phrase when the question is empty — never renders an empty-quoted sentence", () => {
    const overview = buildReviewOverview({
      question: "",
      totalModels: 2,
      successfulModels: 2,
      conclusion: "Some finding.",
      humanReviewNeeded: false,
    });
    expect(overview).toContain("This review covers a submitted research question.");
    expect(overview).not.toContain('""');
  });

  it("truncates a very long question at 200 characters with an ellipsis, never dumping the full raw prompt", () => {
    const longQuestion = "x".repeat(500);
    const overview = buildReviewOverview({
      question: longQuestion,
      totalModels: 2,
      successfulModels: 2,
      conclusion: "Some finding.",
      humanReviewNeeded: false,
    });
    expect(overview).toContain(`"${"x".repeat(200)}…"`);
    expect(overview).not.toContain("x".repeat(201));
    expect(overview.length).toBeLessThan(400);
  });

  it("never invents consensus/disagreement/source-backing language not present in the input", () => {
    const overview = buildReviewOverview({
      question: "Some question.",
      totalModels: 3,
      successfulModels: 2,
      conclusion: "Some finding.",
      humanReviewNeeded: false,
    });
    expect(overview).not.toMatch(/consensus|disagreement|converge|contested|source.?backed/i);
  });

  it("never double-punctuates a question that already ends in ?, !, or .", () => {
    const question = buildReviewOverview({ question: "Is this safe?", totalModels: null, successfulModels: null, conclusion: "", humanReviewNeeded: false });
    expect(question).toContain('"Is this safe?"');
    expect(question).not.toContain("?.");

    const exclamation = buildReviewOverview({ question: "Act now!", totalModels: null, successfulModels: null, conclusion: "", humanReviewNeeded: false });
    expect(exclamation).toContain('"Act now!"');
    expect(exclamation).not.toContain("!.");

    const period = buildReviewOverview({ question: "Define recursion.", totalModels: null, successfulModels: null, conclusion: "", humanReviewNeeded: false });
    expect(period).toContain('"Define recursion."');
    expect(period).not.toContain("..");
  });

  it("adds a period to a question with no terminal punctuation", () => {
    const overview = buildReviewOverview({ question: "What causes inflation", totalModels: null, successfulModels: null, conclusion: "", humanReviewNeeded: false });
    expect(overview).toContain('"What causes inflation."');
  });

  it("is pure and deterministic — identical input always produces identical output", () => {
    const input = { question: "Q", totalModels: 2, successfulModels: 2, conclusion: "C", humanReviewNeeded: true };
    expect(buildReviewOverview(input)).toBe(buildReviewOverview(input));
  });
});
