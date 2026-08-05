/**
 * AdaptivePanelResponse renderer-selection tests.
 *
 * Covers the root cause found while auditing why comparison/risk-shaped
 * adaptive runs were rendering through the legacy List/Compare/Synthesis
 * shell: the classifier was silently falling back to "generic" for nearly
 * every query (a Gemini "thinking" token-budget bug fixed in classifier.ts/
 * gemini.ts), so real Milestone-2 schemas like comparison_matrix and
 * checklist_taxonomy were never actually reached at the renderer layer even
 * though their dedicated views already existed. These tests pin the
 * renderer-selection contract directly (given a correct classification,
 * the right view renders) independent of the classifier itself.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { buildComparisonMatrixResult } from "@/lib/adaptiveSchema/comparisonAlignment";
import { buildChecklistTaxonomyResult, ChecklistTaxonomyFields } from "@/lib/adaptiveSchema/checklistAlignment";
import { AdaptiveModelResult, ChecklistItem, ComparisonCell, QueryClassification, QueryType } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function baseClassification(queryType: QueryType, overrides: Partial<QueryClassification> = {}): QueryClassification {
  return {
    queryType,
    domain: "test",
    answerShape: SCHEMA_REGISTRY[queryType].renderHint,
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence: 0.9,
    riskLevel: "professional",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: null,
    requiresClarification: false,
    rationale: "test fixture",
    ...overrides,
  };
}

function modelResult(modelId: string, schemaId: QueryType, data: Record<string, unknown>): AdaptiveModelResult {
  return { modelId: modelId as ModelId, schemaId, ok: true, data: data as any };
}

function checklistItem(overrides: Partial<ChecklistItem> & { id: string; label: string }): ChecklistItem {
  return { ...overrides };
}

function comparisonCell(overrides: Partial<ComparisonCell> & Pick<ComparisonCell, "subject" | "attribute" | "value">): ComparisonCell {
  return { ...overrides };
}

describe("AdaptivePanelResponse — comparison_matrix routes to ComparisonMatrixView", () => {
  it("renders the comparison grid directly, bypassing List/Compare/Synthesis and Trust Summary/Verification Gate entirely", () => {
    const schema = SCHEMA_REGISTRY.comparison_matrix;
    const classification = baseClassification("comparison_matrix");
    const results = [modelResult("chatgpt", "comparison_matrix", { cells: [] })];
    const comparisonMatrix = buildComparisonMatrixResult([
      {
        modelId: "chatgpt" as ModelId,
        cells: [comparisonCell({ subject: "ChatGPT", attribute: "Citations", value: "Weak" })],
        directConclusion: "ChatGPT and Perplexity lead for different reasons.",
      },
    ]);

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        comparisonMatrix,
        question: "Compare ChatGPT, Claude, Gemini, Perplexity, and Grok for professional research.",
      })
    );

    expect(html).toMatch(/direct conclusion/i);
    expect(html).not.toMatch(/unified answer/i);
    expect(html).not.toMatch(/trust summary/i);
    expect(html).not.toMatch(/verification gate/i);
    expect(html).not.toMatch(/agreement.*disagreement map/i);
  });
});

describe("AdaptivePanelResponse — risk-shaped checklist_taxonomy routes to RiskAnalysisView", () => {
  const schema = SCHEMA_REGISTRY.checklist_taxonomy;
  const classification = baseClassification("checklist_taxonomy");

  it("renders the risk register when items carry risk fields, distinct from the plain checklist heading", () => {
    const fields: ChecklistTaxonomyFields = {
      summary: "AI-generated market research carries several risks worth managing.",
      items: [
        checklistItem({
          id: "hallucination",
          label: "Hallucinated data",
          category: "Data quality",
          severity: "high",
          likelihood: "medium",
          mitigation: "Cross-check figures against a primary source before use.",
        }),
      ],
      notes: [],
    };
    const checklistTaxonomy = buildChecklistTaxonomyResult([{ modelId: "chatgpt" as ModelId, fields }]);
    const results = [modelResult("chatgpt", "checklist_taxonomy", fields as any)];

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        checklistTaxonomy,
        question: "What are the main risks of relying on AI-generated market research?",
      })
    );

    expect(html).toMatch(/executive risk conclusion/i);
    expect(html).toMatch(/risk register/i);
    expect(html).toMatch(/high severity/i);
    expect(html).not.toMatch(/unified answer/i);
    expect(html).not.toMatch(/trust summary/i);
    expect(html).not.toMatch(/verification gate/i);
  });

  it("renders the plain checklist, not the risk register, when no item carries a risk field", () => {
    const fields: ChecklistTaxonomyFields = {
      summary: "Checklist for launching a SaaS product.",
      items: [checklistItem({ id: "dpa", label: "Sign a data processing agreement", category: "Legal" })],
      notes: [],
    };
    const checklistTaxonomy = buildChecklistTaxonomyResult([{ modelId: "chatgpt" as ModelId, fields }]);
    const results = [modelResult("chatgpt", "checklist_taxonomy", fields as any)];

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        checklistTaxonomy,
        question: "What should I check before launching a SaaS product?",
      })
    );

    expect(html).not.toMatch(/executive risk conclusion/i);
    expect(html).not.toMatch(/risk register/i);
  });
});

describe("AdaptivePanelResponse — legacy/original-9 schemas keep the List/Compare/Synthesis shell", () => {
  it("still renders the tabbed List/Compare/Synthesis shell for a generic-schema run with verification data", () => {
    const schema = SCHEMA_REGISTRY.generic;
    const classification = baseClassification("generic");
    const results = [modelResult("chatgpt", "generic", { summary: "Some answer" })];

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification,
        results,
        gate: { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, caveat: undefined } as any,
        synthesisReport: {
          executiveSummary: "Summary",
          runCertainty: 0.8,
          whereModelsAgree: [],
          keyDisagreement: undefined,
          confidenceBreakdown: [],
          uncertainties: [],
          followUpQuestions: [],
        } as any,
        question: "A generic question",
      })
    );

    expect(html).toMatch(/list|compare|synthesis/i);
  });
});
