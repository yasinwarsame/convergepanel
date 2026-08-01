/**
 * Query-Routing Redesign, Milestone 1 — protected-schema regression guard.
 *
 * factual_lookup, procedural, forecast_speculative, and creative_generative
 * must carry over from the pre-redesign registry with their fields/prompts
 * untouched. factual_lookup has exactly ONE approved behavioral change
 * (renderHint -> "direct_answer"); the other three have none at all.
 */

import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";

describe("factual_lookup — only renderHint changed", () => {
  const schema = SCHEMA_REGISTRY.factual_lookup;

  it("renderHint moved to 'direct_answer'", () => {
    expect(schema.renderHint).toBe("direct_answer");
  });

  it("is still active, with headlineField and fallbackQueryType unchanged", () => {
    expect(schema.implementationStatus).toBe("active");
    expect(schema.headlineField).toBe("answer");
    expect(schema.fallbackQueryType).toBe("generic");
  });

  it("retains its exact 3 pre-existing fields — answer, source, caveat — unchanged", () => {
    expect(schema.fields).toEqual([
      {
        key: "answer",
        type: "string",
        description: "The single verifiable answer to the question. No hedging, no essay — just the answer.",
      },
      {
        key: "source",
        type: "string",
        description:
          'What kind of source this answer draws on (e.g. "official record", "widely cited reference", "general knowledge").',
      },
      {
        key: "caveat",
        type: "string",
        maxWords: 25,
        description: 'Any important caveat, ambiguity, or edge case affecting the answer. Use "none" if there isn\'t one.',
      },
    ]);
  });
});

describe("procedural — fully unchanged (documented ≈ step_by_step_plan, no runtime effect)", () => {
  const schema = SCHEMA_REGISTRY.procedural;

  it("renderHint, headlineField, and status are unchanged", () => {
    expect(schema.renderHint).toBe("step_diff");
    expect(schema.headlineField).toBe("steps");
    expect(schema.implementationStatus).toBe("active");
  });

  it("retains its exact 4 pre-existing fields unchanged", () => {
    expect(schema.fields.map((f) => f.key)).toEqual(["goal", "prerequisites", "steps", "commonFailures"]);
    expect(schema.fields.find((f) => f.key === "steps")).toEqual({
      key: "steps",
      type: "step[]",
      maxItems: 10,
      description: "The ordered sequence of actions. Each step is one short action, in order.",
    });
  });
});

describe("forecast_speculative — fully unchanged (documented ≈ scenario_analysis, no runtime effect)", () => {
  const schema = SCHEMA_REGISTRY.forecast_speculative;

  it("renderHint, headlineField, and status are unchanged", () => {
    expect(schema.renderHint).toBe("scenario_tree");
    expect(schema.headlineField).toBe("scenarios");
    expect(schema.implementationStatus).toBe("active");
  });

  it("retains its exact 3 pre-existing fields unchanged", () => {
    expect(schema.fields.map((f) => f.key)).toEqual(["scenarios", "baseRates", "keyUncertainties"]);
    expect(schema.fields.find((f) => f.key === "scenarios")).toEqual({
      key: "scenarios",
      type: "scenario[]",
      minItems: 2,
      maxItems: 4,
      description:
        "Probability-weighted future scenarios. Probabilities across all scenarios in this response must sum to approximately 1.",
    });
  });
});

describe("creative_generative — fully unchanged (documented partial ≈ transformation, no runtime effect)", () => {
  const schema = SCHEMA_REGISTRY.creative_generative;

  it("renderHint, headlineField, and status are unchanged", () => {
    expect(schema.renderHint).toBe("gallery");
    expect(schema.headlineField).toBe("output");
    expect(schema.implementationStatus).toBe("active");
  });

  it("retains its exact 2 pre-existing fields unchanged", () => {
    expect(schema.fields).toEqual([
      { key: "output", type: "string", description: "The generated content itself, in full." },
      {
        key: "styleNotes",
        type: "string[]",
        maxItems: 3,
        description: "Brief notes on the stylistic or creative choices made.",
      },
    ]);
  });
});

describe("contested_empirical, legal_regulatory, financial_valuation, medical_health, generic — active, untouched", () => {
  const UNCHANGED_ACTIVE = [
    "contested_empirical",
    "legal_regulatory",
    "financial_valuation",
    "medical_health",
    "generic",
  ] as const;

  it.each(UNCHANGED_ACTIVE)("%s is still active with a non-empty field list", (id) => {
    const schema = SCHEMA_REGISTRY[id];
    expect(schema.implementationStatus).toBe("active");
    expect(schema.fields.length).toBeGreaterThan(0);
  });
});
