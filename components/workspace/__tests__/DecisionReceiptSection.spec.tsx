/**
 * Phase 10D.1 — DecisionReceiptSection tests. `react-test-renderer`
 * (no `act()` needed — this is a pure, synchronous render, no effects).
 * Covers: section ordering (Review Overview → Panel Conclusion →
 * Supporting Detail → Sources), sources rendering (present/empty),
 * unavailable-receipt gate (unchanged from 10C.4A-U2C), and the
 * terminology freeze (never implies independent verification).
 */

import { createElement } from "react";
import TestRenderer from "react-test-renderer";
import DecisionReceiptSection, { DECISION_RECEIPT_UNAVAILABLE_MESSAGE, NO_SOURCES_MESSAGE, SOURCES_DISCLAIMER_MESSAGE } from "@/components/workspace/DecisionReceiptSection";

const VALID_RECEIPT = {
  conclusion: "Overall risk is moderate.",
  basis: ["Historical incident rate"],
  assumptions: ["Mitigations remain funded"],
  uncertainties: ["Long-tail vendor risk"],
  limitations: ["One model did not return usable output"],
  sources: [
    { url: "https://example.com/report-a", hostname: "example.com" },
    { url: "https://another-example.org/study", hostname: "another-example.org" },
  ],
  sourceBacked: true,
  humanReviewNeeded: true,
};

function render(receipt: unknown, reviewOverview: string) {
  return TestRenderer.create(createElement(DecisionReceiptSection, { receipt, reviewOverview }));
}

describe("DecisionReceiptSection", () => {
  it("renders the unavailable message and never fabricates content when the receipt is unusable", () => {
    const renderer = render({ conclusion: "" }, "Some overview.");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain(DECISION_RECEIPT_UNAVAILABLE_MESSAGE);
    expect(text).not.toContain("Some overview.");
    expect(text).not.toContain("Panel Conclusion");
  });

  it("renders Review Overview before Panel Conclusion, which comes before Supporting Detail, which comes before Sources", () => {
    const renderer = render(VALID_RECEIPT, "This review covers the question: \"Test?\"");
    const html = JSON.stringify(renderer.toJSON());
    const overviewIndex = html.indexOf("Review Overview");
    const conclusionIndex = html.indexOf("Panel Conclusion");
    const basisIndex = html.indexOf("Basis");
    const sourcesIndex = html.indexOf("Sources cited by the panel");
    expect(overviewIndex).toBeGreaterThan(-1);
    expect(conclusionIndex).toBeGreaterThan(overviewIndex);
    expect(basisIndex).toBeGreaterThan(conclusionIndex);
    expect(sourcesIndex).toBeGreaterThan(basisIndex);
  });

  it("renders the overview text verbatim", () => {
    const renderer = render(VALID_RECEIPT, "This review covers the question: \"Test?\" A panel of 3 models was consulted.");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("This review covers the question: \\\"Test?\\\" A panel of 3 models was consulted.");
  });

  it("omits the Review Overview heading entirely when reviewOverview is an empty string — never renders an empty heading", () => {
    const renderer = render(VALID_RECEIPT, "");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("Review Overview");
    expect(text).toContain("Panel Conclusion");
  });

  it("still renders the conclusion and supporting detail unchanged from before this phase", () => {
    const renderer = render(VALID_RECEIPT, "");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Overall risk is moderate.");
    expect(text).toContain("Historical incident rate");
    expect(text).toContain("Mitigations remain funded");
    expect(text).toContain("Long-tail vendor risk");
    expect(text).toContain("One model did not return usable output");
  });

  it("renders each source as a link to its exact URL, labeled by hostname", () => {
    const renderer = render(VALID_RECEIPT, "");
    const links = renderer.root.findAllByType("a");
    expect(links).toHaveLength(2);
    expect(links[0].props.href).toBe("https://example.com/report-a");
    expect(links[0].props.children).toBe("example.com");
    expect(links[1].props.href).toBe("https://another-example.org/study");
    expect(links[1].props.children).toBe("another-example.org");
  });

  it("every source link opens safely in a new tab (target=_blank, rel=noopener noreferrer)", () => {
    const renderer = render(VALID_RECEIPT, "");
    const links = renderer.root.findAllByType("a");
    for (const link of links) {
      expect(link.props.target).toBe("_blank");
      expect(link.props.rel).toBe("noopener noreferrer");
    }
  });

  it("shows the explicit no-sources state, without implying failure, when sources is empty", () => {
    const renderer = render({ ...VALID_RECEIPT, sources: [] }, "");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain(NO_SOURCES_MESSAGE);
    expect(renderer.root.findAllByType("a")).toHaveLength(0);
  });

  it("never implies sources are independently verified, authoritative, or fact-checked (Part B/K terminology freeze)", () => {
    const renderer = render(VALID_RECEIPT, "");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain(SOURCES_DISCLAIMER_MESSAGE);
    expect(text).not.toMatch(/independently verified source|authoritative source|fact-checked/i);
  });

  it("renders raw source content as plain text only — never dangerouslySetInnerHTML, never Markdown", () => {
    const maliciousUrl = "https://example.com/a";
    const renderer = render({ ...VALID_RECEIPT, sources: [{ url: maliciousUrl, hostname: "<script>evil</script>" }] }, "");
    const link = renderer.root.findAllByType("a")[0];
    // React always text-escapes children — this asserts the component never routes hostname through dangerouslySetInnerHTML.
    expect(link.props.dangerouslySetInnerHTML).toBeUndefined();
    expect(link.props.children).toBe("<script>evil</script>");
  });
});
