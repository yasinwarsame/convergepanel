/**
 * Milestone 2 UI consistency cleanup — dedicated unit tests for the shared
 * formatModelCoverage/classifyRendererEmptyState/EmptyStateCard helpers
 * (components/adaptive/shared.tsx), since all 9 adaptive renderers now
 * depend on them for consistent badge wording and empty-state semantics.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { classifyRendererEmptyState, EmptyStateCard, formatModelCoverage } from "@/components/adaptive/shared";

describe("formatModelCoverage", () => {
  it("phrases 'covered' mode as mention coverage, not agreement", () => {
    expect(formatModelCoverage({ covered: 2, total: 3, mode: "covered" })).toBe("2 of 3 models covered this");
  });

  it("phrases 'agreed' mode as genuine agreement — reserved for schemas with a real value-agreement signal", () => {
    expect(formatModelCoverage({ covered: 2, total: 2, mode: "agreed" })).toBe("2 of 2 models agreed");
  });

  it("phrases 'assessed' mode for cross-referenced cells (comparison_matrix cells, decision_support assessments)", () => {
    expect(formatModelCoverage({ covered: 1, total: 1, mode: "assessed" })).toBe("1 of 1 models assessed this");
  });

  it("phrases 'converged' mode for recommendation-level convergence (decision_support)", () => {
    expect(formatModelCoverage({ covered: 2, total: 3, mode: "converged" })).toBe("2 of 3 models converged on this");
  });
});

describe("classifyRendererEmptyState", () => {
  it("returns 'no_models' when totalModels is 0, regardless of hasContent", () => {
    expect(classifyRendererEmptyState(0, true)).toBe("no_models");
    expect(classifyRendererEmptyState(0, false)).toBe("no_models");
  });

  it("returns 'models_no_usable_output' when models ran but produced no usable content", () => {
    expect(classifyRendererEmptyState(2, false)).toBe("models_no_usable_output");
  });

  it("returns 'has_content' when models ran and produced usable content", () => {
    expect(classifyRendererEmptyState(2, true)).toBe("has_content");
  });
});

describe("EmptyStateCard", () => {
  it("renders the fixed generic copy for 'no_models', ignoring any schemaSpecificMessage", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyStateCard, { state: "no_models", schemaSpecificMessage: "A schema-specific message that must not appear" })
    );
    expect(html).toContain("No model responses were available for this run.");
    expect(html).not.toContain("A schema-specific message that must not appear");
  });

  it("prefers a schema-specific message for 'models_no_usable_output' when one is given", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyStateCard, { state: "models_no_usable_output", schemaSpecificMessage: "No widgets could be produced." })
    );
    expect(html).toContain("No widgets could be produced.");
  });

  it("falls back to a generic message for 'models_no_usable_output' when no schema-specific message is given", () => {
    const html = renderToStaticMarkup(createElement(EmptyStateCard, { state: "models_no_usable_output" }));
    expect(html).toContain("Models responded, but no usable structured result could be produced.");
  });
});
