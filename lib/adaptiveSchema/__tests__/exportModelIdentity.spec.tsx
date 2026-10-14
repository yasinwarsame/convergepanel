/**
 * Model-identity PR A — PDF and DOCX name every model by the provenance FROZEN
 * in the export, never by a current product label.
 *
 * Reproduces the incident export: its header said "GPT 5.2 / Claude Opus 4.5 /
 * Grok 4 / Perplexity Pro / Gemini 2.0 Flash" while its own frozen provenance
 * recorded gpt-4o-mini / claude-haiku-4-5-20251001 / grok-4-1-fast-reasoning /
 * perplexity/sonar / gemini-2.0-flash. The real PDF composer (react-pdf
 * primitives mocked to string tags, as in the sibling PDF specs) and the real
 * DOCX renderer + packer run on the same records.
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
import { exportModelIdentityLabel } from "@/lib/adaptiveSchema/exportRunProvenance";
import { PANEL_MODELS } from "@/lib/panelModels";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { extractDocxText } from "@/lib/docx/__tests__/testUtils";

const SLOTS = ["chatgpt", "claude", "grok", "perplexity", "gemini"] as const;
const PRODUCT_LABELS = ["GPT 5.2", "Claude Opus 4.5", "Grok 4", "Perplexity Pro", "Gemini 2.0 Flash", "Gemini 3 Pro", "GPT-4o"];

const INCIDENT_PROVENANCE: AdaptiveExportRunProvenance = {
  policyVersion: 2,
  models: [
    { modelId: "chatgpt" as never, provider: "openai", requestedModel: "gpt-4o-mini", substituted: false },
    { modelId: "claude" as never, provider: "anthropic", requestedModel: "claude-haiku-4-5-20251001", substituted: false },
    { modelId: "grok" as never, provider: "xai", requestedModel: "grok-4-1-fast-reasoning", substituted: false },
    { modelId: "perplexity" as never, provider: "perplexity", requestedModel: "perplexity/sonar", substituted: false },
    { modelId: "gemini" as never, provider: "google", requestedModel: "gemini-2.0-flash", substituted: false },
  ],
};
const INCIDENT_LABELS = [
  "ChatGPT · requested: gpt-4o-mini",
  "Claude · requested: claude-haiku-4-5-20251001",
  "Grok · requested: grok-4-1-fast-reasoning",
  "Perplexity · requested: perplexity/sonar",
  "Gemini · requested: gemini-2.0-flash",
];

/** A legacy-family record: it carries both model-naming positions (the Models summary and each model's response heading). */
function record(runProvenance: unknown, format: "pdf" | "docx" = "pdf"): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-mip",
    runId: "run-mip",
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-10-14T00:00:00.000Z",
    createdBy: "uid-never-rendered",
    format,
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "legacy", status: "needs_review" },
    reportSnapshot: {
      question: "Q?",
      models: SLOTS.map((id) => ({ modelId: id as never, ok: true })),
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "weak",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-10-13T00:00:00.000Z",
      ...(runProvenance === undefined ? {} : { runProvenance: runProvenance as AdaptiveExportRunProvenance }),
      legacy: {
        schemaId: "financial_valuation",
        alignedClaims: [],
        modelResponses: SLOTS.map((id) => ({ modelId: id as never, schemaId: "financial_valuation" as never, ok: true, data: { thesis: `${id}-thesis` } })),
      },
    },
    exportMetadata: {
      exportId: "exp-mip",
      runId: "run-mip",
      schemaVersion: 1,
      exportedSections: ["reportSnapshot.legacy"],
      createdAt: "2026-10-14T00:00:00.000Z",
      requestingUser: "uid-never-rendered",
      finalReportVersion: 1,
    },
  } as AdaptiveResearchExportV1;
}

const pdfText = (r: AdaptiveResearchExportV1) => extractPdfElementText(AdaptiveResearchDocument({ record: r }));
const docxText = async (r: AdaptiveResearchExportV1) => extractDocxText((await renderAdaptiveResearchDocxV1(r)).bytes);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("the incident export: frozen requested models, not product labels", () => {
  it("PDF names each slot by its frozen requested model in BOTH positions (summary + response heading)", () => {
    const text = pdfText(record(INCIDENT_PROVENANCE));
    for (const label of INCIDENT_LABELS) expect(count(text, label)).toBe(2);
    for (const label of PRODUCT_LABELS) expect(text).not.toContain(label);
  });

  it("DOCX names each slot identically to the PDF", async () => {
    const text = await docxText(record(INCIDENT_PROVENANCE, "docx"));
    for (const label of INCIDENT_LABELS) expect(count(text, label)).toBe(2);
    for (const label of PRODUCT_LABELS) expect(text).not.toContain(label);
  });

  it("PDF and DOCX derive from the one shared label function", () => {
    expect(SLOTS.map((id) => exportModelIdentityLabel(INCIDENT_PROVENANCE, id))).toEqual(INCIDENT_LABELS);
  });

  it("neither format calls the requested model actual, verified, confirmed or attested", async () => {
    const all = `${pdfText(record(INCIDENT_PROVENANCE))}\n${await docxText(record(INCIDENT_PROVENANCE, "docx"))}`.toLowerCase();
    expect(all).not.toMatch(/actual model|verified model|confirmed by|attested/);
  });
});

