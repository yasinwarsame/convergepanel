/**
 * ChecklistTaxonomyView tests (Milestone 2). Renders the real component
 * (react-dom/server — no jsdom needed) against fixtures built with
 * buildChecklistTaxonomyResult, matching the structural-check convention
 * used by the other adaptive renderer tests.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChecklistTaxonomyView from "@/components/adaptive/ChecklistTaxonomyView";
import { buildChecklistTaxonomyResult, ChecklistTaxonomyFields } from "@/lib/adaptiveSchema/checklistAlignment";
import { ChecklistItem } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function item(overrides: Partial<ChecklistItem> & { id: string; label: string }): ChecklistItem {
  return { ...overrides };
}

function fields(overrides: Partial<ChecklistTaxonomyFields> = {}): ChecklistTaxonomyFields {
  return { summary: "", items: [], notes: [], ...overrides };
}

function perModel(entries: [string, ChecklistTaxonomyFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

describe("ChecklistTaxonomyView", () => {
  it("shows the summary at the top", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([["chatgpt", fields({ summary: "A checklist for launching a SaaS product.", items: [item({ id: "a", label: "X" })] })]])
    );
    const html = renderToStaticMarkup(createElement(ChecklistTaxonomyView, { checklistTaxonomy: result }));
    expect(html).toContain("A checklist for launching a SaaS product.");
  });

  it("renders a flat checklist (no category headings) when the panel never categorized items", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([["chatgpt", fields({ items: [item({ id: "a", label: "Insurance certificate" }), item({ id: "b", label: "Lease agreement" })] })]])
    );
    const html = renderToStaticMarkup(createElement(ChecklistTaxonomyView, { checklistTaxonomy: result }));
    expect(html).toContain("Insurance certificate");
    expect(html).toContain("Lease agreement");
    expect(html).not.toContain("General");
  });

  it("renders category headings when the panel provided a taxonomy", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        [
          "chatgpt",
          fields({
            items: [
              item({ id: "reactive", label: "Rule-based agents", category: "Reactive" }),
              item({ id: "adaptive", label: "Learning agents", category: "Adaptive" }),
            ],
          }),
        ],
      ])
    );
    const html = renderToStaticMarkup(createElement(ChecklistTaxonomyView, { checklistTaxonomy: result }));
    expect(html).toContain("Reactive");
    expect(html).toContain("Adaptive");
    expect(html).toContain("Rule-based agents");
    expect(html).toContain("Learning agents");
  });

  it("shows a critical badge only for majority-flagged critical items", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        ["chatgpt", fields({ items: [item({ id: "a", label: "Signed contract", critical: true })] })],
        ["claude", fields({ items: [item({ id: "a", label: "Signed contract", critical: true })] })],
      ])
    );
    const html = renderToStaticMarkup(createElement(ChecklistTaxonomyView, { checklistTaxonomy: result }));
    expect(html).toContain("Critical");
    expect(html).toContain("Signed contract");
  });

  it("shows a coverage badge", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        ["chatgpt", fields({ items: [item({ id: "a", label: "X" })] })],
        ["claude", fields({ items: [item({ id: "a", label: "X" })] })],
      ])
    );
    const html = renderToStaticMarkup(createElement(ChecklistTaxonomyView, { checklistTaxonomy: result }));
    expect(html).toContain("2 of 2 models");
  });

  it("shows notes as a callout", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([["chatgpt", fields({ notes: ["This list isn't exhaustive."], items: [item({ id: "a", label: "X" })] })]])
    );
    const html = renderToStaticMarkup(createElement(ChecklistTaxonomyView, { checklistTaxonomy: result }));
    expect(html).toMatch(/This list isn/);
    expect(html).toMatch(/exhaustive\./);
  });

  it("renders low-confidence items inside a collapsed section, separate from the main list", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        ["chatgpt", fields({ items: [item({ id: "popular", label: "Popular item" }), item({ id: "rare", label: "Rare item" })] })],
        ["claude", fields({ items: [item({ id: "popular", label: "Popular item" })] })],
        ["grok", fields({ items: [item({ id: "popular", label: "Popular item" })] })],
        ["perplexity", fields({ items: [item({ id: "popular", label: "Popular item" })] })],
      ])
    );
    const html = renderToStaticMarkup(createElement(ChecklistTaxonomyView, { checklistTaxonomy: result }));
    expect(html).toContain("<details");
    expect(html).toMatch(/Lower-confidence items.*1/);
    expect(html).toContain("Rare item");
    expect(html).toContain("Popular item");
  });

  it("handles a fully empty result without crashing", () => {
    const result = buildChecklistTaxonomyResult([]);
    const html = renderToStaticMarkup(createElement(ChecklistTaxonomyView, { checklistTaxonomy: result }));
    expect(html).toMatch(/no model responses were available/i);
  });

  it("distinguishes zero models attempted from models attempted but no checklist items produced", () => {
    const htmlNoModels = renderToStaticMarkup(
      createElement(ChecklistTaxonomyView, { checklistTaxonomy: buildChecklistTaxonomyResult([]) })
    );
    expect(htmlNoModels).toMatch(/no model responses were available/i);

    const noItems = buildChecklistTaxonomyResult(perModel([["chatgpt", fields()], ["claude", fields()]]));
    const htmlNoItems = renderToStaticMarkup(createElement(ChecklistTaxonomyView, { checklistTaxonomy: noItems }));
    expect(htmlNoItems).not.toMatch(/no model responses were available/i);
    expect(htmlNoItems).toMatch(/no checklist items were returned/i);
  });

  it("never renders a Trust Summary, Agreement Map, Panel Verdict, or claim matrix", () => {
    const result = buildChecklistTaxonomyResult(perModel([["chatgpt", fields({ items: [item({ id: "a", label: "X" })] })]]));
    const html = renderToStaticMarkup(createElement(ChecklistTaxonomyView, { checklistTaxonomy: result }));
    expect(html).not.toMatch(/trust summary/i);
    expect(html).not.toMatch(/agreement map/i);
    expect(html).not.toMatch(/panel verdict/i);
    expect(html).not.toMatch(/claim matrix/i);
  });
});
