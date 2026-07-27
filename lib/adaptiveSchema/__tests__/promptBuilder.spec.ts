/**
 * Prompt Builder Tests
 *
 * Snapshot each of the 9 schemas' generated prompt so future edits to
 * schemaRegistry.ts / promptBuilder.ts show up as an intentional diff, plus
 * a few targeted assertions on the contract (no extra fields leak in, caps
 * are present, context is integrated when supplied).
 */

import { buildModelPrompt } from "@/lib/adaptiveSchema/promptBuilder";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { QueryClassification, QueryType } from "@/lib/adaptiveSchema/types";

function classificationFor(queryType: QueryType): QueryClassification {
  const schema = SCHEMA_REGISTRY[queryType];
  return {
    queryType,
    domain: "test-domain",
    answerShape: schema.renderHint,
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence: 0.9,
  };
}

describe("buildModelPrompt", () => {
  const queryTypes = Object.keys(SCHEMA_REGISTRY) as QueryType[];

  it.each(queryTypes)("matches the snapshot for schema %s", (queryType) => {
    const schema = SCHEMA_REGISTRY[queryType];
    const prompt = buildModelPrompt("What is the answer?", classificationFor(queryType), schema);
    expect(prompt).toMatchSnapshot();
  });

  it("renders only the schema's declared field keys, no extras", () => {
    const schema = SCHEMA_REGISTRY.factual_lookup;
    const prompt = buildModelPrompt("q", classificationFor("factual_lookup"), schema);

    for (const field of schema.fields) {
      expect(prompt).toContain(`"${field.key}"`);
    }
    // factual_lookup must not carry fields from other schemas.
    expect(prompt).not.toContain('"applicableRule"');
    expect(prompt).not.toContain('"metrics"');
  });

  it("includes word and item caps in the field lines", () => {
    const schema = SCHEMA_REGISTRY.contested_empirical;
    const prompt = buildModelPrompt("q", classificationFor("contested_empirical"), schema);

    expect(prompt).toMatch(/Max 60 words\./);
    expect(prompt).toMatch(/Max 4 items\./);
  });

  it("includes the Claim interface exactly once when a claim[] field is present", () => {
    const schema = SCHEMA_REGISTRY.generic;
    const prompt = buildModelPrompt("q", classificationFor("generic"), schema);

    const occurrences = prompt.split("interface Claim {").length - 1;
    expect(occurrences).toBe(1);
  });

  it("omits type interfaces the schema doesn't use", () => {
    const schema = SCHEMA_REGISTRY.factual_lookup; // only string fields
    const prompt = buildModelPrompt("q", classificationFor("factual_lookup"), schema);

    expect(prompt).not.toContain("interface Claim {");
    expect(prompt).not.toContain("interface Metric {");
    expect(prompt).not.toContain("interface Step {");
    expect(prompt).not.toContain("interface Scenario {");
  });

  it("integrates context when supplied", () => {
    const schema = SCHEMA_REGISTRY.generic;
    const prompt = buildModelPrompt("q", classificationFor("generic"), schema, "some supporting material");

    expect(prompt).toContain("CONTEXT");
    expect(prompt).toContain("some supporting material");
  });

  it("instructs JSON-only output with no markdown fences", () => {
    const schema = SCHEMA_REGISTRY.generic;
    const prompt = buildModelPrompt("q", classificationFor("generic"), schema);

    expect(prompt.toLowerCase()).toContain("no markdown fences");
  });
});
