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

  describe("mobile-accessible comparison table (contained horizontal scroll + sticky criteria column)", () => {
    function fiveOptionResult() {
      const subjects = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
      return buildComparisonMatrixResult(
        perModel([
          ["chatgpt", subjects.map((s) => cell({ subject: s, attribute: "Price", value: `${s} price` }))],
        ])
      );
    }

    it("keeps the scroll region contained: overflow-x-auto on the table's own wrapper, not a page-level class", () => {
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: fiveOptionResult() }));
      expect(html).toMatch(/class="[^"]*overflow-x-auto[^"]*"[^>]*>\s*<table/);
    });

    it("gives the scroll region an accessible label and role, independent of any table caption", () => {
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: fiveOptionResult() }));
      expect(html).toMatch(/role="region"/);
      expect(html).toMatch(/aria-label="Comparison table, scroll horizontally to see all options"/);
    });

    it("makes the scroll region keyboard-reachable via a positive-order tabIndex on the scrollable container", () => {
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: fiveOptionResult() }));
      expect(html).toMatch(/role="region"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/);
    });

    it("keeps a visible focus indicator on the scroll region rather than suppressing outline entirely", () => {
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: fiveOptionResult() }));
      expect(html).toMatch(/focus-visible:ring/);
    });

    it("marks subject headers scope=col and the criteria header scope=row, so header/value association survives horizontal scroll for assistive tech", () => {
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: fiveOptionResult() }));
      expect(html).toMatch(/<th scope="col"/);
      expect(html).toMatch(/<th scope="row"/);
    });

    it("pins the criteria (first) column with sticky positioning so it stays readable while scrolling through options", () => {
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: fiveOptionResult() }));
      expect(html).toMatch(/scope="row"[^>]*class="[^"]*sticky[^"]*left-0/);
    });

    it("keeps every subject column in the rendered DOM regardless of count — nothing is dropped for a 5-option comparison", () => {
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: fiveOptionResult() }));
      for (const label of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) {
        expect(html).toContain(label);
      }
    });

    it("shows a narrow-viewport scroll hint that's hidden at desktop widths (md:hidden), not a permanent desktop element", () => {
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: fiveOptionResult() }));
      expect(html).toMatch(/md:hidden/);
      expect(html).toMatch(/Scroll to see all options/);
    });

    it("wraps a very long option name instead of forcing unbounded column width", () => {
      const longName = "The Extremely Long Hypothetical Product Name That Keeps Going And Going";
      const result = buildComparisonMatrixResult(
        perModel([["chatgpt", [cell({ subject: longName, attribute: "Price", value: "$1" })]]])
      );
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
      expect(html).toContain(longName);
      expect(html).toMatch(/whitespace-normal break-words/);
    });

    it("wraps very long cell content safely rather than relying on nowrap", () => {
      const longValue =
        "This is an unusually long cell value describing many nuanced tradeoffs in detail so it will definitely need to wrap across multiple lines on any reasonably narrow column width.";
      const result = buildComparisonMatrixResult(
        perModel([["chatgpt", [cell({ subject: "X", attribute: "Notes", value: longValue })]]])
      );
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
      expect(html).toContain(longValue);
    });

    it("keeps disagreement badges visible (text-based, not color-only) alongside per-model values in a split cell", () => {
      const result = buildComparisonMatrixResult(
        perModel([
          ["chatgpt", [cell({ subject: "X", attribute: "Verdict", value: "Best overall choice" })]],
          ["claude", [cell({ subject: "X", attribute: "Verdict", value: "Not recommended at all" })]],
        ])
      );
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
      expect(html).toMatch(/models disagree/i);
      expect(html).toContain("Best overall choice");
      expect(html).toContain("Not recommended at all");
    });

    it("does not gain any page-level (non-contained) overflow class — the only overflow-x-auto is on the table wrapper", () => {
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: fiveOptionResult() }));
      const matches = html.match(/overflow-x-auto/g) || [];
      expect(matches.length).toBe(1);
    });

    it("preserves desktop table structure: a real <table> with <thead>/<tbody>, not stacked cards", () => {
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: fiveOptionResult() }));
      expect(html).toMatch(/<table[^>]*class="[^"]*w-full[^"]*"/);
      expect(html).toContain("<thead>");
      expect(html).toContain("<tbody>");
    });

    it("still fails safely (no crash, no scroll-region markup) for empty comparison data", () => {
      const result = buildComparisonMatrixResult([]);
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
      expect(html).toMatch(/no model responses were available/i);
      expect(html).not.toMatch(/role="region"/);
    });

    it("still fails safely for partial comparison data (models responded, nothing comparable)", () => {
      const result = { ...buildComparisonMatrixResult([]), totalModels: 2 };
      const html = renderToStaticMarkup(createElement(ComparisonMatrixView, { comparisonMatrix: result }));
      expect(html).toMatch(/no comparable subjects/i);
      expect(html).not.toMatch(/role="region"/);
    });
  });
});
