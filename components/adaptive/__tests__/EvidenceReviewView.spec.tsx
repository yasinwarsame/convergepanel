/**
 * EvidenceReviewView tests (Milestone 2). Renders the real component
 * (react-dom/server — no jsdom needed) against fixtures built with
 * buildEvidenceReviewResult, matching the structural-check convention used
 * by the other adaptive renderer tests.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EvidenceReviewView from "@/components/adaptive/EvidenceReviewView";
import { buildEvidenceReviewResult, EvidenceReviewFields } from "@/lib/adaptiveSchema/evidenceReviewAlignment";
import { EvidenceDimension } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function dim(overrides: Partial<EvidenceDimension> & { id: string; dimension: string; assessment: string }): EvidenceDimension {
  return { ...overrides };
}

function fields(overrides: Partial<EvidenceReviewFields> = {}): EvidenceReviewFields {
  return {
    overallAssessment: "",
    dimensions: [],
    redFlags: [],
    strengths: [],
    applicabilityCaveats: [],
    recommendedChecks: [],
    sources: [],
    ...overrides,
  };
}

function perModel(entries: [string, EvidenceReviewFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

describe("EvidenceReviewView", () => {
  it("renders the overall assessment first", () => {
    const result = buildEvidenceReviewResult(perModel([["chatgpt", fields({ overallAssessment: "The evidence for this claim is moderate." })]]));
    const html = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: result }));
    expect(html).toContain("The evidence for this claim is moderate.");
  });

  it("renders quality dimensions with a strength badge and coverage badge", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        ["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Sample size", assessment: "The sample is small.", strength: "weak" })] })],
        ["claude", fields({ dimensions: [dim({ id: "b", dimension: "Sample size", assessment: "The sample is small.", strength: "weak" })] })],
      ])
    );
    const html = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: result }));
    expect(html).toContain("Sample size");
    expect(html).toContain("Weak");
    expect(html).toContain("2 of 2 models covered this");
  });

  it("shows a contested badge only when models' own strength reads conflict", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        ["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Sample size", assessment: "Small.", strength: "weak" })] })],
        ["claude", fields({ dimensions: [dim({ id: "b", dimension: "Sample size", assessment: "Adequate.", strength: "strong" })] })],
      ])
    );
    const html = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: result }));
    expect(html).toContain("Contested");
  });

  it("shows red flags in a distinct visual section", () => {
    const result = buildEvidenceReviewResult(perModel([["chatgpt", fields({ redFlags: ["No control group was used"] })]]));
    const html = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: result }));
    expect(html).toContain("Red flags");
    expect(html).toContain("No control group was used");
  });

  it("shows strengths, applicability caveats, and recommended checks", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        [
          "chatgpt",
          fields({
            strengths: ["Peer-reviewed"],
            applicabilityCaveats: ["Only studied in one country"],
            recommendedChecks: ["Check for a pre-registration"],
          }),
        ],
      ])
    );
    const html = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: result }));
    expect(html).toContain("Strengths");
    expect(html).toContain("Peer-reviewed");
    expect(html).toContain("Applicability caveats");
    expect(html).toContain("Only studied in one country");
    expect(html).toContain("Recommended checks");
    expect(html).toContain("Check for a pre-registration");
  });

  it("shows collapsible model-level detail", () => {
    const result = buildEvidenceReviewResult(
      perModel([
        ["chatgpt", fields({ dimensions: [dim({ id: "a", dimension: "Methodology", assessment: "x" })] })],
        ["claude", fields({ dimensions: [dim({ id: "b", dimension: "Methodology", assessment: "x" })] })],
      ])
    );
    const html = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: result }));
    expect(html).toMatch(/Panel detail \(2 models\)/);
  });

  it("shows a high-stakes human-review note when riskLevel is safety_critical", () => {
    const result = buildEvidenceReviewResult(perModel([["chatgpt", fields({ overallAssessment: "x" })]]));
    const html = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: result, riskLevel: "safety_critical" }));
    expect(html).toMatch(/professional or expert review/i);
  });

  it("omits the high-stakes note for casual riskLevel", () => {
    const result = buildEvidenceReviewResult(perModel([["chatgpt", fields({ overallAssessment: "x" })]]));
    const html = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: result, riskLevel: "casual" }));
    expect(html).not.toMatch(/professional or expert review/i);
  });

  it("handles a fully empty result without crashing", () => {
    const result = buildEvidenceReviewResult([]);
    const html = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: result }));
    expect(html).toMatch(/no model responses were available/i);
  });

  it("never renders a generic research shell, Agreement Map, Panel Verdict, or claim matrix", () => {
    const result = buildEvidenceReviewResult(perModel([["chatgpt", fields({ overallAssessment: "x" })]]));
    const html = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: result }));
    expect(html).not.toMatch(/agreement map/i);
    expect(html).not.toMatch(/panel verdict/i);
    expect(html).not.toMatch(/claim matrix/i);
    expect(html).not.toMatch(/generic sections/i);
  });

  it("surfaces sourceBacked near the overall assessment in both directions — false is never silently omitted", () => {
    const sourced = buildEvidenceReviewResult(perModel([["chatgpt", fields({ overallAssessment: "x", sources: ["Journal of Medicine"] })]]));
    expect(renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: sourced }))).toContain("Source-backed assessment");

    const unsourced = buildEvidenceReviewResult(perModel([["chatgpt", fields({ overallAssessment: "x" })]]));
    expect(renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: unsourced }))).toContain("No source support captured");
  });

  it("phrases the source signal as evidence support, never a confidence/certainty percentage", () => {
    const result = buildEvidenceReviewResult(perModel([["chatgpt", fields({ overallAssessment: "x", sources: ["Journal"] })]]));
    const html = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: result }));
    expect(html).not.toMatch(/\d+%\s*(certain|confiden)/i);
  });

  it("distinguishes zero models attempted from models attempted but no usable review produced", () => {
    const noModels = buildEvidenceReviewResult([]);
    const htmlNoModels = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: noModels }));
    expect(htmlNoModels).toMatch(/no model responses were available/i);

    const noContent = { ...buildEvidenceReviewResult([]), totalModels: 2 };
    const htmlNoContent = renderToStaticMarkup(createElement(EvidenceReviewView, { evidenceReview: noContent }));
    expect(htmlNoContent).not.toMatch(/no model responses were available/i);
    expect(htmlNoContent).toMatch(/no evidence review could be produced/i);
  });
});
