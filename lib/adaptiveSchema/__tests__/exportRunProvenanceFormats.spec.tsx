/**
 * Step 6.2b — PDF, DOCX and JSON represent the SAME frozen provenance facts,
 * and a pre-6.2b record (no `runProvenance`) renders no provenance at all.
 *
 * The real PDF composer (react-pdf primitives mocked to string tags, as in the
 * sibling PDF specs), the real DOCX renderer + packer, and the real JSON
 * projection all run on one frozen record.
 */
jest.mock("@react-pdf/renderer", () => ({
  Document: "DOCUMENT",
  Page: "PAGE",
  View: "VIEW",
  Text: "TEXT",
  StyleSheet: { create: (styles: unknown) => styles },
  renderToBuffer: jest.fn(),
}));

import type { AdaptiveResearchExportV1, AdaptiveExportRunProvenance } from "@/lib/adaptiveSchema/researchExport";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { buildAdaptiveResearchJsonExport, canonicalJsonStringify } from "@/lib/adaptiveSchema/jsonExport";
import { adaptiveResearchJsonExportV1Schema } from "@/lib/adaptiveSchema/jsonExportSchema";
import { exportRunProvenanceLines } from "@/lib/adaptiveSchema/exportRunProvenance";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { extractDocxText } from "@/lib/docx/__tests__/testUtils";

const RUN_PROVENANCE: AdaptiveExportRunProvenance = {
  policyVersion: 7,
  models: [
    { modelId: "chatgpt" as never, provider: "openai", requestedModel: "gpt-RUN-1", substituted: false },
    { modelId: "claude" as never, provider: "deepseek", requestedModel: "claude-RUN-1", substituted: true, substitutedFrom: "anthropic:claude-RUN-1" },
    { modelId: "gemini" as never, substituted: false },
    // Unknown substitution state (no persisted status) — must not read as "not substituted".
    { modelId: "grok" as never, provider: "xai", requestedModel: "grok-RUN-1" },
    // Substituted, requestedModel persisted, substitutedFrom not.
    { modelId: "perplexity" as never, provider: "deepseek", requestedModel: "sonar-RUN-1", substituted: true },
  ],
};
const LINES = exportRunProvenanceLines(RUN_PROVENANCE);

function record(runProvenance?: unknown, format: "pdf" | "docx" | "json" = "pdf"): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-62b",
    runId: "run-62b",
    schemaId: "comparison_matrix",
    schemaFamily: "milestone2",
    schemaVersion: 1,
    reportVersion: 3,
    createdAt: "2026-10-08T00:00:00.000Z",
    createdBy: "uid-never-rendered",
    format,
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
    reportSnapshot: {
      question: "Which?",
      models: [{ modelId: "chatgpt" as never, ok: true }, { modelId: "claude" as never, ok: true }, { modelId: "gemini" as never, ok: true }],
      reportTypeLabel: "Comparison Report",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-07T00:00:00.000Z",
      ...(runProvenance === undefined ? {} : { runProvenance: runProvenance as AdaptiveExportRunProvenance }),
      milestone2: { schemaId: "comparison_matrix", result: { subjects: [], attributes: [], cells: [] }, meta: {} as never },
    },
    exportMetadata: {
      exportId: "exp-62b",
      runId: "run-62b",
      schemaVersion: 1,
      exportedSections: ["reportSnapshot.milestone2"],
      createdAt: "2026-10-08T00:00:00.000Z",
      requestingUser: "uid-never-rendered",
      finalReportVersion: 3,
    },
  };
}

const pdfText = (r: AdaptiveResearchExportV1) => extractPdfElementText(AdaptiveResearchDocument({ record: r }));
const docxText = async (r: AdaptiveResearchExportV1) => extractDocxText((await renderAdaptiveResearchDocxV1(r)).bytes);
const jsonOf = (r: AdaptiveResearchExportV1) => buildAdaptiveResearchJsonExport(r);

