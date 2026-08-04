/**
 * RankedListView tests (Milestone 2). Renders the real component
 * (react-dom/server — no jsdom needed) against fixtures built with
 * buildRankedEnumerationResult, matching the structural-check convention
 * used by the other adaptive renderer tests in this directory.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RankedListView from "@/components/adaptive/RankedListView";
import { buildRankedEnumerationResult } from "@/lib/adaptiveSchema/enumAlignment";
import { EnumItem } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function item(overrides: Partial<EnumItem> & { id: string; label: string; rank: number }): EnumItem {
  return { ...overrides };
}

function perModel(entries: [string, EnumItem[]][]) {
  return entries.map(([modelId, items]) => ({ modelId: modelId as ModelId, items }));
}

describe("RankedListView", () => {
  it("always shows the honesty banner about live query-log data", () => {
    const result = buildRankedEnumerationResult(perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 })]]]), null);
    const html = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: result }));
    expect(html).toMatch(/no model has live query-log data/i);
  });

  it("renders each item's label, coverage, category, and contributing model chips", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "chatgpt-tool", label: "ChatGPT", category: "General purpose", rank: 1, rationale: "Most widely used." })]],
        ["claude", [item({ id: "chatgpt", label: "ChatGPT", category: "General purpose", rank: 2 })]],
        ["grok", [item({ id: "chatgpt", label: "ChatGPT", category: "General purpose", rank: 1 })]],
        ["perplexity", [item({ id: "chatgpt", label: "ChatGPT", category: "General purpose", rank: 1 })]],
      ]),
      null
    );
    const html = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: result }));
    expect(html).toContain("ChatGPT");
    expect(html).toContain("General purpose");
    expect(html).toContain("4 of 4 models");
    expect(html).toContain("Most widely used.");
  });

  it("shows the shortfall note plainly when the panel falls short of the requested count, without padding", () => {
    const result = buildRankedEnumerationResult(
      perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 }), item({ id: "y", label: "Y", rank: 2 })]]]),
      20
    );
    const html = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: result }));
    expect(html).toMatch(/20/);
    expect(html).toMatch(/2 distinct items/);
  });

  it("omits the shortfall banner when no count was requested or the panel met it", () => {
    const result = buildRankedEnumerationResult(perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 })]]]), null);
    const html = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: result }));
    expect(html).not.toMatch(/you asked for/i);
  });

  it("renders low-confidence items (1-2 model coverage, panel > 2 models) inside a collapsed section, separate from the main list", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "popular", label: "Popular", rank: 1 }), item({ id: "rare", label: "Rare", rank: 5 })]],
        ["claude", [item({ id: "popular", label: "Popular", rank: 1 })]],
        ["grok", [item({ id: "popular", label: "Popular", rank: 1 })]],
        ["perplexity", [item({ id: "popular", label: "Popular", rank: 1 })]],
      ]),
      null
    );
    const html = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: result }));
    expect(html).toContain("<details");
    expect(html).toMatch(/Lower-confidence items.*1/);
    expect(html).toContain("Rare");
    expect(html).toContain("Popular");
  });

  it("shows the rank-agreement stat when a rank correlation was computed", () => {
    const result = buildRankedEnumerationResult(
      perModel([
        ["chatgpt", [item({ id: "a", label: "A", rank: 1 }), item({ id: "b", label: "B", rank: 2 })]],
        ["claude", [item({ id: "a", label: "A", rank: 1 }), item({ id: "b", label: "B", rank: 2 })]],
      ]),
      null
    );
    const html = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: result }));
    expect(html).toMatch(/Rank agreement across models: 1\.00/);
  });

  it("shows a collapsed Sources control only when an item actually has sources", () => {
    const withSources = buildRankedEnumerationResult(
      perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1, sources: ["Vendor site"] })]]]),
      null
    );
    const htmlWith = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: withSources }));
    expect(htmlWith).toMatch(/Sources \(1\)/);
    expect(htmlWith).toContain("Vendor site");

    const withoutSources = buildRankedEnumerationResult(perModel([["chatgpt", [item({ id: "y", label: "Y", rank: 1 })]]]), null);
    const htmlWithout = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: withoutSources }));
    expect(htmlWithout).not.toMatch(/Sources \(/);
  });

  it("badge wording matches the actual metric (mention coverage, never a certainty claim)", () => {
    const result = buildRankedEnumerationResult(perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 })]]]), null);
    const html = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: result }));
    expect(html).toContain("1 of 1 models covered this");
    expect(html).not.toMatch(/\d+%\s*(certain|confiden)/i);
  });

  it("never renders a claim matrix, Panel Verdict Card, or the generic research shell", () => {
    const result = buildRankedEnumerationResult(perModel([["chatgpt", [item({ id: "x", label: "X", rank: 1 })]]]), null);
    const html = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: result }));
    expect(html).not.toMatch(/claim matrix/i);
    expect(html).not.toMatch(/panel verdict/i);
    expect(html).not.toMatch(/generic sections/i);
  });

  it("distinguishes zero models attempted from models attempted but no items found", () => {
    const noModels = buildRankedEnumerationResult([], null);
    const htmlNoModels = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: noModels }));
    expect(htmlNoModels).toMatch(/no model responses were available/i);

    const noItems = { ...buildRankedEnumerationResult([], null), totalModels: 2 };
    const htmlNoItems = renderToStaticMarkup(createElement(RankedListView, { rankedEnumeration: noItems }));
    expect(htmlNoItems).not.toMatch(/no model responses were available/i);
    expect(htmlNoItems).toMatch(/no items were returned/i);
  });
});
