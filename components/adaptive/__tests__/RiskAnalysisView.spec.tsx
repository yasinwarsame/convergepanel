/**
 * RiskAnalysisView tests — the risk-register presentation of a risk-shaped
 * checklist_taxonomy result (see checklistAlignment.ts's per-item risk
 * fields and types.ts's isRiskShapedChecklistResult). Renders the real
 * component (react-dom/server — no jsdom needed), matching the convention
 * used by ChecklistTaxonomyView.spec.tsx/ComparisonMatrixView.spec.tsx.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RiskAnalysisView from "@/components/adaptive/RiskAnalysisView";
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

describe("RiskAnalysisView", () => {
  it("renders the executive risk conclusion, risk register heading, and per-risk severity/likelihood badges", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        [
          "chatgpt",
          fields({
            summary: "AI-generated market research carries several risks worth managing.",
            items: [
              item({
                id: "hallucination",
                label: "Hallucinated data presented as fact",
                category: "Data quality",
                severity: "high",
                likelihood: "medium",
                impact: "Decisions get made on numbers that were never real.",
                evidence: "Models occasionally fabricate plausible-looking statistics.",
                mitigation: "Cross-check every figure against a primary source.",
                monitoringSignal: "Numbers that cannot be traced to a cited source.",
                residualRisk: "Low, once every figure is source-checked.",
              }),
            ],
          }),
        ],
      ])
    );

    const html = renderToStaticMarkup(createElement(RiskAnalysisView, { checklistTaxonomy: result }));

    expect(html).toMatch(/executive risk conclusion/i);
    expect(html).toContain("AI-generated market research carries several risks worth managing.");
    expect(html).toMatch(/risk register/i);
    expect(html).toContain("Hallucinated data presented as fact");
    expect(html).toMatch(/high severity/i);
    expect(html).toMatch(/medium likelihood/i);
    expect(html).toContain("Decisions get made on numbers that were never real.");
    expect(html).toContain("Cross-check every figure against a primary source.");
    expect(html).toContain("Numbers that cannot be traced to a cited source.");
    expect(html).toContain("Low, once every figure is source-checked.");
  });

  it("shows a consensus/disagreement coverage badge per risk, never a bare certainty percentage", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        ["chatgpt", fields({ items: [item({ id: "outage", label: "Provider outage", severity: "high", likelihood: "low" })] })],
        ["claude", fields({ items: [item({ id: "outage", label: "Provider outage", severity: "high", likelihood: "low" })] })],
      ])
    );
    const html = renderToStaticMarkup(createElement(RiskAnalysisView, { checklistTaxonomy: result }));
    expect(html).toContain("2 of 2 models covered this");
    expect(html).not.toMatch(/\d+%\s*(certain|confiden)/i);
  });

  it("never renders the legacy List/Compare/Synthesis shell, Trust Summary, or Verification Gate", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([["chatgpt", fields({ items: [item({ id: "outage", label: "Provider outage", severity: "high" })] })]])
    );
    const html = renderToStaticMarkup(createElement(RiskAnalysisView, { checklistTaxonomy: result }));
    expect(html).not.toMatch(/unified answer/i);
    expect(html).not.toMatch(/trust summary/i);
    expect(html).not.toMatch(/verification gate/i);
    expect(html).not.toMatch(/list view|compare view|synthesis report/i);
  });

  it("shows unknowns from the schema's notes field", () => {
    const result = buildChecklistTaxonomyResult(
      perModel([
        [
          "chatgpt",
          fields({
            items: [item({ id: "outage", label: "Provider outage", severity: "medium" })],
            notes: ["This risk register is not exhaustive — jurisdiction-specific risks are not covered."],
          }),
        ],
      ])
    );
    const html = renderToStaticMarkup(createElement(RiskAnalysisView, { checklistTaxonomy: result }));
    expect(html).toMatch(/unknowns/i);
    expect(html).toContain("This risk register is not exhaustive — jurisdiction-specific risks are not covered.");
  });

  it("handles a run with no models without crashing", () => {
    const result = buildChecklistTaxonomyResult([]);
    const html = renderToStaticMarkup(createElement(RiskAnalysisView, { checklistTaxonomy: result }));
    expect(html).toMatch(/no model responses were available/i);
  });
});