describe("a 6.2b record: the same facts in every format", () => {
  it("PDF carries every provenance line", () => {
    const text = pdfText(record(RUN_PROVENANCE));
    expect(text).toContain("Run provenance");
    for (const line of LINES) expect(text).toContain(line);
  });

  it("DOCX carries every provenance line", async () => {
    const text = await docxText(record(RUN_PROVENANCE, "docx"));
    expect(text).toContain("Run provenance");
    for (const line of LINES) expect(text).toContain(line);
  });

  it("JSON carries the same facts structurally, valid against the public schema, and they read back to the same lines", () => {
    const json = jsonOf(record(RUN_PROVENANCE, "json"));
    expect(json.provenance.run).toEqual(RUN_PROVENANCE);
    expect(adaptiveResearchJsonExportV1Schema.safeParse(json).success).toBe(true);
    expect(exportRunProvenanceLines(json.provenance.run!)).toEqual(LINES);
  });

  it("the unknown-substitution and partial-substitution facts read identically in every format", async () => {
    const unknown = LINES.find((l) => l.startsWith("Model (grok)"))!;
    const partial = LINES.find((l) => l.startsWith("Substitution (perplexity)"))!;
    expect(unknown).toContain("substitution not recorded");
    expect(partial).toContain("requested sonar-RUN-1 (original provider not recorded)");
    for (const text of [pdfText(record(RUN_PROVENANCE)), await docxText(record(RUN_PROVENANCE, "docx"))]) {
      expect(text).toContain(unknown);
      expect(text).toContain(partial);
    }
    const run = jsonOf(record(RUN_PROVENANCE, "json")).provenance.run!;
    expect("substituted" in run.models.find((m) => m.modelId === "grok")!).toBe(false);
    expect(run.models.find((m) => m.modelId === "perplexity")).toEqual({ modelId: "perplexity", provider: "deepseek", requestedModel: "sonar-RUN-1", substituted: true });
  });

  it("creation and Firestore-regeneration JSON are byte-identical", () => {
    const created = canonicalJsonStringify(jsonOf(record(RUN_PROVENANCE, "json")));
    const roundTripped = sanitizeForFirestore(JSON.parse(JSON.stringify(record(RUN_PROVENANCE, "json")))) as AdaptiveResearchExportV1;
    expect(canonicalJsonStringify(jsonOf(roundTripped))).toBe(created);
  });

  it("no format says verified, trusted, attested or actual model", async () => {
    const all = [pdfText(record(RUN_PROVENANCE)), await docxText(record(RUN_PROVENANCE, "docx")), JSON.stringify(jsonOf(record(RUN_PROVENANCE, "json")).provenance)].join("\n").toLowerCase();
    expect(all).not.toMatch(/verified model|trusted provider|attested|actualmodel|actual model/);
  });
});

describe("a pre-6.2b record: nothing synthesized, renders as before", () => {
  it.each([
    ["absent", undefined],
    ["Firestore null", null],
  ])("runProvenance %s → no provenance block in PDF, DOCX or JSON", async (_label, value) => {
    expect(pdfText(record(value))).not.toContain("Run provenance");
    expect(pdfText(record(value))).not.toContain("Policy:");
    const docx = await docxText(record(value, "docx"));
    expect(docx).not.toContain("Run provenance");
    expect(docx).not.toContain("Policy:");
    const json = jsonOf(record(value, "json"));
    expect("run" in json.provenance).toBe(false);
    expect(adaptiveResearchJsonExportV1Schema.safeParse(json).success).toBe(true);
  });

  it("a pre-6.2b record's JSON provenance gains no new key", () => {
    const json = jsonOf(record(undefined, "json"));
    expect(Object.keys(json.provenance).sort()).toEqual(
      ["classification", "contractVersion", "exportId", "exportedAt", "generatedAt", "governanceStatusAtExport", "models", "reportVersion", "runId", "schemaFamily", "schemaId", "schemaVersion"].sort()
    );
  });
});
