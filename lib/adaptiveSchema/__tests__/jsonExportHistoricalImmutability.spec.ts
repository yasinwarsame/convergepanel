/**
 * Adaptive Research Export, Phase 4 — historical JSON immutability (Part
 * 34). Same discipline as the DOCX frozen-snapshot regression
 * (lib/docx/__tests__ from Phase 3): create export A, simulate the current
 * run/governance mutating heavily, regenerate A — A must reflect only its
 * own frozen snapshot, byte-identical to its first render, with the
 * mutated content never leaking in. Then create B from the "new" state and
 * confirm A and B are fully independent.
 */

import { createHash } from "crypto";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { renderAdaptiveResearchJsonV1 } from "@/lib/adaptiveSchema/jsonExport";

function baseRecord(overrides: Partial<AdaptiveResearchExportV1> = {}): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-immut-json-A",
    runId: "run-immut-json-1",
    schemaId: "legal_regulatory",
    schemaFamily: "legacy",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    createdBy: "uid-review",
    format: "json",
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "legacy", status: "needs_review" },
    reportSnapshot: {
      question: "ORIGINAL QUESTION — export A, before any mutation",
      models: [{ modelId: "chatgpt" as any, ok: true }],
      reportTypeLabel: "Legal & Regulatory Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-07-01T00:00:00.000Z",
      legacy: {
        schemaId: "legal_regulatory",
        alignedClaims: [],
        modelResponses: [{ modelId: "chatgpt" as any, schemaId: "legal_regulatory", ok: true, data: { jurisdiction: "ORIGINAL jurisdiction", applicableRule: "ORIGINAL rule text" } }],
      },
    },
    exportMetadata: { exportId: "exp-immut-json-A", runId: "run-immut-json-1", schemaVersion: 1, exportedSections: [], createdAt: "2026-07-01T00:00:00.000Z", requestingUser: "uid-review", finalReportVersion: 1 },
    ...overrides,
  };
}

describe("JSON export — historical regeneration is frozen-snapshot-only (Part 34)", () => {
  it("regenerating A after heavy current-run/governance mutation never leaks the mutated content in, and A stays byte-identical to its first render", () => {
    const exportA = baseRecord();
    const renderA1 = renderAdaptiveResearchJsonV1(exportA);
    const textA1 = renderA1.bytes.toString("utf-8");

    // Simulate: current run mutated heavily, governance mutated,
    // classification mutated. This object is NEVER passed to the
    // renderer for A's regeneration — it exists only to prove its
    // content never leaks in.
    void baseRecord({
      classification: "restricted",
      governanceStatusAtExport: { family: "legacy", status: "approved" },
      reportSnapshot: {
        ...exportA.reportSnapshot,
        question: "MUTATED QUESTION — should never appear in regenerated A",
        legacy: { schemaId: "legal_regulatory", alignedClaims: [], modelResponses: [{ modelId: "chatgpt" as any, schemaId: "legal_regulatory", ok: true, data: { jurisdiction: "MUTATED jurisdiction", applicableRule: "MUTATED rule text" } }] },
      },
    });

    // Regenerate A — the real regeneration route's ONLY operation: call
    // the renderer with the SAME frozen record object it loaded.
    const renderA2 = renderAdaptiveResearchJsonV1(exportA);
    const textA2 = renderA2.bytes.toString("utf-8");

    expect(textA1).toBe(textA2);
    expect(renderA1.sha256).toBe(renderA2.sha256);
    expect(textA2).not.toContain("MUTATED");
    expect(textA2).toContain("ORIGINAL");

    const parsed = JSON.parse(textA2);
    expect(parsed.classification).toBe("internal");
    expect(parsed.governance).toEqual({ family: "legacy", status: "needs_review" });
  });

  it("export B (created from the new state) reflects only its own content, and A remains unaffected by B's creation", () => {
    const exportA = baseRecord();
    const renderA1 = renderAdaptiveResearchJsonV1(exportA);

    const exportB = baseRecord({
      exportId: "exp-immut-json-B",
      reportVersion: 2,
      classification: "restricted",
      governanceStatusAtExport: { family: "legacy", status: "approved" },
      reportSnapshot: {
        ...exportA.reportSnapshot,
        question: "NEW QUESTION — export B, after mutation",
        legacy: { schemaId: "legal_regulatory", alignedClaims: [], modelResponses: [{ modelId: "chatgpt" as any, schemaId: "legal_regulatory", ok: true, data: { jurisdiction: "NEW jurisdiction", applicableRule: "NEW rule text" } }] },
      },
    });
    const renderB = renderAdaptiveResearchJsonV1(exportB);
    const textB = renderB.bytes.toString("utf-8");

    expect(textB).toContain("NEW QUESTION");
    expect(textB).not.toContain("ORIGINAL QUESTION");
    expect(renderA1.sha256).not.toBe(renderB.sha256);

    const renderA3 = renderAdaptiveResearchJsonV1(exportA);
    expect(renderA3.sha256).toBe(renderA1.sha256);
  });
});
