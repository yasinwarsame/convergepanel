/**
 * ADAPTIVE_RETRY_CORRECTION — pure merge / outcome / usage-sink / AR9
 * contract tests. Inputs are produced by the REAL validator so the shapes
 * match what finalizeAdaptiveRun() actually merges.
 */

import { validateAdaptiveResponse } from "@/lib/adaptiveSchema/validator";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import {
  ADAPTIVE_RETRY_OUTCOMES,
  AdaptiveRetryUsageSink,
  mergeAdaptiveRetry,
  normalizeAdaptiveRetryUsage,
  parseAdaptiveRetryOutcome,
  retryStateAllowsProviderSearchEvidence,
} from "@/lib/adaptiveSchema/retryCorrection";
import type { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";

const MATRIX = SCHEMA_REGISTRY.comparison_matrix;
const FACTUAL = SCHEMA_REGISTRY.factual_lookup;

const FULL_MATRIX = {
  cells: [
    { subject: "A", attribute: "speed", value: "fast", verdict: "better" },
    { subject: "B", attribute: "speed", value: "slow", verdict: "worse" },
  ],
  directConclusion: "RETRY conclusion",
  tradeoffs: ["RETRY tradeoff"],
  bestUseRecommendations: ["RETRY rec"],
  uncertainties: ["RETRY unc"],
};

const validate = (schema: typeof MATRIX, text: string | null) => validateAdaptiveResponse("perplexity", schema, text);
const withLatency = (r: AdaptiveModelResult, latencyMs = 111): AdaptiveModelResult => ({ ...r, latencyMs });

describe("retry outcome enum (AR8)", () => {
  it("is exactly the six behaviourally distinct outcomes", () => {
    expect([...ADAPTIVE_RETRY_OUTCOMES]).toEqual([
      "adopted_full",
      "adopted_partial",
      "no_change",
      "failed_call",
      "skipped_budget",
      "ineligible_substituted",
    ]);
  });

  it("parses fail-closed: absent, known, and anything else as unknown", () => {
    expect(parseAdaptiveRetryOutcome(undefined)).toEqual({ kind: "absent" });
    expect(parseAdaptiveRetryOutcome(null)).toEqual({ kind: "absent" });
    for (const outcome of ADAPTIVE_RETRY_OUTCOMES) {
      expect(parseAdaptiveRetryOutcome(outcome)).toEqual({ kind: "known", outcome });
    }
    for (const bad of ["ADOPTED_FULL", "adopted", "", 1, true, {}, ["no_change"]]) {
      expect(parseAdaptiveRetryOutcome(bad)).toEqual({ kind: "unknown" });
    }
  });
});

describe("AR1 — zero usable first data + valid retry adopts the retry in full", () => {
  const firstTexts: Array<[string, string | null]> = [
    ["invalid JSON", "{not json"],
    ["empty text", "   "],
    ["null text (data null)", null],
    ["JSON primitive", "42"],
    ["JSON array", "[1,2]"],
    ["object with every field invalid", JSON.stringify({ cells: "x", directConclusion: 5, tradeoffs: 1, bestUseRecommendations: 2, uncertainties: 3 })],
  ];

  it.each(firstTexts)("%s", (_label, text) => {
    const first = withLatency(validate(MATRIX, text));
    expect(first.ok).toBe(false);
    expect(first.data).toBeNull();
    const retry = validate(MATRIX, JSON.stringify(FULL_MATRIX));
    expect(retry.ok).toBe(true);

    const { result, outcome } = mergeAdaptiveRetry(first, retry);

    expect(outcome).toBe("adopted_full");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(retry.data);
    expect(result.modelId).toBe(first.modelId);
    expect(result.schemaId).toBe(first.schemaId);
    expect(result.retried).toBe(true);
    expect(result.retryOutcome).toBe("adopted_full");
    expect(result.latencyMs).toBe(111); // AR7: primary attempt latency, never the retry's
    expect(result).not.toHaveProperty("parseError");
    expect(result).not.toHaveProperty("invalidFields");
  });

  it("keeps the retry's own unresolved fields and coercions when the retry itself is partial", () => {
    const first = validate(MATRIX, "{not json");
    const partialRetry = validate(MATRIX, JSON.stringify({ ...FULL_MATRIX, tradeoffs: "not-an-array" }));
    expect(partialRetry.ok).toBe(true);
    const { result, outcome } = mergeAdaptiveRetry(first, partialRetry);
    expect(outcome).toBe("adopted_full");
    expect(result.invalidFields).toEqual(["tradeoffs"]);
    expect(result.data?.directConclusion).toBe("RETRY conclusion");
  });

  it("adds no latencyMs key when the first attempt had none (no fabricated values)", () => {
    const { result } = mergeAdaptiveRetry(validate(MATRIX, "{bad"), validate(MATRIX, JSON.stringify(FULL_MATRIX)));
    expect(result).not.toHaveProperty("latencyMs");
  });
});

describe("AR2 — partial salvage: valid first values win, the retry only fills gaps", () => {
  const FIRST_PARTIAL = {
    cells: FULL_MATRIX.cells,
    directConclusion: "FIRST conclusion (valid, must survive)",
    tradeoffs: "not-an-array",
    uncertainties: ["FIRST unc"],
  }; // bestUseRecommendations missing

  it("fills multiple invalid/missing fields and never overwrites a differing valid first value", () => {
    const first = withLatency(validate(MATRIX, JSON.stringify(FIRST_PARTIAL)));
    expect(first.ok).toBe(true);
    expect([...(first.invalidFields || [])].sort()).toEqual(["bestUseRecommendations", "tradeoffs"]);
    const retry = validate(MATRIX, JSON.stringify(FULL_MATRIX)); // differs on directConclusion + uncertainties

    const { result, outcome } = mergeAdaptiveRetry(first, retry);

    expect(outcome).toBe("adopted_partial");
    expect(result.retryOutcome).toBe("adopted_partial");
    expect(result.retried).toBe(true);
    // Byte-identical preservation: same references, same serialized bytes.
    for (const key of Object.keys(first.data!)) {
      expect(result.data![key]).toBe(first.data![key]);
      expect(JSON.stringify(result.data![key])).toBe(JSON.stringify(first.data![key]));
    }
    expect(result.data!.directConclusion).toBe("FIRST conclusion (valid, must survive)");
    expect(result.data!.uncertainties).toEqual(["FIRST unc"]);
    expect(result.data!.tradeoffs).toEqual(["RETRY tradeoff"]);
    expect(result.data!.bestUseRecommendations).toEqual(["RETRY rec"]);
    expect(result).not.toHaveProperty("invalidFields");
    expect(result.latencyMs).toBe(111);
  });

  it("fills a single missing field", () => {
    const first = validate(FACTUAL, JSON.stringify({ answer: "42", source: "reference" }));
    expect(first.invalidFields).toEqual(["caveat"]);
    const { result, outcome } = mergeAdaptiveRetry(first, validate(FACTUAL, JSON.stringify({ answer: "43", source: "other", caveat: "none" })));
    expect(outcome).toBe("adopted_partial");
    expect(result.data).toEqual({ answer: "42", source: "reference", caveat: "none" });
  });

  it("retry filling only a subset leaves the remainder unresolved", () => {
    const first = validate(MATRIX, JSON.stringify(FIRST_PARTIAL));
    const { result, outcome } = mergeAdaptiveRetry(first, validate(MATRIX, JSON.stringify({ tradeoffs: ["RETRY tradeoff only"] })));
    expect(outcome).toBe("adopted_partial");
    expect(result.data!.tradeoffs).toEqual(["RETRY tradeoff only"]);
    expect(result.invalidFields).toEqual(["bestUseRecommendations"]);
  });

  it("a retry that resolves nothing is no_change and returns the first attempt unchanged", () => {
    const first = validate(MATRIX, JSON.stringify(FIRST_PARTIAL));
    for (const retryText of ["{bad", JSON.stringify({ directConclusion: "only a field that was already valid" })]) {
      const { result, outcome } = mergeAdaptiveRetry(first, validate(MATRIX, retryText));
      expect(outcome).toBe("no_change");
      expect(result).toEqual({ ...first, retried: true, retryOutcome: "no_change" });
      expect(result.data).toBe(first.data);
    }
  });

  it("keeps truncation/coercion metadata only for fields actually kept or adopted", () => {
    const first: AdaptiveModelResult = {
      modelId: "gemini",
      schemaId: "comparison_matrix",
      ok: true,
      data: { directConclusion: "FIRST" },
      invalidFields: ["tradeoffs", "cells"],
      truncatedFields: ["directConclusion", "cells"],
      coercions: [
        { modelId: "gemini", schemaId: "comparison_matrix", field: "verdict" as any, path: "directConclusion", raw: "x", coerced: "y" },
        { modelId: "gemini", schemaId: "comparison_matrix", field: "verdict" as any, path: "cells[0].verdict", raw: "Better", coerced: "better" },
      ],
    };
    const retried: AdaptiveModelResult = {
      modelId: "gemini",
      schemaId: "comparison_matrix",
      ok: true,
      data: { tradeoffs: ["t"], directConclusion: "RETRY" },
      truncatedFields: ["tradeoffs", "directConclusion"],
      coercions: [
        { modelId: "gemini", schemaId: "comparison_matrix", field: "verdict" as any, path: "tradeoffs[0]", raw: "a", coerced: "b" },
        { modelId: "gemini", schemaId: "comparison_matrix", field: "verdict" as any, path: "directConclusion", raw: "c", coerced: "d" },
      ],
    };
    const { result } = mergeAdaptiveRetry(first, retried);
    expect(result.data).toEqual({ directConclusion: "FIRST", tradeoffs: ["t"] });
    expect(result.invalidFields).toEqual(["cells"]);
    expect(result.truncatedFields).toEqual(["directConclusion", "tradeoffs"]);
    expect(result.coercions!.map((c) => c.path)).toEqual(["directConclusion", "tradeoffs[0]"]);
  });
});

describe("truncation metadata from the retry is kept only for adopted fields", () => {
  it("a field the retry truncated but that was not adopted leaves no truncation marker", () => {
    const first: AdaptiveModelResult = {
      modelId: "gemini",
      schemaId: "comparison_matrix",
      ok: true,
      data: { directConclusion: "FIRST", uncertainties: ["u"] },
      invalidFields: ["tradeoffs"],
    };
    const retried: AdaptiveModelResult = {
      modelId: "gemini",
      schemaId: "comparison_matrix",
      ok: true,
      data: { tradeoffs: ["t"], uncertainties: ["retry u"] },
      truncatedFields: ["uncertainties"], // truncated in the retry, but the first value is kept
    };
    const { result } = mergeAdaptiveRetry(first, retried);
    expect(result.data!.uncertainties).toEqual(["u"]);
    expect(result).not.toHaveProperty("truncatedFields");
  });
});

describe("double failure keeps the first attempt's validation failure", () => {
  it.each([
    ["malformed retry", "nope"],
    ["empty retry", ""],
    ["invalid-object retry", JSON.stringify({ cells: 1 })],
  ])("%s", (_label, retryText) => {
    const first = validate(MATRIX, "{not json");
    const { result, outcome } = mergeAdaptiveRetry(first, validate(MATRIX, retryText));
    expect(outcome).toBe("no_change");
    expect(result.parseError).toBe(first.parseError);
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
  });

  it("keeps the first attempt's invalidFields when every field was invalid", () => {
    const first = validate(MATRIX, JSON.stringify({ cells: "x", directConclusion: 5, tradeoffs: 1, bestUseRecommendations: 2, uncertainties: 3 }));
    const { result } = mergeAdaptiveRetry(first, validate(MATRIX, "{bad"));
    expect(result.invalidFields).toEqual(first.invalidFields);
    expect(result.parseError).toBe(first.parseError);
  });
});

describe("normalizeAdaptiveRetryUsage (AR4)", () => {
  it("normalizes reported usage", () => {
    expect(
      normalizeAdaptiveRetryUsage("claude", { modelId: "claude", status: "ok", rawText: "x", tokenUsage: { totalTokens: 30, promptTokens: 20, completionTokens: 10 } })
    ).toEqual({ promptTokens: 20, completionTokens: 10, totalTokens: 30 });
  });

  it("treats a missing or zero usage block as unavailable — never a fabricated 0-cost call", () => {
    expect(normalizeAdaptiveRetryUsage("claude", { modelId: "claude", status: "ok", rawText: "x" })).toBeNull();
    expect(
      normalizeAdaptiveRetryUsage("claude", { modelId: "claude", status: "error", rawText: null, tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null } })
    ).toBeNull();
  });

  it("keeps Grok reasoning tokens from the provider usage block", () => {
    expect(
      normalizeAdaptiveRetryUsage("grok", {
        modelId: "grok",
        status: "ok",
        rawText: "x",
        rawResponse: { usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 14, completion_tokens_details: { reasoning_tokens: 4 } } },
      })
    ).toEqual({ promptTokens: 5, completionTokens: 5, totalTokens: 14, reasoningTokens: 4 });
  });

  it("counts usage reported on a non-ok response (the call happened)", () => {
    expect(
      normalizeAdaptiveRetryUsage("perplexity", { modelId: "perplexity", status: "error", rawText: null, tokenUsage: { totalTokens: 9, promptTokens: 6, completionTokens: 3 } })
    ).toEqual({ promptTokens: 6, completionTokens: 3, totalTokens: 9 });
  });
});

