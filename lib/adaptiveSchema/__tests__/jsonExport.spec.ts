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
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";

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

describe("JSON export determinism across the Firestore round-trip (undefined -> null fix)", () => {
  // sanitizeForFirestore recursively converts every `undefined` to `null`
  // (Firestore rejects `undefined` outright) — this is exactly what
  // createAdaptiveExportRecord applies before persisting, and exactly what
  // a record looks like after being read back for regeneration. These
  // tests simulate that real round-trip directly, without needing a real
  // or fake Firestore.
  function roundTrip(record: AdaptiveResearchExportV1): AdaptiveResearchExportV1 {
    return sanitizeForFirestore(record) as AdaptiveResearchExportV1;
  }

  it("MANDATORY (Step 7) — panel.models[].ok undefined at creation time produces byte-identical JSON before and after the Firestore round-trip; this exact test must fail if the fix is reverted", () => {
    const record = comparisonMatrixRecord({
      reportSnapshot: {
        ...comparisonMatrixRecord().reportSnapshot,
        models: [{ modelId: "chatgpt" as any, ok: undefined }, { modelId: "claude" as any, ok: true }],
      },
    });
    const creation = renderAdaptiveResearchJsonV1(record);
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(record));

    expect(Buffer.compare(creation.bytes, regenerated.bytes)).toBe(0);
    expect(creation.sha256).toBe(regenerated.sha256);

    const text = creation.bytes.toString("utf-8");
    expect(text).not.toMatch(/"ok":\s*null/);
    // The genuinely-undefined model's "ok" key is omitted entirely, not merely null.
    const parsed = JSON.parse(text);
    const chatgptEntry = parsed.panel.models.find((m: any) => m.modelId === "chatgpt");
    expect(Object.prototype.hasOwnProperty.call(chatgptEntry, "ok")).toBe(false);
  });

  it("Step 8 — an explicit ok: false survives the round-trip as a real false, never omitted and never coerced to null", () => {
    const record = comparisonMatrixRecord({
      reportSnapshot: {
        ...comparisonMatrixRecord().reportSnapshot,
        models: [{ modelId: "chatgpt" as any, ok: false }],
      },
    });
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(record));
    const parsed = JSON.parse(regenerated.bytes.toString("utf-8"));
    expect(parsed.panel.models[0].ok).toBe(false);
  });

  it("Step 9 — an explicit ok: true survives the round-trip as a real true", () => {
    const record = comparisonMatrixRecord({
      reportSnapshot: {
        ...comparisonMatrixRecord().reportSnapshot,
        models: [{ modelId: "chatgpt" as any, ok: true }],
      },
    });
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(record));
    const parsed = JSON.parse(regenerated.bytes.toString("utf-8"));
    expect(parsed.panel.models[0].ok).toBe(true);
  });

  it("Step 10 — a LEGITIMATE null (legacy governance status, not yet evaluated) is never touched by the fix — remains explicit null after the round-trip, guarding against over-normalization", () => {
    const record = financialValuationRecord();
    const withNullStatus: AdaptiveResearchExportV1 = { ...record, governanceStatusAtExport: { family: "legacy", status: null } };
    const creation = renderAdaptiveResearchJsonV1(withNullStatus);
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(withNullStatus));

    expect(Buffer.compare(creation.bytes, regenerated.bytes)).toBe(0);
    const parsed = JSON.parse(regenerated.bytes.toString("utf-8"));
    expect(parsed.governance).toEqual({ family: "legacy", status: null });
    expect(parsed.provenance.governanceStatusAtExport).toEqual({ family: "legacy", status: null });
  });

  it("milestone2 governance conditions: undefined at creation (kind !== approved_with_conditions) survives the round-trip identically, omitted rather than null", () => {
    const record = comparisonMatrixRecord({ governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false, conditions: undefined } });
    const creation = renderAdaptiveResearchJsonV1(record);
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(record));
    expect(Buffer.compare(creation.bytes, regenerated.bytes)).toBe(0);
    const parsed = JSON.parse(regenerated.bytes.toString("utf-8"));
    expect(Object.prototype.hasOwnProperty.call(parsed.governance, "conditions")).toBe(false);
  });

  it("milestone2 governance conditions: a genuinely present conditions array survives the round-trip as a real array, never dropped", () => {
    const record = comparisonMatrixRecord({ governanceStatusAtExport: { family: "milestone2", kind: "approved_with_conditions", isOwnerOverride: false, conditions: ["Verify pricing before acting on this."] } });
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(record));
    const parsed = JSON.parse(regenerated.bytes.toString("utf-8"));
    expect(parsed.governance.conditions).toEqual(["Verify pricing before acting on this."]);
  });

  it("milestone2 decisionReceipt: undefined at creation survives the round-trip identically, omitted rather than null", () => {
    const record = comparisonMatrixRecord();
    const withoutReceipt: AdaptiveResearchExportV1 = {
      ...record,
      reportSnapshot: { ...record.reportSnapshot, milestone2: { ...record.reportSnapshot.milestone2!, decisionReceipt: undefined } },
    };
    const creation = renderAdaptiveResearchJsonV1(withoutReceipt);
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(withoutReceipt));
    expect(Buffer.compare(creation.bytes, regenerated.bytes)).toBe(0);
    const parsed = JSON.parse(regenerated.bytes.toString("utf-8"));
    expect(Object.prototype.hasOwnProperty.call(parsed.result, "decisionReceipt")).toBe(false);
  });

  it("legacy gate/synthesisReport/trustSummary: undefined at creation survive the round-trip identically, omitted rather than null", () => {
    const record = financialValuationRecord(); // gate/synthesisReport/trustSummary all genuinely absent in this fixture
    const creation = renderAdaptiveResearchJsonV1(record);
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(record));
    expect(Buffer.compare(creation.bytes, regenerated.bytes)).toBe(0);
    const parsed = JSON.parse(regenerated.bytes.toString("utf-8"));
    expect(Object.prototype.hasOwnProperty.call(parsed.result, "gate")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed.result, "synthesisReport")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed.result, "trustSummary")).toBe(false);
  });

  it("Step 11 — a HISTORICAL record already persisted with the drift (ok: null on disk, simulating a pre-fix export) regenerates with ok omitted, exactly as a correct creation would have — the same normalization applies uniformly regardless of input source", () => {
    const record = comparisonMatrixRecord({
      reportSnapshot: {
        ...comparisonMatrixRecord().reportSnapshot,
        // Simulates what's ACTUALLY on disk for a pre-fix historical record: null, not undefined.
        models: [{ modelId: "chatgpt" as any, ok: null as any }, { modelId: "claude" as any, ok: true }],
      },
    });
    const regenerated = renderAdaptiveResearchJsonV1(record); // no roundTrip() needed — already simulating the post-Firestore-read shape directly
    const parsed = JSON.parse(regenerated.bytes.toString("utf-8"));
    const chatgptEntry = parsed.panel.models.find((m: any) => m.modelId === "chatgpt");
    expect(Object.prototype.hasOwnProperty.call(chatgptEntry, "ok")).toBe(false);
  });

  it.each([
    ["financial_valuation", financialValuationRecord],
    ["forecast_speculative", forecastRecord],
    ["creative_generative", creativeGenerativeRecord],
    ["comparison_matrix", comparisonMatrixRecord],
  ])("Step 13 — %s: creation and Firestore-round-trip regeneration are byte-identical for the schema's own real fixture", (_label, buildRecord) => {
    const record = buildRecord();
    const creation = renderAdaptiveResearchJsonV1(record);
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(record));
    expect(Buffer.compare(creation.bytes, regenerated.bytes)).toBe(0);
    expect(creation.sha256).toBe(regenerated.sha256);
  });

  it("final review, Step 3 — legacy.modelResponses[] entries (AdaptiveModelResult) have their OWN optional-not-nullable fields (parseError/truncatedFields/invalidFields/coercions/retried) subject to the identical round-trip drift; these must also survive the round-trip identically, omitted rather than null", () => {
    const record = financialValuationRecord();
    const withUndefinedFields: AdaptiveResearchExportV1 = {
      ...record,
      reportSnapshot: {
        ...record.reportSnapshot,
        legacy: {
          ...record.reportSnapshot.legacy!,
          modelResponses: [
            { ...record.reportSnapshot.legacy!.modelResponses![0], retried: undefined, parseError: undefined, truncatedFields: undefined, invalidFields: undefined, coercions: undefined },
          ],
        },
      },
    };
    const creation = renderAdaptiveResearchJsonV1(withUndefinedFields);
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(withUndefinedFields));
    expect(Buffer.compare(creation.bytes, regenerated.bytes)).toBe(0);
    const parsed = JSON.parse(regenerated.bytes.toString("utf-8"));
    const entry = parsed.result.modelResponses[0];
    for (const key of ["retried", "parseError", "truncatedFields", "invalidFields", "coercions"]) {
      expect(Object.prototype.hasOwnProperty.call(entry, key)).toBe(false);
    }
  });

  it("legacy.modelResponses[].retried: explicit false/true both survive the round-trip as real booleans, never omitted, never coerced to null", () => {
    const record = financialValuationRecord();
    const withBooleans: AdaptiveResearchExportV1 = {
      ...record,
      reportSnapshot: {
        ...record.reportSnapshot,
        legacy: {
          ...record.reportSnapshot.legacy!,
          modelResponses: [
            { ...record.reportSnapshot.legacy!.modelResponses![0], modelId: "chatgpt" as any, retried: false },
            { ...record.reportSnapshot.legacy!.modelResponses![0], modelId: "claude" as any, retried: true },
          ],
        },
      },
    };
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(withBooleans));
    const parsed = JSON.parse(regenerated.bytes.toString("utf-8"));
    expect(parsed.result.modelResponses[0].retried).toBe(false);
    expect(parsed.result.modelResponses[1].retried).toBe(true);
  });

  it("legacy.modelResponses[].data: null is a LEGITIMATE, distinct value in AdaptiveModelResult's own type — must never be touched by this normalization, survives the round-trip as explicit null", () => {
    const record = financialValuationRecord();
    const withNullData: AdaptiveResearchExportV1 = {
      ...record,
      reportSnapshot: {
        ...record.reportSnapshot,
        legacy: {
          ...record.reportSnapshot.legacy!,
          modelResponses: [{ ...record.reportSnapshot.legacy!.modelResponses![0], data: null }],
        },
      },
    };
    const creation = renderAdaptiveResearchJsonV1(withNullData);
    const regenerated = renderAdaptiveResearchJsonV1(roundTrip(withNullData));
    expect(Buffer.compare(creation.bytes, regenerated.bytes)).toBe(0);
    const parsed = JSON.parse(regenerated.bytes.toString("utf-8"));
    expect(parsed.result.modelResponses[0].data).toBeNull();
  });

  it("Milestone-2 Producer Canonicalization, Step 14 — a HISTORICAL milestone2.result already persisted with a pre-fix null (e.g. comparisonAlignment's old consensusValue: undefined -> null drift) passes through this opaque, unvalidated field verbatim: it does not crash, produces valid JSON, and is still self-consistent (same persisted record -> same byte output on every regeneration) — this is the file's own documented, disclosed scope boundary (milestone2.result is intentionally never normalized here; see buildAdaptiveResearchJsonExport's own comment), not a gap introduced by the producer fix. New writes never produce this null in the first place because the producer itself no longer emits the explicit-undefined own-property.", () => {
    const record = comparisonMatrixRecord({
      reportSnapshot: {
        ...comparisonMatrixRecord().reportSnapshot,
        milestone2: {
          ...comparisonMatrixRecord().reportSnapshot.milestone2!,
          result: {
            subjects: ["GPT-5.2"],
            attributes: ["Cost"],
            cells: [{ subject: "GPT-5.2", attribute: "Cost", agreement: "consensus", consensusValue: null }],
            totalModels: 2,
          },
        },
      },
    });
    const first = renderAdaptiveResearchJsonV1(record);
    const second = renderAdaptiveResearchJsonV1(record);
    expect(Buffer.compare(first.bytes, second.bytes)).toBe(0);
    const parsed = JSON.parse(first.bytes.toString("utf-8"));
    expect(parsed.result.result.cells[0].consensusValue).toBeNull();
  });

  it("does not require a formatVersion bump — the public contract shape is unchanged, only which values are present for already-optional fields", () => {
    const record = comparisonMatrixRecord({
      reportSnapshot: {
        ...comparisonMatrixRecord().reportSnapshot,
        models: [{ modelId: "chatgpt" as any, ok: undefined }],
      },
    });
    const parsed = JSON.parse(renderAdaptiveResearchJsonV1(roundTrip(record)).bytes.toString("utf-8"));
    expect(parsed.formatVersion).toBe("1");
    expect(() => adaptiveResearchJsonExportV1Schema.parse(parsed)).not.toThrow();
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

describe("Final review, Step 14 — buildAdaptiveResearchJsonExport (and its determinism-fix helpers) is a pure projection, never mutates the frozen source record", () => {
  it("deep-freezing the entire record before rendering never throws — proves no property of record/reportSnapshot/models/governanceStatusAtExport/legacy/modelResponses is ever assigned to", () => {
    function deepFreeze<T>(obj: T): T {
      if (obj !== null && typeof obj === "object") {
        Object.values(obj as object).forEach(deepFreeze);
        Object.freeze(obj);
      }
      return obj;
    }
    const comparisonRecord = deepFreeze(comparisonMatrixRecord({
      reportSnapshot: {
        ...comparisonMatrixRecord().reportSnapshot,
        models: [{ modelId: "chatgpt" as any, ok: undefined }],
      },
      governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false, conditions: undefined },
    }));
    const legacyRecordSource = financialValuationRecord();
    const legacyRecord = deepFreeze({
      ...legacyRecordSource,
      reportSnapshot: {
        ...legacyRecordSource.reportSnapshot,
        legacy: {
          ...legacyRecordSource.reportSnapshot.legacy!,
          modelResponses: [{ ...legacyRecordSource.reportSnapshot.legacy!.modelResponses![0], retried: undefined }],
        },
      },
    });

    expect(() => renderAdaptiveResearchJsonV1(comparisonRecord)).not.toThrow();
    expect(() => renderAdaptiveResearchJsonV1(legacyRecord)).not.toThrow();
  });

  it("rendering the same record object twice never changes what the SECOND render observes on the source object itself (reference/value stability, not just output stability)", () => {
    const record = comparisonMatrixRecord({
      reportSnapshot: {
        ...comparisonMatrixRecord().reportSnapshot,
        models: [{ modelId: "chatgpt" as any, ok: undefined }, { modelId: "claude" as any, ok: true }],
      },
    });
    const modelsRefBefore = record.reportSnapshot.models;
    const model0Before = record.reportSnapshot.models[0];
    renderAdaptiveResearchJsonV1(record);
    expect(record.reportSnapshot.models).toBe(modelsRefBefore);
    expect(record.reportSnapshot.models[0]).toBe(model0Before);
    expect(record.reportSnapshot.models[0].ok).toBeUndefined(); // still genuinely undefined on the source, never overwritten to omit the key via delete or similar
  });
});
