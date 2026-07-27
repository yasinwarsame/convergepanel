/**
 * Trust Summary Tests (R1c)
 */

import { buildAdaptiveTrustSummary } from "@/lib/adaptiveSchema/trustSummary";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { AdaptiveModelResult, AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { getTrustWeights } from "@/lib/adaptiveSchema/config";

function cell(overrides: Partial<AlignedClaimCell> & Pick<AlignedClaimCell, "modelId" | "stance">): AlignedClaimCell {
  return { rawStance: "asserts", confidence: "settled", excerpt: "x", ...overrides };
}

function row(overrides: Partial<AlignedClaim> & Pick<AlignedClaim, "cells">): AlignedClaim {
  return { id: "row", claimText: "text", agreementScore: 0, certaintyScore: 0, status: "single_source", ...overrides };
}

function result(overrides: Partial<AdaptiveModelResult> & Pick<AdaptiveModelResult, "modelId">): AdaptiveModelResult {
  return { schemaId: "generic", ok: true, data: {}, ...overrides };
}

describe("buildAdaptiveTrustSummary", () => {
  it("parseHealth: ok, degraded (truncated fields), and failed (parseError) map correctly, and failed models score 0 trust", () => {
    const schema = SCHEMA_REGISTRY.generic;
    const results: AdaptiveModelResult[] = [
      result({ modelId: "chatgpt", data: { summary: "x", keyClaims: [] } }),
      result({ modelId: "claude", data: { summary: "x", keyClaims: [] }, truncatedFields: ["summary"] }),
      result({ modelId: "grok", ok: false, data: null, parseError: "invalid JSON" }),
    ];

    const summary = buildAdaptiveTrustSummary(schema, results, []);

    expect(summary.perModel.find((m) => m.modelId === "chatgpt")!.parseHealth).toBe("ok");
    expect(summary.perModel.find((m) => m.modelId === "claude")!.parseHealth).toBe("degraded");
    const grok = summary.perModel.find((m) => m.modelId === "grok")!;
    expect(grok.parseHealth).toBe("failed");
    expect(grok.trustScore).toBe(0);

    // Overall trust excludes the failed model from the mean.
    expect(summary.overallTrust).toBeCloseTo(
      (summary.perModel.find((m) => m.modelId === "chatgpt")!.trustScore +
        summary.perModel.find((m) => m.modelId === "claude")!.trustScore) /
        2,
      5
    );
  });

  it("counts claimsContributed from claim[]/metric[]/step[]/scenario[] fields in the model's own data", () => {
    const schema = SCHEMA_REGISTRY.contested_empirical;
    const results: AdaptiveModelResult[] = [
      result({
        modelId: "chatgpt",
        schemaId: "contested_empirical",
        data: {
          summary: "x",
          settledClaims: [{ id: "a", claim: "x", stance: "asserts", confidence: "settled", evidenceType: "empirical" }],
          disputedClaims: [],
          keyMetrics: [{ label: "CPI", value: 3, unit: "%", asOf: "2026-06", source: "BLS" }],
          openQuestions: [],
        },
      }),
    ];

    const summary = buildAdaptiveTrustSummary(schema, results, []);
    expect(summary.perModel[0].claimsContributed).toBe(2); // 1 settled claim + 1 metric
  });

  it("citationScore: sourced metrics score higher than unsourced/unknown ones", () => {
    const schema = SCHEMA_REGISTRY.financial_valuation;
    const sourced = result({
      modelId: "chatgpt",
      schemaId: "financial_valuation",
      data: { thesis: "x", metrics: [{ label: "P/E", value: 20, unit: "x", asOf: "2026-06", source: "10-K" }], bullCase: "x", bearCase: "x", keyAssumptions: [], riskFactors: [] },
    });
    const unsourced = result({
      modelId: "claude",
      schemaId: "financial_valuation",
      data: { thesis: "x", metrics: [{ label: "P/E", value: 20, unit: "x", asOf: "2026-06", source: "unknown" }], bullCase: "x", bearCase: "x", keyAssumptions: [], riskFactors: [] },
    });

    const summary = buildAdaptiveTrustSummary(schema, [sourced, unsourced], []);
    expect(summary.perModel.find((m) => m.modelId === "chatgpt")!.citationScore).toBe(1);
    expect(summary.perModel.find((m) => m.modelId === "claude")!.citationScore).toBe(0);
  });

  it("citationScore defaults to neutral (1) for schemas with no sourceable field", () => {
    const schema = SCHEMA_REGISTRY.procedural;
    const results: AdaptiveModelResult[] = [
      result({ modelId: "chatgpt", schemaId: "procedural", data: { goal: "x", prerequisites: [], steps: [], commonFailures: [] } }),
    ];
    const summary = buildAdaptiveTrustSummary(schema, results, []);
    expect(summary.perModel[0].citationScore).toBe(1);
  });

  it("majorityAlignment: a model matching every row's majority stance scores 1; a lone dissenter scores lower", () => {
    const schema = SCHEMA_REGISTRY.generic;
    const rows: AlignedClaim[] = [
      row({
        status: "majority",
        cells: [
          cell({ modelId: "chatgpt", stance: "agrees" }),
          cell({ modelId: "claude", stance: "agrees" }),
          cell({ modelId: "grok", stance: "disputes" }),
        ],
      }),
    ];
    const results: AdaptiveModelResult[] = [
      result({ modelId: "chatgpt" }),
      result({ modelId: "claude" }),
      result({ modelId: "grok" }),
    ];

    const summary = buildAdaptiveTrustSummary(schema, results, rows);
    expect(summary.perModel.find((m) => m.modelId === "chatgpt")!.majorityAlignment).toBe(1);
    expect(summary.perModel.find((m) => m.modelId === "grok")!.majorityAlignment).toBe(0);
  });

  it("majorityAlignment defaults to neutral (1) for a model with no comparable rows", () => {
    const schema = SCHEMA_REGISTRY.generic;
    const results: AdaptiveModelResult[] = [result({ modelId: "chatgpt" })];
    const summary = buildAdaptiveTrustSummary(schema, results, []);
    expect(summary.perModel[0].majorityAlignment).toBe(1);
  });

  it("contradictionCount: disputing a row the panel resolved as split counts as a contradiction", () => {
    const schema = SCHEMA_REGISTRY.generic;
    const rows: AlignedClaim[] = [
      row({
        status: "split",
        cells: [cell({ modelId: "chatgpt", stance: "agrees" }), cell({ modelId: "claude", stance: "disputes" })],
      }),
    ];
    const results: AdaptiveModelResult[] = [result({ modelId: "chatgpt" }), result({ modelId: "claude" })];

    const summary = buildAdaptiveTrustSummary(schema, results, rows);
    expect(summary.perModel.find((m) => m.modelId === "claude")!.contradictionCount).toBe(1);
    expect(summary.perModel.find((m) => m.modelId === "chatgpt")!.contradictionCount).toBe(0);
  });

  it("applies the schema's configured trust weights exactly", () => {
    const schema = SCHEMA_REGISTRY.factual_lookup;
    const weights = getTrustWeights("factual_lookup");
    const results: AdaptiveModelResult[] = [
      result({ modelId: "chatgpt", schemaId: "factual_lookup", data: { answer: "42", source: "official record", caveat: "none" } }),
    ];

    const summary = buildAdaptiveTrustSummary(schema, results, []);
    const m = summary.perModel[0];
    // citationScore=1 (sourced), majorityAlignment=1 (no comparable rows), contradictionSubScore=1 (no participated rows).
    const expected = weights.citation * 1 + weights.consistency * 1 + weights.contradiction * 1;
    expect(m.trustScore).toBeCloseTo(expected, 5);
  });
});
