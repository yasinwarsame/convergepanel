/**
 * ComparisonMatrixView tests (Milestone 2). Renders the real component
 * (react-dom/server — no jsdom needed) against fixtures built with
 * buildComparisonMatrixResult, matching the structural-check convention
 * used by RankedListView.spec.tsx and the other adaptive renderer tests.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ComparisonMatrixView from "@/components/adaptive/ComparisonMatrixView";
import { buildComparisonMatrixResult } from "@/lib/adaptiveSchema/comparisonAlignment";
import { ComparisonCell } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function cell(overrides: Partial<ComparisonCell> & Pick<ComparisonCell, "subject" | "attribute" | "value">): ComparisonCell {
  return { ...overrides };
}

function perModel(entries: [string, ComparisonCell[]][]) {
  return entries.map(([modelId, cells]) => ({ modelId: modelId as ModelId, cells }));
}

describe("ComparisonMatrixView", () => {
  it("always shows the honesty banner about model-generated (not verified) data", () => {
    const result = buildComparisonMatrixResult(perModel([["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" })]]]));
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).toMatch(/not live verified pricing/i);
  });

  it("renders subject labels as column headers and attribute labels as row headers", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "iPhone 15", attribute: "Price", value: "$799" }), cell({ subject: "Galaxy S24", attribute: "Price", value: "$799" })]],
      ])
    );
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).toContain("iPhone 15");
    expect(html).toContain("Galaxy S24");
    expect(html).toContain("Price");
  });

  it("shows a consensus cell's value plainly with a coverage badge", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$799" })]],
        ["claude", [cell({ subject: "X", attribute: "Price", value: "$799" })]],
      ])
    );
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).toContain("$799");
    expect(html).toContain("2 of 2 models agreed");
  });

  it("shows each model's own value plus a disagreement indicator for a split cell", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Verdict", value: "Best overall choice" })]],
        ["claude", [cell({ subject: "X", attribute: "Verdict", value: "Not recommended at all" })]],
      ])
    );
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).toContain("Best overall choice");
    expect(html).toContain("Not recommended at all");
    expect(html).toMatch(/models disagree/i);
  });

  it("shows a dash placeholder for a subject×attribute combination nobody populated, never fabricating a value", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" })]],
        ["claude", [cell({ subject: "Y", attribute: "Weight", value: "1kg" })]],
      ])
    );
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).toContain("—");
  });

  it("shows verdict tallies when present", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1", verdict: "better" })]],
        ["claude", [cell({ subject: "X", attribute: "Price", value: "$1", verdict: "better" })]],
      ])
    );
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).toMatch(/better \(2\)/);
  });

  it("renders low-confidence subjects/attributes inside collapsed sections, separate from the main grid", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "Popular", attribute: "Price", value: "$1" }), cell({ subject: "Rare", attribute: "Price", value: "$2" })]],
        ["claude", [cell({ subject: "Popular", attribute: "Price", value: "$1" })]],
        ["grok", [cell({ subject: "Popular", attribute: "Price", value: "$1" })]],
        ["perplexity", [cell({ subject: "Popular", attribute: "Price", value: "$1" })]],
      ])
    );
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).toContain("<details");
    expect(html).toMatch(/Lower-confidence subjects.*1/);
    expect(html).toContain("Rare");
    expect(html).toContain("Popular");
  });

  it("shows a collapsed Sources control on a cell only when it actually has sources, never on a purely judgmental cell without them", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1", sources: ["Vendor site"] }), cell({ subject: "X", attribute: "Verdict", value: "Solid choice" })]],
      ])
    );
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).toMatch(/Sources \(1\)/);
    expect(html).toContain("Vendor site");
  });

  it("badge wording matches the actual metric — 'agreed' only for genuine consensus/majority, 'assessed' for single-source cells", () => {
    const consensus = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" })]],
        ["claude", [cell({ subject: "X", attribute: "Price", value: "$1" })]],
      ])
    );
    expect(renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: consensus }))).toContain("2 of 2 models agreed");

    const singleSource = buildComparisonMatrixResult(perModel([["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" })]]]));
    expect(renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: singleSource }))).toContain("1 of 1 models assessed this");
  });

  it("never implies certainty through the coverage/agreement badges", () => {
    const result = buildComparisonMatrixResult(
      perModel([
        ["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" })]],
        ["claude", [cell({ subject: "X", attribute: "Price", value: "$1" })]],
      ])
    );
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).not.toMatch(/\d+%\s*(certain|confiden)/i);
  });

  it("never renders a claim matrix, Panel Verdict Card, or the generic research shell", () => {
    const result = buildComparisonMatrixResult(perModel([["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" })]]]));
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).not.toMatch(/claim matrix/i);
    expect(html).not.toMatch(/panel verdict/i);
    expect(html).not.toMatch(/generic sections/i);
  });

  it("distinguishes zero models attempted from models attempted but nothing comparable found", () => {
    const noModels = buildComparisonMatrixResult([]);
    const htmlNoModels = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: noModels }));
    expect(htmlNoModels).toMatch(/no model responses were available/i);

    const noCells = { ...buildComparisonMatrixResult([]), totalModels: 2 };
    const htmlNoCells = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: noCells }));
    expect(htmlNoCells).not.toMatch(/no model responses were available/i);
    expect(htmlNoCells).toMatch(/no comparable subjects/i);
  });

  it("handles a fully empty result without crashing", () => {
    const result = buildComparisonMatrixResult([]);
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).toMatch(/no model responses were available/i);
  });

  it("renders the direct conclusion, trade-offs, best-use recommendations, and uncertainties as their own sections", () => {
    const result = buildComparisonMatrixResult([
      {
        modelId: "chatgpt" as ModelId,
        cells: [cell({ subject: "ChatGPT", attribute: "Citations", value: "Weak" })],
        directConclusion: "Perplexity leads for citation-backed research; ChatGPT leads for depth.",
        tradeoffs: ["Cheaper options tend to have weaker source citations."],
        bestUseRecommendations: ["Perplexity — best when citations matter most."],
        uncertainties: ["Pricing changes frequently and was not independently verified."],
      },
    ]);
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).toMatch(/direct conclusion/i);
    expect(html).toContain("Perplexity leads for citation-backed research; ChatGPT leads for depth.");
    expect(html).toMatch(/trade-offs/i);
    expect(html).toContain("Cheaper options tend to have weaker source citations.");
    expect(html).toMatch(/best-use recommendations/i);
    expect(html).toContain("Perplexity — best when citations matter most.");
    expect(html).toMatch(/uncertainties/i);
    expect(html).toContain("Pricing changes frequently and was not independently verified.");
  });

  it("omits the narrative sections entirely when no model supplied them", () => {
    const result = buildComparisonMatrixResult(perModel([["chatgpt", [cell({ subject: "X", attribute: "Price", value: "$1" })]]]));
    const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
    expect(html).not.toMatch(/direct conclusion/i);
    expect(html).not.toMatch(/trade-offs/i);
    expect(html).not.toMatch(/best-use recommendations/i);
  });
});
