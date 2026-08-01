/**
 * DefinitionExplanationView tests (Milestone 2). Renders the real component
 * (react-dom/server — no jsdom needed) against fixtures built with
 * buildDefinitionExplanationResult, matching the structural-check convention
 * used by RankedListView.spec.tsx/ComparisonMatrixView.spec.tsx.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DefinitionExplanationView from "@/components/adaptive/DefinitionExplanationView";
import { buildDefinitionExplanationResult, DefinitionExplanationFields } from "@/lib/adaptiveSchema/definitionAlignment";
import { ModelId } from "@/lib/types";

function fields(overrides: Partial<DefinitionExplanationFields> = {}): DefinitionExplanationFields {
  return {
    term: "none",
    directAnswer: "",
    explanation: "",
    keyPoints: [],
    example: "none",
    analogyText: "none",
    analogyLimits: "none",
    distinctions: [],
    processSteps: [],
    advancedDetail: "none",
    commonMisconceptions: [],
    relatedConcepts: [],
    sources: [],
    ...overrides,
  };
}

function perModel(entries: [string, DefinitionExplanationFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

describe("DefinitionExplanationView", () => {
  it("renders the direct answer first, then the explanation", () => {
    const result = buildDefinitionExplanationResult(
      perModel([["chatgpt", fields({ term: "CAGR", directAnswer: "CAGR is the smoothed annual growth rate.", explanation: "It is computed by..." })]]),
      1
    );
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).toContain("CAGR is the smoothed annual growth rate.");
    expect(html).toContain("It is computed by...");
    expect(html.indexOf("CAGR is the smoothed annual growth rate.")).toBeLessThan(html.indexOf("It is computed by..."));
  });

  it("shows the example and analogy with a limits callout", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        [
          "chatgpt",
          fields({
            directAnswer: "X is Y.",
            example: "A concrete example.",
            analogyText: "It's like a banking ledger.",
            analogyLimits: "Ledgers don't self-update, though.",
          }),
        ],
      ]),
      1
    );
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).toContain("A concrete example.");
    expect(html).toMatch(/like a banking ledger/);
    expect(html).toMatch(/analogy breaks down/i);
    expect(html).toMatch(/self-update, though/);
  });

  it("renders distinctions and process steps", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        [
          "chatgpt",
          fields({
            directAnswer: "X is Y.",
            distinctions: [{ concept: "precision", explanation: "Precision is about consistency, not correctness." }],
            processSteps: [
              { number: 1, title: "Key generation", explanation: "Generate a key pair." },
              { number: 2, title: "Encryption", explanation: "Encrypt with the public key." },
            ],
          }),
        ],
      ]),
      1
    );
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).toContain("precision");
    expect(html).toContain("Precision is about consistency, not correctness.");
    expect(html).toContain("Key generation");
    expect(html).toContain("Encryption");
    // Process steps render in order, not just present anywhere.
    expect(html.indexOf("Key generation")).toBeLessThan(html.indexOf("Encryption"));
  });

  it("shows common misconceptions", () => {
    const result = buildDefinitionExplanationResult(
      perModel([["chatgpt", fields({ directAnswer: "X is Y.", commonMisconceptions: ["We only use 10% of our brains."] })]]),
      1
    );
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).toContain("We only use 10% of our brains.");
  });

  it("renders advanced detail inside a collapsed section, not primary", () => {
    const result = buildDefinitionExplanationResult(
      perModel([["chatgpt", fields({ directAnswer: "X is Y.", advancedDetail: "The formal mathematical treatment involves..." })]]),
      1
    );
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).toContain("<details");
    expect(html).toContain("Advanced detail");
    expect(html).toContain("The formal mathematical treatment involves...");
  });

  it("shows related concepts and a coverage badge in the footer", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        ["chatgpt", fields({ directAnswer: "X is Y.", relatedConcepts: ["Net present value"] })],
        ["claude", fields({ directAnswer: "X is Y." })],
      ]),
      2
    );
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).toContain("Net present value");
    expect(html).toContain("2 of 2 models");
  });

  it("shows sources inside a collapsible footer section", () => {
    const result = buildDefinitionExplanationResult(
      perModel([["chatgpt", fields({ directAnswer: "X is Y.", sources: ["NIST glossary"] })]]),
      1
    );
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).toContain("<details");
    expect(html).toMatch(/Sources \(1\)/);
    expect(html).toContain("NIST glossary");
  });

  it("shows contributing models inside a collapsible section, not as primary content", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        ["chatgpt", fields({ directAnswer: "X is Y." })],
        ["claude", fields({ directAnswer: "X is Y." })],
      ]),
      2
    );
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).toMatch(/Contributing models \(2\)/);
    // The models list sits inside a <details>, not unconditionally visible.
    const detailsIndex = html.indexOf("Contributing models");
    expect(html.lastIndexOf("<details", detailsIndex)).toBeGreaterThan(-1);
  });

  it("shows the ambiguity banner and alternate interpretations when the panel disagrees materially", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        ["chatgpt", fields({ term: "model", directAnswer: "In machine learning, a model is a function trained on data." })],
        ["claude", fields({ term: "model", directAnswer: "A fashion model is a person who displays clothing commercially." })],
      ]),
      2
    );
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).toMatch(/more than one accepted meaning/i);
    expect(html).toContain("<details");
    expect(html).toMatch(/Other meanings the panel found/);
    expect(html).toContain("A fashion model is a person who displays clothing commercially.");
  });

  it("omits the ambiguity banner when the panel converges on one interpretation", () => {
    const result = buildDefinitionExplanationResult(
      perModel([
        ["chatgpt", fields({ directAnswer: "X is Y." })],
        ["claude", fields({ directAnswer: "X is Y." })],
      ]),
      2
    );
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).not.toMatch(/more than one accepted meaning/i);
  });

  it("handles a fully empty result (every model failed to parse) without crashing", () => {
    const result = buildDefinitionExplanationResult([], 2);
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).toMatch(/no definition could be produced/i);
  });

  it("distinguishes zero models attempted from models attempted but no usable definition produced", () => {
    const noModels = buildDefinitionExplanationResult([], 0);
    const htmlNoModels = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: noModels }));
    expect(htmlNoModels).toMatch(/no model responses were available/i);

    const noUsableOutput = buildDefinitionExplanationResult([], 2);
    const htmlNoUsableOutput = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: noUsableOutput }));
    expect(htmlNoUsableOutput).not.toMatch(/no model responses were available/i);
    expect(htmlNoUsableOutput).toMatch(/no definition could be produced/i);
  });

  it("never renders a Trust Summary, Agreement Map, Panel Verdict, or claim matrix", () => {
    const result = buildDefinitionExplanationResult(perModel([["chatgpt", fields({ directAnswer: "X is Y." })]]), 1);
    const html = renderToStaticMarkup(createElement(DefinitionExplanationView, { definitionExplanation: result }));
    expect(html).not.toMatch(/trust summary/i);
    expect(html).not.toMatch(/agreement map/i);
    expect(html).not.toMatch(/panel verdict/i);
    expect(html).not.toMatch(/claim matrix/i);
    expect(html).not.toMatch(/generic sections/i);
  });
});