describe("a pre-6.2b export (no frozen provenance) says 'model not recorded' — never a guessed model", () => {
  it.each([
    ["absent", undefined],
    ["Firestore null", null],
    ["malformed", { models: "nope" }],
  ])("runProvenance %s", async (_label, value) => {
    const expected = ["ChatGPT", "Claude", "Grok", "Perplexity", "Gemini"].map((f) => `${f} · model not recorded`);
    for (const text of [pdfText(record(value)), await docxText(record(value, "docx"))]) {
      for (const label of expected) expect(count(text, label)).toBe(2);
      for (const label of PRODUCT_LABELS) expect(text).not.toContain(label);
      expect(text).not.toMatch(/requested: /);
    }
  });

  it("a frozen entry lacking requestedModel stays not recorded while its siblings keep theirs", async () => {
    const partial: AdaptiveExportRunProvenance = { models: [INCIDENT_PROVENANCE.models[0], { modelId: "claude" as never, provider: "anthropic", substituted: false }] };
    for (const text of [pdfText(record(partial)), await docxText(record(partial, "docx"))]) {
      expect(text).toContain("ChatGPT · requested: gpt-4o-mini");
      expect(text).toContain("Claude · model not recorded");
      expect(text).toContain("Grok · model not recorded");
      expect(text).not.toContain("Claude · requested:");
    }
  });
});

describe("substitution in exports", () => {
  const SUBSTITUTED: AdaptiveExportRunProvenance = {
    models: [
      { modelId: "chatgpt" as never, provider: "openai", requestedModel: "gpt-4o-mini", substituted: false },
      { modelId: "claude" as never, provider: "deepseek", requestedModel: "claude-haiku-4-5-20251001", substituted: true, substitutedFrom: "anthropic:claude-haiku-4-5-20251001" },
      { modelId: "grok" as never, substituted: true },
    ],
  };
  it("a recorded substitution names the requested model and the answering provider; a bare one names neither", async () => {
    for (const text of [pdfText(record(SUBSTITUTED)), await docxText(record(SUBSTITUTED, "docx"))]) {
      expect(text).toContain("ChatGPT · requested: gpt-4o-mini");
      expect(text).not.toContain("ChatGPT · requested: gpt-4o-mini · substituted");
      expect(text).toContain("Claude · requested: claude-haiku-4-5-20251001 · substituted, answered by: DeepSeek");
      expect(text).toContain("Grok · model not recorded · substituted, answered by: provider not recorded");
    }
  });
});

describe("frozen history: regeneration does not move with current configuration", () => {
  it("renaming every product label leaves PDF and DOCX byte-for-byte text-identical", async () => {
    const pdfBefore = pdfText(record(INCIDENT_PROVENANCE));
    const docxBefore = await docxText(record(INCIDENT_PROVENANCE, "docx"));
    const saved = PANEL_MODELS.map((m) => m.label);
    try {
      PANEL_MODELS.forEach((m) => {
        (m as { label: string }).label = `RENAMED-${m.id}-9.9`;
      });
      expect(pdfText(record(INCIDENT_PROVENANCE))).toBe(pdfBefore);
      expect(await docxText(record(INCIDENT_PROVENANCE, "docx"))).toBe(docxBefore);
    } finally {
      PANEL_MODELS.forEach((m, i) => {
        (m as { label: string }).label = saved[i];
      });
    }
  });

  it("changing the active model configuration leaves the export identical", async () => {
    const pdfBefore = pdfText(record(INCIDENT_PROVENANCE));
    const prev = { g: process.env.GROK_MODEL, p: process.env.PERPLEXITY_AGENT_MODEL };
    try {
      process.env.GROK_MODEL = "grok-CHANGED-LATER";
      process.env.PERPLEXITY_AGENT_MODEL = "perplexity/CHANGED-LATER";
      const after = pdfText(record(INCIDENT_PROVENANCE));
      expect(after).toBe(pdfBefore);
      expect(after).not.toContain("CHANGED-LATER");
    } finally {
      if (prev.g === undefined) delete process.env.GROK_MODEL;
      else process.env.GROK_MODEL = prev.g;
      if (prev.p === undefined) delete process.env.PERPLEXITY_AGENT_MODEL;
      else process.env.PERPLEXITY_AGENT_MODEL = prev.p;
    }
  });

  it("regenerating the same frozen record is deterministic", async () => {
    expect(pdfText(record(INCIDENT_PROVENANCE))).toBe(pdfText(record(INCIDENT_PROVENANCE)));
    expect(await docxText(record(INCIDENT_PROVENANCE, "docx"))).toBe(await docxText(record(INCIDENT_PROVENANCE, "docx")));
  });
});
