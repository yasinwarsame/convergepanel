/**
 * Adaptive Research Export, Phase 3 — DOCX package security (Part 17).
 * A .docx is a ZIP container; this test unpacks a REAL generated package
 * (the same renderer production uses, not a stub) and structurally
 * verifies it contains only the expected Office Open XML parts, with no
 * macros, no external relationships, no embedded executable content, and
 * no unexpected custom XML that could carry private data out-of-band from
 * the rendered text itself.
 */

import JSZip from "jszip";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";

function record(): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-security-1",
    runId: "run-security-1",
    schemaId: "legal_regulatory",
    schemaFamily: "legacy",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "uid-test",
    format: "docx",
    artifactStatus: "ready",
    classification: "confidential",
    governanceStatusAtExport: { family: "legacy", status: "approved" },
    reportSnapshot: {
      question: "Security fixture question.",
      models: [{ modelId: "chatgpt" as any, ok: true }],
      reportTypeLabel: "Legal & Regulatory Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-01-01T00:00:00.000Z",
      legacy: {
        schemaId: "legal_regulatory",
        alignedClaims: [],
        modelResponses: [
          {
            modelId: "chatgpt" as any,
            schemaId: "legal_regulatory",
            ok: true,
            data: {
              unsettledIssues: [
                { id: "x", claim: "Some claim", stance: "disputes", confidence: "contested", evidenceType: "authoritative", camps: [{ label: "A", position: "pos A" }] },
              ],
            },
          },
        ],
      },
    },
    exportMetadata: { exportId: "exp-security-1", runId: "run-security-1", schemaVersion: 1, exportedSections: [], createdAt: "2026-01-01T00:00:00.000Z", requestingUser: "uid-test", finalReportVersion: 1 },
  };
}

describe("DOCX package security (Part 17)", () => {
  it("contains only expected Office Open XML parts — no macros, no media, no embedded binaries", async () => {
    const rendered = await renderAdaptiveResearchDocxV1(record());
    const zip = await JSZip.loadAsync(rendered.bytes);
    const names = Object.keys(zip.files);

    // No VBA project (macro-enabled documents are .docm, never produced here).
    expect(names.some((n) => n.toLowerCase().includes("vbaproject"))).toBe(false);
    // No embedded media (this composer never uses ImageRun).
    expect(names.some((n) => n.startsWith("word/media/"))).toBe(false);
    expect(names.some((n) => n.startsWith("word/embeddings/"))).toBe(false);
    // No arbitrary binary parts of any kind.
    expect(names.some((n) => n.endsWith(".bin"))).toBe(false);
    // No custom XML parts (a common place unexpected/private out-of-band data could hide).
    expect(names.some((n) => n.startsWith("customXml/"))).toBe(false);

    // Every part is a real, known Office Open XML member — nothing unaccounted for.
    const allowed = /^(\[Content_Types\]\.xml|_rels\/|docProps\/|word\/)/;
    for (const name of names) {
      if (zip.files[name].dir) continue;
      expect(name).toMatch(allowed);
    }
  });

  it("contains no external relationships — every .rels file's targets are internal package parts, never a remote URL", async () => {
    const rendered = await renderAdaptiveResearchDocxV1(record());
    const zip = await JSZip.loadAsync(rendered.bytes);

    const relsFiles = Object.keys(zip.files).filter((n) => n.endsWith(".rels"));
    expect(relsFiles.length).toBeGreaterThan(0);

    for (const relsPath of relsFiles) {
      const xml = await zip.files[relsPath].async("string");
      // TargetMode="External" is exactly how OOXML marks a relationship
      // that points outside the package (e.g. a hyperlink to a website) —
      // this composer never creates one (no Hyperlink/ExternalHyperlink
      // elements anywhere in AdaptiveResearchDocxDocument.ts).
      expect(xml).not.toMatch(/TargetMode\s*=\s*"External"/);
      // Every Relationship's Target must be an internal, relative package
      // path (e.g. "styles.xml") — never an absolute URL. This check is
      // deliberately scoped to `Target="..."` attribute VALUES only —
      // `Type="http://schemas.openxmlformats.org/..."` attributes are
      // static, standard OOXML namespace identifiers on every part
      // relationship (styles/numbering/fontTable/etc.) and are not actual
      // remote references; asserting against the whole XML string would
      // false-positive on every single valid .docx ever produced.
      const targetValues = [...xml.matchAll(/\bTarget="([^"]*)"/g)].map((m) => m[1]);
      for (const target of targetValues) {
        expect(target).not.toMatch(/^https?:\/\//);
      }
    }
  });

  it("word/document.xml contains no macro/script/active-content markers", async () => {
    const rendered = await renderAdaptiveResearchDocxV1(record());
    const zip = await JSZip.loadAsync(rendered.bytes);
    const doc = await zip.files["word/document.xml"].async("string");

    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/vbaProject/i);
    expect(doc).not.toMatch(/ActiveX/i);
    expect(doc).not.toMatch(/oleObject/i);
  });

  it("never leaks a private reviewer comment field — the composer has no comment-rendering code path (word/comments.xml is a static empty template part, never populated from report data)", async () => {
    const rendered = await renderAdaptiveResearchDocxV1(record());
    const zip = await JSZip.loadAsync(rendered.bytes);
    const comments = await zip.files["word/comments.xml"].async("string");
    expect(comments).not.toMatch(/reviewer comment/i);
    // The comments part exists (docx's default template always includes
    // one) but must carry no actual <w:comment> content.
    expect(comments).not.toMatch(/<w:comment[ >]/);
  });

  it("HTML/script content in model output renders as literal text — DOCX's TextRun never interprets its children as markup, matching the PDF composer's own security guarantee", async () => {
    const injected = record();
    (injected.reportSnapshot.legacy!.modelResponses![0].data as any).unsettledIssues[0].claim = "<script>alert(1)</script>";
    const rendered = await renderAdaptiveResearchDocxV1(injected);
    const zip = await JSZip.loadAsync(rendered.bytes);
    const doc = await zip.files["word/document.xml"].async("string");
    // OOXML escapes '<' as '&lt;' inside text runs — the literal string
    // still exists, just safely escaped, never interpreted as a real tag.
    expect(doc).toContain("alert(1)");
    expect(doc).not.toMatch(/<script>/);
  });
});
