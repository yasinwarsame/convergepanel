/**
 * Adaptive Research Export, Phase 4 — JSON serializer tests. Uses the REAL
 * renderer (no mocking needed — this is pure JS, no ESM-only dependency to
 * work around the way `@react-pdf/renderer` needs in the PDF test file),
 * so every assertion here reflects actual generated output.
 */

import { createHash } from "crypto";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { buildAdaptiveResearchJsonExport, canonicalJsonStringify, canonicalizeForSerialization, renderAdaptiveResearchJsonV1 } from "@/lib/adaptiveSchema/jsonExport";
import { adaptiveResearchJsonExportV1Schema } from "@/lib/adaptiveSchema/jsonExportSchema";

function comparisonMatrixRecord(overrides: Partial<AdaptiveResearchExportV1> = {}): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-json-1",
    runId: "run-json-1",
    schemaId: "comparison_matrix",
    schemaFamily: "milestone2",
    schemaVersion: 1,
    reportVersion: 3,
    createdAt: "2026-01-02T00:00:00.000Z",
    createdBy: "uid-should-never-appear-in-json",
    format: "json",
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "milestone2", kind: "changes_requested", isOwnerOverride: false },
    reportSnapshot: {
      question: "Compare GPT-5.2, Claude Opus 4.5, and Gemini 3 Pro for enterprise research.",
      models: [{ modelId: "chatgpt" as any, ok: true }, { modelId: "claude" as any, ok: true }],
      reportTypeLabel: "Comparison Report",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-01-01T00:00:00.000Z",
      milestone2: {
        schemaId: "comparison_matrix",
        result: { subjects: ["GPT-5.2", "Claude Opus 4.5"], attributes: ["Cost", "Tool use"], cells: [{ subject: "GPT-5.2", attribute: "Cost", agreement: "consensus" }], totalModels: 2 },
        meta: {} as any,
        decisionReceipt: {
          conclusion: "Both strong; depends on tool-use vs long-context priorities.",
          basis: ["Benchmark A"],
          assumptions: [],
          uncertainties: [],
          limitations: [],
          sources: [],
          sourceBacked: false,
          humanReviewNeeded: true,
        },
      },
    },
    exportMetadata: {
      exportId: "exp-json-1",
      runId: "run-json-1",
      schemaVersion: 1,
      exportedSections: ["reportSnapshot.milestone2"],
      createdAt: "2026-01-02T00:00:00.000Z",
      requestingUser: "uid-should-never-appear-in-json",
      finalReportVersion: 3,
    },
    ...overrides,
  };
}

function financialValuationRecord(): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-json-fin",
    runId: "run-json-fin",
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "uid-fin",
    format: "json",
    artifactStatus: "ready",
    classification: "confidential",
    governanceStatusAtExport: { family: "legacy", status: "needs_review" },
    reportSnapshot: {
      question: "What is a reasonable valuation range?",
      models: [{ modelId: "chatgpt" as any, ok: true }, { modelId: "claude" as any, ok: true }],
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "weak",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-01-01T00:00:00.000Z",
      legacy: {
        schemaId: "financial_valuation",
        alignedClaims: [],
        modelResponses: [
          { modelId: "chatgpt" as any, schemaId: "financial_valuation", ok: true, data: { thesis: "Fairly valued.", metrics: [{ label: "P/E", value: 18, unit: "x", asOf: "2026", source: "10-K" }] } },
          { modelId: "claude" as any, schemaId: "financial_valuation", ok: true, data: { thesis: "Slightly overvalued.", metrics: [{ label: "P/E", value: 22, unit: "x", asOf: "2026", source: "10-K" }] } },
        ],
      },
    },
    exportMetadata: { exportId: "exp-json-fin", runId: "run-json-fin", schemaVersion: 1, exportedSections: ["reportSnapshot.legacy"], createdAt: "2026-01-01T00:00:00.000Z", requestingUser: "uid-fin", finalReportVersion: 1 },
  };
}

function forecastRecord(): AdaptiveResearchExportV1 {
  const base = financialValuationRecord();
  return {
    ...base,
    exportId: "exp-json-forecast",
    runId: "run-json-forecast",
    schemaId: "forecast_speculative",
    reportSnapshot: {
      ...base.reportSnapshot,
      reportTypeLabel: "Forecast",
      legacy: {
        schemaId: "forecast_speculative",
        alignedClaims: [],
        modelResponses: [
          {
            modelId: "chatgpt" as any,
            schemaId: "forecast_speculative",
            ok: true,
            data: {
              scenarios: [
                { name: "Bull case", probability: 0.3, description: "Rapid adoption." },
                { name: "Bear case", probability: 0.2, description: "Stagnation." },
              ],
              baseRates: ["Historical category growth: 8%/yr"],
              keyUncertainties: ["Regulatory response"],
            },
          },
        ],
      },
    },
    exportMetadata: { ...base.exportMetadata, exportId: "exp-json-forecast", runId: "run-json-forecast" },
  };
}

