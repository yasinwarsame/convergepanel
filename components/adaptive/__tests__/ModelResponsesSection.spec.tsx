/**
 * Adaptive Synthesis Report, Phase 2 (3-schema pilot) — ModelResponsesSection
 * structural tests. renderToStaticMarkup (no jsdom), matching the convention
 * used by every other adaptive renderer test in this repo.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ModelResponsesSection from "@/components/adaptive/ModelResponsesSection";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

const schema = SCHEMA_REGISTRY.comparison_matrix;

function modelResult(modelId: string, data: Record<string, unknown> | null, ok = true): AdaptiveModelResult {
  return { modelId: modelId as ModelId, schemaId: "comparison_matrix", ok, data: data as any };
}

describe("ModelResponsesSection", () => {
  it("is collapsed by default (a <details> element, not open)", () => {
    const html = renderToStaticMarkup(
      createElement(ModelResponsesSection, {
        schema,
        results: [modelResult("chatgpt", { directConclusion: "ChatGPT wins on depth." })],
      })
    );
    expect(html).toMatch(/<details/);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it("renders string fields as paragraphs and string[] fields as bullet lists without crashing", () => {
    const html = renderToStaticMarkup(
      createElement(ModelResponsesSection, {
        schema,
        results: [
          modelResult("chatgpt", {
            directConclusion: "ChatGPT wins on depth.",
            tradeoffs: ["Depth vs. speed"],
            bestUseRecommendations: ["Use ChatGPT for long-form research"],
            uncertainties: ["Pricing may have changed"],
            cells: [],
          }),
        ],
      })
    );
    expect(html).toMatch(/ChatGPT wins on depth/);
    expect(html).toMatch(/Depth vs. speed/);
    expect(html).toMatch(/Use ChatGPT for long-form research/);
  });

  it("renders comparisonCell[] fields as subject/attribute/value rows", () => {
    const html = renderToStaticMarkup(
      createElement(ModelResponsesSection, {
        schema,
        results: [
          modelResult("chatgpt", {
            cells: [{ subject: "ChatGPT", attribute: "Citations", value: "Weak", verdict: "worse" }],
          }),
        ],
      })
    );
    expect(html).toMatch(/ChatGPT/);
    expect(html).toMatch(/Citations/);
    expect(html).toMatch(/Weak/);
  });

  it("routes failed/parse-error models through FailedResultsNote, not silently", () => {
    const html = renderToStaticMarkup(
      createElement(ModelResponsesSection, {
        schema,
        results: [
          modelResult("chatgpt", { directConclusion: "ok" }),
          { modelId: "claude" as ModelId, schemaId: "comparison_matrix", ok: false, data: null, parseError: "malformed JSON" },
        ],
      })
    );
    expect(html).toMatch(/returned an incompatible format and was excluded/i);
  });

  it("renders nothing (not a crash) when there are no results at all", () => {
    const html = renderToStaticMarkup(createElement(ModelResponsesSection, { schema, results: [] }));
    expect(html).toBe("");
  });
});
