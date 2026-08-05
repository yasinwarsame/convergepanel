/**
 * Field Alignment Tests (R2 unitizers)
 *
 * These are deterministic (no model calls) — they cover the structural
 * matching + numeric/order tolerance logic for metric[], scenario[], step[],
 * and scalar fields.
 */

import { alignMetrics, alignScenarios, alignSteps, alignScalarField } from "@/lib/adaptiveSchema/fieldAlignment";
import { Metric, Scenario, Step } from "@/lib/adaptiveSchema/types";

function metric(overrides: Partial<Metric> & Pick<Metric, "label" | "value">): Metric {
  return { unit: "%", asOf: "2026-06", source: "test", ...overrides };
}

describe("alignMetrics (financial_valuation tolerance bands)", () => {
  it("marks a value within the default 5% tolerance as agrees", () => {
    const rows = alignMetrics([
      { modelId: "chatgpt", metrics: [metric({ label: "Operating margin", value: 34 })] },
      { modelId: "claude", metrics: [metric({ label: "Operating margin", value: 34.5 })] },
      { modelId: "grok", metrics: [metric({ label: "Operating margin", value: 35 })] },
    ]);

    expect(rows).toHaveLength(1);
    const cells = rows[0].cells.filter(Boolean);
    expect(cells.every((c) => c!.stance === "agrees")).toBe(true);
  });

  it("marks a value beyond 2x tolerance as disputes, and between 1x-2x as partial", () => {
    // 5 values, odd count, so the median (100) is an exact data point rather
    // than an average of two — makes the tolerance math unambiguous.
    // Relative offsets from 100: chatgpt 0%, claude 8%, grok 20%, perplexity 8%, gemini 50%.
    const rows = alignMetrics([
      { modelId: "chatgpt", metrics: [metric({ label: "P/E ratio", value: 100 })] },
      { modelId: "claude", metrics: [metric({ label: "P/E ratio", value: 92 })] },
      { modelId: "grok", metrics: [metric({ label: "P/E ratio", value: 80 })] },
      { modelId: "perplexity", metrics: [metric({ label: "P/E ratio", value: 108 })] },
      { modelId: "gemini", metrics: [metric({ label: "P/E ratio", value: 150 })] },
    ]);

    expect(rows).toHaveLength(1);
    const byModel = new Map(rows[0].cells.map((c) => [c?.modelId, c]));
    expect(byModel.get("chatgpt")!.stance).toBe("agrees");
    expect(byModel.get("claude")!.stance).toBe("partial");
    expect(byModel.get("gemini")!.stance).toBe("disputes");
  });

  it("groups metrics by normalized (case/whitespace-insensitive) label", () => {
    const rows = alignMetrics([
      { modelId: "chatgpt", metrics: [metric({ label: "Revenue Growth", value: 12 })] },
      { modelId: "claude", metrics: [metric({ label: "  revenue   growth ", value: 12.1 })] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].cells.filter(Boolean)).toHaveLength(2);
  });
});

describe("alignScenarios (forecast_speculative probability bands)", () => {
  function scenario(overrides: Partial<Scenario> & Pick<Scenario, "label" | "probability">): Scenario {
    return { narrative: "n/a", leadingIndicators: [], ...overrides };
  }

  it("agrees within ±0.15 absolute, disputes beyond ±0.30", () => {
    const rows = alignScenarios([
      { modelId: "chatgpt", scenarios: [scenario({ label: "Soft landing", probability: 0.4 })] },
      { modelId: "claude", scenarios: [scenario({ label: "Soft landing", probability: 0.45 })] },
      { modelId: "grok", scenarios: [scenario({ label: "Soft landing", probability: 0.85 })] },
    ]);

    expect(rows).toHaveLength(1);
    const byModel = new Map(rows[0].cells.map((c) => [c?.modelId, c]));
    expect(byModel.get("chatgpt")!.stance).toBe("agrees");
    expect(byModel.get("grok")!.stance).toBe("disputes");
  });
});

describe("alignSteps (procedural order-sensitive matching)", () => {
  function step(overrides: Partial<Step> & Pick<Step, "order" | "action">): Step {
    return { ...overrides };
  }

  it("does not penalize a model missing a step at a given order (null, not disputes)", () => {
    const rows = alignSteps([
      { modelId: "chatgpt", steps: [step({ order: 1, action: "Create an account" }), step({ order: 2, action: "Verify your email" })] },
      { modelId: "claude", steps: [step({ order: 1, action: "Sign up for an account" })] }, // no step 2
    ]);

    const step2 = rows.find((r) => r.claimText.startsWith("Step 2"));
    expect(step2).toBeDefined();
    // modelOrder is [chatgpt, claude] — index 1 is claude's cell, which must
    // be null (missing step), not a "disputes" penalty.
    expect(step2!.cells[1]).toBeNull();
  });

  it("flags a contradictory step (low text overlap) as disputes", () => {
    const rows = alignSteps([
      { modelId: "chatgpt", steps: [step({ order: 1, action: "Enable two-factor authentication before continuing" })] },
      { modelId: "claude", steps: [step({ order: 1, action: "Disable all account security prompts" })] },
    ]);

    const step1 = rows.find((r) => r.claimText.startsWith("Step 1"));
    expect(step1!.cells.filter(Boolean).length).toBe(2);
    expect(step1!.cells.some((c) => c?.stance === "disputes")).toBe(true);
  });
});

describe("alignScalarField (factual_lookup exact match, legal jurisdiction hard key)", () => {
  it("marks all models agrees when normalized values match exactly", () => {
    const row = alignScalarField(
      [
        { modelId: "chatgpt", value: "Paris, France." },
        { modelId: "claude", value: "paris, france" },
      ],
      "answer",
      "Capital of France",
      "exact_normalized"
    );
    expect(row.cells.filter(Boolean).every((c) => c!.stance === "agrees")).toBe(true);
  });

  it("flags the minority value as disputes on a mismatch", () => {
    const row = alignScalarField(
      [
        { modelId: "chatgpt", value: "California" },
        { modelId: "claude", value: "California" },
        { modelId: "grok", value: "US federal" },
      ],
      "jurisdiction",
      "Jurisdiction",
      "hard_key"
    );
    const byModel = new Map(row.cells.map((c) => [c?.modelId, c]));
    expect(byModel.get("chatgpt")!.stance).toBe("agrees");
    expect(byModel.get("grok")!.stance).toBe("disputes");
  });

  it("sets claimText to the actual majority-agreed answer, not the field's display label", () => {
    const row = alignScalarField(
      [
        { modelId: "chatgpt", value: "Paris, France." },
        { modelId: "claude", value: "paris, france" },
      ],
      "answer",
      "Answer",
      "exact_normalized"
    );
    expect(row.claimText).toBe("Paris, France.");
    expect(row.claimText).not.toBe("Answer");
  });

  it("prefers the longest raw value among models that share the majority normalized form", () => {
    const row = alignScalarField(
      [
        { modelId: "chatgpt", value: "5.25%-5.50%" },
        { modelId: "claude", value: "5.25%-5.50%!" },
      ],
      "answer",
      "Answer",
      "exact_normalized"
    );
    expect(row.claimText).toBe("5.25%-5.50%!");
  });

  it("falls back to the first present value when models disagree with no majority", () => {
    const row = alignScalarField(
      [
        { modelId: "chatgpt", value: "California" },
        { modelId: "claude", value: "US federal" },
      ],
      "jurisdiction",
      "Jurisdiction",
      "hard_key"
    );
    expect(row.claimText).toBe("California");
  });

  it("returns an empty claimText (not the label) when no model returned a value", () => {
    const row = alignScalarField(
      [
        { modelId: "chatgpt", value: null },
        { modelId: "claude", value: "" },
      ],
      "answer",
      "Answer",
      "exact_normalized"
    );
    expect(row.claimText).toBe("");
  });
});