function evidenceReviewRecord(): AdaptiveResearchExportV1 {
  const base = comparisonMatrixRecord();
  return {
    ...base,
    exportId: "exp-json-evidence",
    runId: "run-json-evidence",
    schemaId: "evidence_review",
    reportSnapshot: {
      ...base.reportSnapshot,
      reportTypeLabel: "Evidence Review",
      milestone2: {
        schemaId: "evidence_review",
        result: {},
        meta: {} as any,
        decisionReceipt: {
          conclusion: "Evidence coverage is broad but individual sources are weak.",
          basis: ["12 sources across 3 domains"],
          assumptions: [],
          uncertainties: ["Coverage breadth does not guarantee reliability"],
          limitations: [],
          sources: ["Source A", "Source B"],
          sourceBacked: true,
          humanReviewNeeded: false,
        },
      },
    },
    exportMetadata: { ...base.exportMetadata, exportId: "exp-json-evidence", runId: "run-json-evidence" },
  };
}

function creativeGenerativeRecord(): AdaptiveResearchExportV1 {
  const base = financialValuationRecord();
  return {
    ...base,
    exportId: "exp-json-creative",
    runId: "run-json-creative",
    schemaId: "creative_generative",
    reportSnapshot: {
      ...base.reportSnapshot,
      reportTypeLabel: "Creative Output",
      consensusLevel: "unscored",
      sourceGroundingLevel: "unscored",
      legacy: {
        schemaId: "creative_generative",
        alignedClaims: [],
        modelResponses: [
          { modelId: "chatgpt" as any, schemaId: "creative_generative", ok: true, data: { output: "Option A." } },
          { modelId: "claude" as any, schemaId: "creative_generative", ok: true, data: { output: "Option B." } },
        ],
      },
    },
    exportMetadata: { ...base.exportMetadata, exportId: "exp-json-creative", runId: "run-json-creative" },
  };
}

