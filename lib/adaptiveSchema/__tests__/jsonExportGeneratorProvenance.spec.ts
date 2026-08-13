/**
 * Export Generator Provenance — JSON export contract tests. Confirms
 * `generatedBy` is included in `buildAdaptiveResearchJsonExport()`'s
 * `export` block when present on the frozen record, absent when not (V1
 * compatibility), passes the Zod contract schema, and never leaks a raw
 * uid or unmasked email anywhere in the serialized output.
 */

import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { buildAdaptiveResearchJsonExport, canonicalJsonStringify } from "@/lib/adaptiveSchema/jsonExport";
import { adaptiveResearchJsonExportV1Schema } from "@/lib/adaptiveSchema/jsonExportSchema";

function baseRecord(overrides: Partial<AdaptiveResearchExportV1> = {}): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-prov-1",
    runId: "run-prov-1",
    schemaId: "comparison_matrix",
    schemaFamily: "milestone2",
    schemaVersion: 1,
    reportVersion: 2,
    createdAt: "2026-01-02T00:00:00.000Z",
    createdBy: "uid-should-never-appear-in-json",
    format: "json",
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
    reportSnapshot: {
      question: "Compare two models.",
      models: [{ modelId: "chatgpt" as any, ok: true }],
      reportTypeLabel: "Comparison Report",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-01-01T00:00:00.000Z",
      milestone2: { schemaId: "comparison_matrix", result: {}, meta: {} as any },
    },
    exportMetadata: {
      exportId: "exp-prov-1",
      runId: "run-prov-1",
      schemaVersion: 1,
      exportedSections: ["reportSnapshot.milestone2"],
      createdAt: "2026-01-02T00:00:00.000Z",
      requestingUser: "uid-should-never-appear-in-json",
      finalReportVersion: 2,
    },
    ...overrides,
  };
}

describe("buildAdaptiveResearchJsonExport — generator provenance", () => {
  it("includes generatedBy in the export block when present on the frozen record", () => {
    const record = baseRecord({ generatedBy: { displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" } });
    const json = buildAdaptiveResearchJsonExport(record);
    expect(json.export.generatedBy).toEqual({ displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" });
  });

  it("V1 compatibility: omits generatedBy entirely (never fabricates it) for a record that predates this feature", () => {
    const record = baseRecord(); // no generatedBy override — key genuinely absent
    const json = buildAdaptiveResearchJsonExport(record);
    expect(json.export).not.toHaveProperty("generatedBy");
  });

  it("passes the Zod contract schema with generatedBy present", () => {
    const record = baseRecord({ generatedBy: { displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" } });
    const json = buildAdaptiveResearchJsonExport(record);
    expect(() => adaptiveResearchJsonExportV1Schema.parse(json)).not.toThrow();
  });

  it("passes the Zod contract schema with generatedBy absent (V1 record)", () => {
    const record = baseRecord();
    const json = buildAdaptiveResearchJsonExport(record);
    expect(() => adaptiveResearchJsonExportV1Schema.parse(json)).not.toThrow();
  });

  it("handles a null maskedEmail (account has no email on file) without throwing, schema still passes", () => {
    const record = baseRecord({ generatedBy: { displayName: "ConvergePanel user", maskedEmail: null } });
    const json = buildAdaptiveResearchJsonExport(record);
    expect(json.export.generatedBy).toEqual({ displayName: "ConvergePanel user", maskedEmail: null });
    expect(() => adaptiveResearchJsonExportV1Schema.parse(json)).not.toThrow();
  });

  it("privacy: the raw uid (createdBy/requestingUser) never appears anywhere in the canonical serialized JSON output, even though generatedBy is present", () => {
    const record = baseRecord({ generatedBy: { displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" } });
    const json = buildAdaptiveResearchJsonExport(record);
    const text = canonicalJsonStringify(json);
    expect(text).not.toContain("uid-should-never-appear-in-json");
  });

  it("privacy: the full unmasked email never appears anywhere in the serialized JSON output", () => {
    const record = baseRecord({ generatedBy: { displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" } });
    const json = buildAdaptiveResearchJsonExport(record);
    const text = canonicalJsonStringify(json);
    // The record itself never carries an unmasked email at all (only the
    // already-masked string is ever frozen onto it) — this asserts the
    // masked form is what's present, and that no plausible unmasked local
    // part (the full local-part string before masking) leaked in.
    expect(text).toContain("ya***@gmail.com");
    expect(text).not.toContain("yasinwarsame@gmail.com");
  });
});
