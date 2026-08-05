/**
 * Adaptive Synthesis Report, Phase 1 — TopSummaryBar structural render
 * tests. renderToStaticMarkup (no jsdom), matching the convention used by
 * every other adaptive renderer test in this repo.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TopSummaryBar from "@/components/adaptive/TopSummaryBar";
import { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function modelResult(modelId: string, ok: boolean): AdaptiveModelResult {
  return { modelId: modelId as ModelId, schemaId: "comparison_matrix", ok, data: ok ? {} : null };
}

describe("TopSummaryBar", () => {
  it("renders the report type, model count, and generated time", () => {
    const html = renderToStaticMarkup(
      createElement(TopSummaryBar, {
        schemaId: "comparison_matrix",
        results: [modelResult("chatgpt", true), modelResult("claude", true)],
        generatedAt: "2026-08-05T12:00:00.000Z",
      })
    );
    expect(html).toContain("Comparison Report");
    expect(html).toContain("2 of 2");
    expect(html).toMatch(/2026/);
  });

  it("shows a dash for Generated when no timestamp is available, rather than crashing or showing 'Invalid Date'", () => {
    const html = renderToStaticMarkup(
      createElement(TopSummaryBar, { schemaId: "comparison_matrix", results: [] })
    );
    expect(html).not.toMatch(/Invalid Date/i);
    expect(html).toContain("—");
  });

  it("renders 'Incomplete' status when no governance data is present at all", () => {
    const html = renderToStaticMarkup(
      createElement(TopSummaryBar, { schemaId: "comparison_matrix", results: [modelResult("chatgpt", true)] })
    );
    expect(html).toMatch(/Incomplete/);
  });

  it("renders 'Unreviewed — in queue' and 'Reviewed and approved' distinctly for the same schema", () => {
    const inQueue = renderToStaticMarkup(
      createElement(TopSummaryBar, {
        schemaId: "comparison_matrix",
        results: [modelResult("chatgpt", true)],
        humanReview: { status: "unreviewed" },
        reviewRouting: "in_queue",
      })
    );
    expect(inQueue).toMatch(/Unreviewed.*in queue/);

    const approved = renderToStaticMarkup(
      createElement(TopSummaryBar, {
        schemaId: "comparison_matrix",
        results: [modelResult("chatgpt", true)],
        humanReview: { status: "approved" },
      })
    );
    expect(approved).toMatch(/Reviewed and approved/);
    expect(approved).not.toMatch(/Unreviewed/);
  });

  it("prefixes 'Owner override' onto the underlying status when decidedVia is multi_reviewer_owner_override", () => {
    const html = renderToStaticMarkup(
      createElement(TopSummaryBar, {
        schemaId: "comparison_matrix",
        results: [modelResult("chatgpt", true)],
        humanReview: { status: "rejected", decidedVia: "multi_reviewer_owner_override" },
      })
    );
    expect(html).toMatch(/Owner override.*Rejected/);
  });

  it("shows 'Not scored' consensus/source-grounding rather than a fabricated number when no signal exists", () => {
    const html = renderToStaticMarkup(
      createElement(TopSummaryBar, { schemaId: "bias_blindspot_audit", results: [modelResult("chatgpt", true)] })
    );
    expect(html).toMatch(/Not scored/);
    expect(html).not.toMatch(/%\s*(certain|confiden)/i);
  });

  it("derives Consensus from the per-schema comparisonMatrix signal when provided", () => {
    const html = renderToStaticMarkup(
      createElement(TopSummaryBar, {
        schemaId: "comparison_matrix",
        results: [modelResult("chatgpt", true), modelResult("claude", true)],
        comparisonMatrix: {
          subjects: [],
          lowConfidenceSubjects: [],
          attributes: [],
          lowConfidenceAttributes: [],
          totalModels: 2,
          hasVerifiedSourceData: false,
          directConclusion: "",
          tradeoffs: [],
          bestUseRecommendations: [],
          uncertainties: [],
          cells: [
            {
              subjectId: "s",
              subject: "S",
              attributeId: "a",
              attribute: "A",
              valuesByModel: {} as any,
              coverageCount: 2,
              totalModels: 2,
              coverageRatio: 1,
              agreement: "consensus",
            },
          ],
        },
      })
    );
    expect(html).toMatch(/Strong consensus/);
  });

  it("falls back to the per-schema totalModels ('N models') when results is empty, as on history reload", () => {
    const html = renderToStaticMarkup(
      createElement(TopSummaryBar, {
        schemaId: "comparison_matrix",
        results: [],
        comparisonMatrix: {
          subjects: [],
          lowConfidenceSubjects: [],
          attributes: [],
          lowConfidenceAttributes: [],
          totalModels: 2,
          hasVerifiedSourceData: false,
          directConclusion: "",
          tradeoffs: [],
          bestUseRecommendations: [],
          uncertainties: [],
          cells: [],
        },
      })
    );
    expect(html).toContain("2 models");
    expect(html).not.toContain("0 of 0");
  });

  it("shows a dash for Models when results is empty and no per-schema result is available", () => {
    const html = renderToStaticMarkup(createElement(TopSummaryBar, { schemaId: "comparison_matrix", results: [] }));
    expect(html).not.toContain("0 of 0");
  });
});