describe("buildAdaptiveResearchJsonExport — contract shape", () => {
  it("validates against the V1 Zod schema for every required schema fixture", () => {
    for (const record of [comparisonMatrixRecord(), financialValuationRecord(), forecastRecord(), evidenceReviewRecord(), creativeGenerativeRecord()]) {
      const json = buildAdaptiveResearchJsonExport(record);
      const result = adaptiveResearchJsonExportV1Schema.safeParse(json);
      expect(result.success).toBe(true);
    }
  });

  it("sets formatVersion and export.format correctly", () => {
    const json = buildAdaptiveResearchJsonExport(comparisonMatrixRecord());
    expect(json.formatVersion).toBe("1");
    expect(json.export.format).toBe("json");
    expect(json.export.exportId).toBe("exp-json-1");
    expect(json.export.reportVersion).toBe(3);
  });

  it("uses ISO timestamps straight from the frozen record — never re-derives a current timestamp", () => {
    const json = buildAdaptiveResearchJsonExport(comparisonMatrixRecord());
    expect(json.report.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(json.provenance.exportedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("buildAdaptiveResearchJsonExport — privacy/security exclusions", () => {
  it("never includes the requesting/creator Firebase UID anywhere in the output", () => {
    const json = buildAdaptiveResearchJsonExport(comparisonMatrixRecord());
    const text = JSON.stringify(json);
    expect(text).not.toContain("uid-should-never-appear-in-json");
  });

  it("never includes internal Firestore/audit implementation fields (artifactStatus, exportedSections, fileHash, requestingUser)", () => {
    const json = buildAdaptiveResearchJsonExport(comparisonMatrixRecord()) as unknown as Record<string, unknown>;
    expect(json).not.toHaveProperty("artifactStatus");
    expect(json).not.toHaveProperty("exportedSections");
    expect(json).not.toHaveProperty("fileHash");
    expect(json).not.toHaveProperty("requestingUser");
    expect(json).not.toHaveProperty("createdBy");
  });

  it("never includes a UI-oriented human label where a machine-readable enum already exists (no reportTypeLabel)", () => {
    const json = buildAdaptiveResearchJsonExport(comparisonMatrixRecord()) as unknown as Record<string, unknown>;
    const text = JSON.stringify(json);
    expect(text).not.toContain("Comparison Report");
    expect((json.report as Record<string, unknown>).schemaId).toBe("comparison_matrix");
  });
});

describe("buildAdaptiveResearchJsonExport — consensus/source-grounding semantics", () => {
  it("exposes the raw enum level, never a fabricated numeric score", () => {
    const json = buildAdaptiveResearchJsonExport(comparisonMatrixRecord());
    expect(json.panel.consensus).toEqual({ level: "moderate" });
    expect(json.panel.sourceGrounding).toEqual({ level: "strong" });
  });

  it("creative_generative: consensus and sourceGrounding are both the real 'unscored' value, not 0 or omitted", () => {
    const json = buildAdaptiveResearchJsonExport(creativeGenerativeRecord());
    expect(json.panel.consensus.level).toBe("unscored");
    expect(json.panel.sourceGrounding.level).toBe("unscored");
  });
});

describe("buildAdaptiveResearchJsonExport — governance (Part 12)", () => {
  it("preserves changes_requested verbatim — never coerced to rejected or needs_review", () => {
    const json = buildAdaptiveResearchJsonExport(comparisonMatrixRecord());
    expect(json.governance).toEqual({ family: "milestone2", kind: "changes_requested", isOwnerOverride: false });
  });

  it("legacy family keeps its own real 3-value vocabulary, never the Milestone-2 8-state labels", () => {
    const json = buildAdaptiveResearchJsonExport(financialValuationRecord());
    expect(json.governance).toEqual({ family: "legacy", status: "needs_review" });
  });
});

describe("buildAdaptiveResearchJsonExport — financial_valuation semantics", () => {
  it("preserves independent per-model metric values — never averages, never manufactures a midpoint", () => {
    const json = buildAdaptiveResearchJsonExport(financialValuationRecord());
    expect(json.result.schemaFamily).toBe("legacy");
    if (json.result.schemaFamily !== "legacy") throw new Error("unreachable");
    const responses = json.result.modelResponses as any[];
    expect(responses).toHaveLength(2);
    expect((responses[0].data as any).metrics[0].value).toBe(18);
    expect((responses[1].data as any).metrics[0].value).toBe(22);
    const text = JSON.stringify(json);
    expect(text).not.toMatch(/"value":\s*20\b/); // (18+22)/2 — never a manufactured midpoint
  });

  it("preserves unit/source alongside the value — never dropped", () => {
    const json = buildAdaptiveResearchJsonExport(financialValuationRecord());
    if (json.result.schemaFamily !== "legacy") throw new Error("unreachable");
    const metric = (json.result.modelResponses as any[])[0].data.metrics[0];
    expect(metric.unit).toBe("x");
    expect(metric.source).toBe("10-K");
  });
});

describe("buildAdaptiveResearchJsonExport — forecast_speculative semantics", () => {
  it("keeps scenarios as scenarios — never invents a probability field beyond what the model itself provided", () => {
    const json = buildAdaptiveResearchJsonExport(forecastRecord());
    if (json.result.schemaFamily !== "legacy") throw new Error("unreachable");
    const scenarios = (json.result.modelResponses as any[])[0].data.scenarios;
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0]).toEqual({ name: "Bull case", probability: 0.3, description: "Rapid adoption." });
    const text = JSON.stringify(json);
    expect(text).not.toContain("overallProbability");
    expect(text).not.toContain("predictedOutcome");
  });

  it("keeps baseRates and keyUncertainties as separate fields from scenarios", () => {
    const json = buildAdaptiveResearchJsonExport(forecastRecord());
    if (json.result.schemaFamily !== "legacy") throw new Error("unreachable");
    const data = (json.result.modelResponses as any[])[0].data;
    expect(data.baseRates).toEqual(["Historical category growth: 8%/yr"]);
    expect(data.keyUncertainties).toEqual(["Regulatory response"]);
  });
});

describe("buildAdaptiveResearchJsonExport — evidence_review semantics", () => {
  it("keeps evidence coverage (basis/sources) structurally distinct from consensus/sourceGrounding scoring", () => {
    const json = buildAdaptiveResearchJsonExport(evidenceReviewRecord());
    if (json.result.schemaFamily !== "milestone2") throw new Error("unreachable");
    expect(json.result.decisionReceipt?.conclusion).toContain("broad");
    // Coverage-related content lives in decisionReceipt; consensus/sourceGrounding remain a separate, non-conflated field.
    expect(json.panel.consensus.level).not.toBe("broad" as any);
  });
});

describe("buildAdaptiveResearchJsonExport — creative_generative semantics (Part 8)", () => {
  it("preserves distinct alternatives — never fabricates a claims matrix for a schema that has none", () => {
    const json = buildAdaptiveResearchJsonExport(creativeGenerativeRecord());
    if (json.result.schemaFamily !== "legacy") throw new Error("unreachable");
    expect(json.result.alignedClaims).toEqual([]);
    expect(json.result.gate).toBeUndefined();
    expect(json.result.synthesisReport).toBeUndefined();
    const outputs = (json.result.modelResponses as any[]).map((r) => r.data.output);
    expect(outputs).toEqual(["Option A.", "Option B."]);
  });

  it("never emits an artificial agreedClaims/disputedClaims/evidenceStrength field", () => {
    const json = buildAdaptiveResearchJsonExport(creativeGenerativeRecord());
    const text = JSON.stringify(json);
    expect(text).not.toContain("agreedClaims");
    expect(text).not.toContain("disputedClaims");
    expect(text).not.toContain("evidenceStrength");
  });
});

describe("buildAdaptiveResearchJsonExport — schema-family discriminator (Part 4)", () => {
  it("milestone2 and legacy records never both populate, and the discriminator matches the populated branch", () => {
    const m2 = buildAdaptiveResearchJsonExport(comparisonMatrixRecord());
    expect(m2.result.schemaFamily).toBe("milestone2");
    expect(m2.report.schemaFamily).toBe("milestone2");

    const legacy = buildAdaptiveResearchJsonExport(financialValuationRecord());
    expect(legacy.result.schemaFamily).toBe("legacy");
    expect(legacy.report.schemaFamily).toBe("legacy");
  });
});

describe("canonicalizeForSerialization / canonicalJsonStringify — determinism (Part 15)", () => {
  it("sorts object keys alphabetically at every depth, but never reorders array elements", () => {
    const input = { z: 1, a: 2, list: [{ z: 1, a: 2 }, { z: 3, a: 4 }] };
    const canonical = canonicalizeForSerialization(input) as any;
    expect(Object.keys(canonical)).toEqual(["a", "list", "z"]);
    expect(Object.keys(canonical.list[0])).toEqual(["a", "z"]);
    // Array element order preserved exactly.
    expect(canonical.list[0].z).toBe(1);
    expect(canonical.list[1].z).toBe(3);
  });

  it("same frozen record produces byte-identical JSON across repeated renders (real repeated-render check, not just object-equality)", () => {
    const record = comparisonMatrixRecord();
    const first = canonicalJsonStringify(buildAdaptiveResearchJsonExport(record));
    const second = canonicalJsonStringify(buildAdaptiveResearchJsonExport(record));
    const hash1 = createHash("sha256").update(first).digest("hex");
    const hash2 = createHash("sha256").update(second).digest("hex");
    expect(hash1).toBe(hash2);
    expect(first).toBe(second);
  });

  it("is resilient to Firestore returning the same logical document with different field insertion order", () => {
    // Deep-clone with every object's keys re-inserted in REVERSED order —
    // logically identical data, deliberately different insertion order at
    // every level, simulating Firestore not guaranteeing field order
    // across reads.
    function reverseKeyOrder(v: unknown): unknown {
      if (Array.isArray(v)) return v.map(reverseKeyOrder);
      if (v !== null && typeof v === "object") {
        const entries = Object.keys(v as Record<string, unknown>)
          .reverse()
          .map((k) => [k, reverseKeyOrder((v as Record<string, unknown>)[k])] as const);
        return Object.fromEntries(entries);
      }
      return v;
    }
    const recordA = comparisonMatrixRecord();
    const recordB = reverseKeyOrder(recordA) as AdaptiveResearchExportV1;
    const strA = canonicalJsonStringify(buildAdaptiveResearchJsonExport(recordA));
    const strB = canonicalJsonStringify(buildAdaptiveResearchJsonExport(recordB));
    expect(strA).toBe(strB);
  });

  it("fixed 2-space indentation and a trailing newline", () => {
    const text = canonicalJsonStringify({ a: 1 });
    expect(text).toBe('{\n  "a": 1\n}\n');
  });

  it("renderAdaptiveResearchJsonV1 produces byte-identical bytes/sha256 across repeated calls on the same record", () => {
    const record = financialValuationRecord();
    const first = renderAdaptiveResearchJsonV1(record);
    const second = renderAdaptiveResearchJsonV1(record);
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes.equals(second.bytes)).toBe(true);
  });
});

describe("canonicalizeForSerialization — prototype pollution safety (Part 19)", () => {
  it("a record containing __proto__/constructor/prototype-named keys never pollutes Object.prototype", () => {
    const before = ({} as any).polluted;
    const malicious = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"polluted2": "yes"}}}');
    const record = financialValuationRecord();
    (record.reportSnapshot.legacy!.modelResponses![0].data as any) = malicious;
    const json = buildAdaptiveResearchJsonExport(record);
    canonicalizeForSerialization(json);
    expect(({} as any).polluted).toBe(before);
    expect(({} as any).polluted2).toBeUndefined();
  });

  it("a dangerous key becomes an inert own property, not a live prototype link, after canonicalization", () => {
    const malicious = JSON.parse('{"__proto__": {"x": 1}}');
    const canonical = canonicalizeForSerialization(malicious) as any;
    expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(canonical, "__proto__")).toBe(true);
  });

  it("renderAdaptiveResearchJsonV1 with dangerous keys in model data still produces valid, safely-escaped JSON", () => {
    const record = financialValuationRecord();
    (record.reportSnapshot.legacy!.modelResponses![0].data as any) = JSON.parse('{"__proto__": {"polluted": true}, "thesis": "ok"}');
    const rendered = renderAdaptiveResearchJsonV1(record);
    expect(() => JSON.parse(rendered.bytes.toString("utf-8"))).not.toThrow();
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("renderAdaptiveResearchJsonV1 — JSON safety with adversarial text (Part 18)", () => {
  it("valid JSON output for quotes, backslashes, control characters, unicode, HTML/script-like text, and newlines — never HTML-sanitized", () => {
    const record = financialValuationRecord();
    record.reportSnapshot.question = 'Quote " Backslash \\ Newline\nTab\tUnicode café éèê <script>alert(1)</script> & < >';
    const rendered = renderAdaptiveResearchJsonV1(record);
    const text = rendered.bytes.toString("utf-8");
    const parsed = JSON.parse(text);
    expect(parsed.report.question).toBe(record.reportSnapshot.question);
    // The literal script tag survives as data, unescaped-for-HTML (this is JSON, not HTML) — but is valid, safely quoted JSON, never breaking the surrounding structure.
    expect(parsed.report.question).toContain("<script>alert(1)</script>");
  });

  it("an extremely long field value does not crash generation", () => {
    const record = financialValuationRecord();
    const huge = "x".repeat(500_000);
    (record.reportSnapshot.legacy!.modelResponses![0].data as any).thesis = huge;
    expect(() => renderAdaptiveResearchJsonV1(record)).not.toThrow();
  });
});

describe("renderAdaptiveResearchJsonV1 — MIME/output shape", () => {
  it("produces valid, parseable JSON starting with '{' and a real sha256", () => {
    const rendered = renderAdaptiveResearchJsonV1(comparisonMatrixRecord());
    expect(rendered.bytes.subarray(0, 1).toString()).toBe("{");
    expect(rendered.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => JSON.parse(rendered.bytes.toString("utf-8"))).not.toThrow();
  });
});

describe("renderAdaptiveResearchJsonV1 — non-finite numbers (Part 9): fail loudly, never a silent misleading null", () => {
  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ])("a %s metric value throws rather than silently serializing as null", (_label, badValue) => {
    const record = financialValuationRecord();
    (record.reportSnapshot.legacy!.modelResponses![0].data as any).metrics[0].value = badValue;
    expect(() => renderAdaptiveResearchJsonV1(record)).toThrow(/non-finite/i);
  });

  it("a genuinely finite number (including 0 and negative values) is completely unaffected", () => {
    const record = financialValuationRecord();
    (record.reportSnapshot.legacy!.modelResponses![0].data as any).metrics[0].value = 0;
    const rendered = renderAdaptiveResearchJsonV1(record);
    const parsed = JSON.parse(rendered.bytes.toString("utf-8"));
    expect(parsed.result.modelResponses[0].data.metrics[0].value).toBe(0);

    const record2 = financialValuationRecord();
    (record2.reportSnapshot.legacy!.modelResponses![0].data as any).metrics[0].value = -18.5;
    const rendered2 = renderAdaptiveResearchJsonV1(record2);
    const parsed2 = JSON.parse(rendered2.bytes.toString("utf-8"));
    expect(parsed2.result.modelResponses[0].data.metrics[0].value).toBe(-18.5);
  });

  it("null itself (a genuinely absent metric value, per MetricZod's own .nullable()) still passes through as null — only non-finite NUMBERS are rejected, not legitimate nulls", () => {
    const record = financialValuationRecord();
    (record.reportSnapshot.legacy!.modelResponses![0].data as any).metrics[0].value = null;
    const rendered = renderAdaptiveResearchJsonV1(record);
    const parsed = JSON.parse(rendered.bytes.toString("utf-8"));
    expect(parsed.result.modelResponses[0].data.metrics[0].value).toBeNull();
  });
});
