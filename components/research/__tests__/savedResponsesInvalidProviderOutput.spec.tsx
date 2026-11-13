/**
 * #308 × #312 merge (review finding 1): a reopened Milestone-2 report whose stored row is the no-API-key placeholder
 * (INVALID_MOCK, the J02 fact) must not be shown as the model's saved answer or counted as answered. It goes to the
 * failure note, which states INVALID_PROVIDER_OUTPUT_NOTICE.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ModelResponsesSection from "@/components/adaptive/ModelResponsesSection";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";
import { RunSlotStatusContext } from "@/components/adaptive/RunSlotStatusContext";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { SAVED_COPY_UNSTRUCTURED } from "@/lib/adaptiveSchema/savedCopyNotice";
import type { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";
import { INVALID_PROVIDER_OUTPUT_NOTICE, withPlaceholderFact } from "@/lib/panel/executionIdentity";
import { runModelProvenanceFromResultRow } from "@/lib/panel/runModelIdentity";
import {
  invalidProviderOutputSlots,
  modelResponsesCountLines,
  partitionModelResponses,
  summarizeModelResponses,
} from "@/lib/research/modelResponsesPresentation";

const MOCK = "Mock response from chatgpt (no API key configured)";
const schema = getResultSchema("comparison_matrix" as never);

type Row = { modelId: string; status: string; rawText: string };

function render(rows: Row[], results: AdaptiveModelResult[]) {
  return renderToStaticMarkup(
    createElement(
      RunModelProvenanceContext.Provider,
      { value: rows.map((r) => withPlaceholderFact(runModelProvenanceFromResultRow(r as never), r as never)) },
      createElement(
        RunSlotStatusContext.Provider,
        { value: new Map(rows.map((r) => [r.modelId, r.status])) },
        createElement(ModelResponsesSection, { schema, results })
      )
    )
  );
}

const savedText = (modelId: string, text: string) =>
  ({ modelId, schemaId: schema.id, ok: false, data: null, parseError: SAVED_COPY_UNSTRUCTURED, savedResponseText: text }) as AdaptiveModelResult;
const structured = (modelId: string) =>
  ({ modelId, schemaId: schema.id, ok: true, data: { cells: [], directConclusion: "Conclusion text" } }) as unknown as AdaptiveModelResult;

describe("stored no-API-key placeholder in a reopened Milestone-2 report", () => {
  it("states the J02 notice, shows no saved-text card for that slot, and does not count it as answered", () => {
    const rows = [
      { modelId: "chatgpt", status: "ok", rawText: MOCK },
      { modelId: "claude", status: "ok", rawText: "real answer" },
    ];
    const html = render(rows, [savedText("chatgpt", MOCK), structured("claude")]);
    expect(html).toContain(INVALID_PROVIDER_OUTPUT_NOTICE);
    expect(html).toContain('data-testid="invalid-provider-output"');
    expect(html).not.toContain('data-testid="saved-text-plain"');
    expect(html).not.toContain(MOCK);
    expect(html).toContain("2 models requested · 1 answered · 1 not a model response (no API key configured)");
    expect(html).not.toContain("shown as saved text");
  });

  it("control: a genuine saved answer is still shown as saved text and counted as answered", () => {
    const rows = [
      { modelId: "chatgpt", status: "ok", rawText: "A genuine first answer." },
      { modelId: "claude", status: "ok", rawText: "real answer" },
    ];
    const html = render(rows, [savedText("chatgpt", "A genuine first answer."), structured("claude")]);
    expect(html).not.toContain(INVALID_PROVIDER_OUTPUT_NOTICE);
    expect(html).toContain('data-testid="saved-text-plain"');
    expect(html).toContain("2 models requested · 2 answered");
    expect(html).toContain("1 shown as saved text");
  });

  it("control: text that only mentions a mock response is not the placeholder (no J02 fact) and stays an answer", () => {
    const text = "This is not a mock response, it explains mock response testing.";
    const rows = [
      { modelId: "chatgpt", status: "ok", rawText: text },
      { modelId: "claude", status: "ok", rawText: "real answer" },
    ];
    const html = render(rows, [savedText("chatgpt", text), structured("claude")]);
    expect(html).not.toContain(INVALID_PROVIDER_OUTPUT_NOTICE);
    expect(html).toContain('data-testid="saved-text-plain"');
    expect(html).toContain("2 answered");
  });
});

describe("helpers", () => {
  const results = [savedText("chatgpt", MOCK), structured("claude")];
  const statuses = new Map([["chatgpt", "ok"], ["claude", "ok"]]);

  it("invalidProviderOutputSlots reads only invalidProviderOutput === true", () => {
    expect([...invalidProviderOutputSlots([{ modelId: "chatgpt", invalidProviderOutput: true }, { modelId: "claude", invalidProviderOutput: "true" }, null])]).toEqual(["chatgpt"]);
    expect(invalidProviderOutputSlots(null).size).toBe(0);
  });

  it("partition routes the placeholder slot to notes and leaves the rest unchanged", () => {
    const withFact = partitionModelResponses(results, statuses, new Set(["chatgpt"]));
    expect(withFact.cards.map((r) => r.modelId)).toEqual(["claude"]);
    expect(withFact.notes.map((r) => r.modelId)).toEqual(["chatgpt"]);
    const without = partitionModelResponses(results, statuses);
    expect(without.cards.map((r) => r.modelId)).toEqual(["chatgpt", "claude"]);
  });

  it("summary counts the placeholder slot once, as not a model response", () => {
    const s = summarizeModelResponses(results, statuses, new Set(["chatgpt"]));
    expect(s).toMatchObject({ requested: 2, answered: 1, notAModelResponse: 1, didNotRespond: 0, savedTextShown: 0, structuredShown: 1 });
    expect(modelResponsesCountLines(s)[0]).toBe("2 models requested · 1 answered · 1 not a model response (no API key configured)");
    expect(summarizeModelResponses(results, statuses)).toMatchObject({ answered: 2, notAModelResponse: 0, savedTextShown: 1 });
  });
});