describe("AdaptiveRetryUsageSink", () => {
  it("aggregates per model and in total, counting unavailable usage separately", () => {
    const sink = new AdaptiveRetryUsageSink();
    sink.record(0, "claude", { promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    sink.record(1, "grok", { promptTokens: 5, completionTokens: 5, totalTokens: 14, reasoningTokens: 4 });
    sink.record(2, "perplexity", null);
    expect(sink.freeze()).toEqual({
      schemaVersion: 1,
      calls: 3,
      usageUnavailableCalls: 1,
      totals: { promptTokens: 25, completionTokens: 15, totalTokens: 44, reasoningTokens: 4 },
      byModel: {
        claude: { calls: 1, usageUnavailableCalls: 0, promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        grok: { calls: 1, usageUnavailableCalls: 0, promptTokens: 5, completionTokens: 5, totalTokens: 14, reasoningTokens: 4 },
        perplexity: { calls: 1, usageUnavailableCalls: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    });
  });

  it("accepts each slot once and ignores everything after freeze", () => {
    const sink = new AdaptiveRetryUsageSink();
    expect(sink.record(0, "claude", { promptTokens: 1, completionTokens: 1, totalTokens: 2 })).toBe(true);
    expect(sink.record(0, "claude", { promptTokens: 9, completionTokens: 9, totalTokens: 18 })).toBe(false);
    const frozen = sink.freeze();
    expect(sink.record(1, "grok", { promptTokens: 9, completionTokens: 9, totalTokens: 18 })).toBe(false);
    expect(sink.freeze()).toBe(frozen);
    expect(frozen!.totals.totalTokens).toBe(2);
    expect(frozen!.calls).toBe(1);
  });

  it("freezes to null when no retry call was issued", () => {
    expect(new AdaptiveRetryUsageSink().freeze()).toBeNull();
  });
});

describe("AR9 — Provider Search Evidence retry-state contract", () => {
  const cases: Array<[string, { slotStatus: string; retryOutcome: unknown; retried: unknown }, boolean]> = [
    ["no retry metadata, never retried", { slotStatus: "ok", retryOutcome: undefined, retried: undefined }, true],
    ["failed_call", { slotStatus: "ok", retryOutcome: "failed_call", retried: undefined }, true],
    ["no_change", { slotStatus: "ok", retryOutcome: "no_change", retried: true }, true],
    ["skipped_budget", { slotStatus: "ok", retryOutcome: "skipped_budget", retried: undefined }, true],
    ["adopted_full", { slotStatus: "ok", retryOutcome: "adopted_full", retried: true }, false],
    ["adopted_partial", { slotStatus: "ok", retryOutcome: "adopted_partial", retried: true }, false],
    ["ineligible_substituted", { slotStatus: "ok", retryOutcome: "ineligible_substituted", retried: undefined }, false],
    ["substituted slot with no metadata", { slotStatus: "substituted", retryOutcome: undefined, retried: undefined }, false],
    ["substituted slot even with an eligible-looking outcome", { slotStatus: "substituted", retryOutcome: "no_change", retried: true }, false],
    ["unknown persisted outcome", { slotStatus: "ok", retryOutcome: "mystery", retried: undefined }, false],
    ["legacy retried:true without outcome", { slotStatus: "ok", retryOutcome: undefined, retried: true }, false],
  ];
  it.each(cases)("%s", (_label, args, expected) => {
    expect(retryStateAllowsProviderSearchEvidence(args)).toBe(expected);
  });
});
