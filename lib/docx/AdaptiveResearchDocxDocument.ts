/**
 * Adaptive Research Export, Phase 3 — the DOCX document composer.
 * Generates a .docx from the exact same frozen `AdaptiveResearchExportV1`
 * snapshot the PDF composer (`lib/pdf/AdaptiveResearchDocument.tsx`) uses
 * — same section structure, same semantic derivations (imported from the
 * shared `lib/adaptiveSchema/exportContentDerivation.ts` module, never
 * re-implemented here), same label constants
 * (`CONSENSUS_LABELS`/`SOURCE_GROUNDING_LABELS`). DOCX does not aim for
 * pixel parity with PDF (Part 5) — it aims for the same information
 * hierarchy, using the docx library's own primitives (headings, tables,
 * bullet paragraphs) instead of react-pdf's flex layout.
 *
 * Deliberately never uses `Hyperlink`/`ExternalHyperlink`/`Bookmark` —
 * those trigger the `docx` library's internal `nanoid()`-based relationship
 * ID generation, a genuine, unavoidable source of document.xml-level
 * non-determinism this composer has no need to introduce (see
 * `renderAdaptiveResearchDocx.ts`'s own determinism doc comment for the
 * full account of what IS and is not deterministic about this format).
 * Also never uses `ImageRun` — no remote or embedded images anywhere in
 * this export, consistent with "does not fetch remote fonts/assets at
 * runtime."
 */

import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { CONSENSUS_LABELS, SOURCE_GROUNDING_LABELS } from "@/lib/adaptiveSchema/reportSummary";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { FieldSpec } from "@/lib/adaptiveSchema/types";
import { getModelDisplayNameSafe } from "@/lib/panelModels";
import {
  fieldLabel,
  formatExportTimestamp,
  formatNestedFieldValue,
  governanceStatusDisplay,
  GovernanceDisplayTone,
} from "@/lib/adaptiveSchema/exportContentDerivation";

const COLOR = {
  text: "18181B",
  muted: "65656E",
  border: "D9D9D9",
  brand: "2563EB",
  success: "1F7A3D",
  warning: "B7791F",
  danger: "B91C1C",
  neutral: "65656E",
};

function toneColor(tone: GovernanceDisplayTone): string {
  switch (tone) {
    case "success":
      return COLOR.success;
    case "warning":
      return COLOR.warning;
    case "danger":
      return COLOR.danger;
    default:
      return COLOR.neutral;
  }
}

function heading(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } });
}

/**
 * Splits on embedded `\n` and renders each line as its own TextRun with a
 * line break before it — OOXML text runs (unlike react-pdf's `<Text>`,
 * confirmed via a real rendered preview during development) do NOT treat
 * `\n` inside a string as a line break; without this, a model's own
 * multi-line output (e.g. a numbered list embedded in one `output`
 * string field) silently collapses into one unbroken run-on sentence.
 * Every caller that renders a raw, potentially multi-line model-supplied
 * string goes through this — never a bare single TextRun.
 */
function multilineRuns(text: string, props: { color: string; size?: number }): TextRun[] {
  const lines = text.split("\n");
  return lines.map((line, i) => new TextRun({ text: line, color: props.color, size: props.size, break: i > 0 ? 1 : undefined }));
}

function body(text: string): Paragraph {
  return new Paragraph({ children: multilineRuns(text, { color: COLOR.text }), spacing: { after: 80 } });
}

function muted(text: string): Paragraph {
  return new Paragraph({ children: multilineRuns(text, { color: COLOR.muted, size: 18 }), spacing: { after: 80 } });
}

function bullet(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text: `•  ${text}`, color: COLOR.text })], spacing: { after: 40 }, indent: { left: 260 } });
}

function bulletList(items: string[]): Paragraph[] {
  return items.map(bullet);
}

/**
 * Label:value metadata pairs (cover header / provenance) — deliberately
 * plain stacked paragraphs, not a Table. A borderless table needs explicit
 * per-column DXA widths and `layout: FIXED` to render correctly; without
 * both, Word's "autofit" default collapses columns to near-zero width and
 * wraps every word one character per line (confirmed via a real rendered
 * preview during composer development — see the fixed `metricTable` below
 * for the pattern this data genuinely doesn't need). This metadata is a
 * definition list, not tabular data, so paragraphs are both simpler and
 * safer than fighting table layout for content that was never meant to be
 * read across columns anyway (Part 5 — DOCX doesn't need PDF's exact
 * layout, only its information hierarchy).
 */
function fieldGrid(pairs: [string, string][]): Paragraph[] {
  return pairs.flatMap(([label, value]) => [
    new Paragraph({ children: [new TextRun({ text: label.toUpperCase(), color: COLOR.muted, size: 15, bold: true })], spacing: { before: 60 } }),
    new Paragraph({ children: [new TextRun({ text: value, color: COLOR.text })], spacing: { after: 20 } }),
  ]);
}

// ─── Cover / status ─────────────────────────────────────────────────────

function coverSection(record: AdaptiveResearchExportV1): (Paragraph | Table)[] {
  const snapshot = record.reportSnapshot;
  const status = governanceStatusDisplay(record);
  return [
    new Paragraph({
      children: [
        new TextRun({ text: "ConvergePanel", bold: true, color: COLOR.brand, size: 24 }),
        new TextRun({ text: `   ${status.label}`, bold: true, color: toneColor(status.tone), size: 18 }),
      ],
      spacing: { after: 40 },
    }),
    new Paragraph({ children: [new TextRun({ text: "RESEARCH · VERIFY · GOVERN", color: COLOR.muted, size: 14 })], spacing: { after: 160 } }),
    new Paragraph({ text: snapshot.reportTypeLabel, heading: HeadingLevel.HEADING_1, spacing: { after: 40 } }),
    new Paragraph({ children: [new TextRun({ text: snapshot.question, color: COLOR.muted })], spacing: { after: 160 } }),
    ...fieldGrid([
      ["Report generated", formatExportTimestamp(snapshot.reportGeneratedAt)],
      ["Export generated", formatExportTimestamp(record.createdAt)],
      ["Report version", `v${record.reportVersion}`],
      ["Export ID", record.exportId],
      // Export Generator Provenance — absent (never fabricated) for any
      // export created before this feature shipped; the historical record
      // simply has no `generatedBy` key.
      ...(record.generatedBy?.displayName ? ([["Generated by", record.generatedBy.displayName]] as [string, string][]) : []),
      ...(record.generatedBy?.maskedEmail ? ([["Email", record.generatedBy.maskedEmail]] as [string, string][]) : []),
    ]),
    new Paragraph({ text: "", spacing: { after: 120 } }),
  ];
}

function statusSummarySection(record: AdaptiveResearchExportV1): (Paragraph | Table)[] {
  const snapshot = record.reportSnapshot;
  const modelsText = snapshot.models.map((m) => `${getModelDisplayNameSafe(m.modelId)}${m.ok === false ? " (failed)" : ""}`).join(", ");
  return [
    heading("Report status summary"),
    ...fieldGrid([
      ["Models", modelsText || "—"],
      ["Consensus", CONSENSUS_LABELS[snapshot.consensusLevel]],
      ["Source grounding", SOURCE_GROUNDING_LABELS[snapshot.sourceGroundingLevel]],
    ]),
    // Part 8 — same non-negotiable safeguard disclaimer as PDF: never let a
    // consensus/grounding label be read as factual correctness or evidence
    // strength.
    muted("Consensus reflects panel agreement, not factual correctness. Source grounding reflects citation coverage, not evidence strength."),
  ];
}

// ─── Milestone-2 primary content ───────────────────────────────────────

function milestone2Section(record: AdaptiveResearchExportV1): (Paragraph | Table)[] {
  const m2 = record.reportSnapshot.milestone2!;
  if (!m2.decisionReceipt) {
    return [heading("Primary synthesis"), muted("No governance record exists yet for this run, so no reviewed conclusion has been composed. The report has not been reviewed.")];
  }
  const r = m2.decisionReceipt;
  const out: (Paragraph | Table)[] = [heading("Conclusion"), body(r.conclusion)];
  if (r.basis.length > 0) out.push(heading("Basis"), ...bulletList(r.basis));
  if (r.assumptions.length > 0) out.push(heading("Assumptions"), ...bulletList(r.assumptions));
  if (r.uncertainties.length > 0) out.push(heading("Uncertainties"), ...bulletList(r.uncertainties));
  if (r.limitations.length > 0) out.push(heading("Limitations"), ...bulletList(r.limitations));
  if (r.sources.length > 0) out.push(heading("Sources"), ...bulletList(r.sources));

  if (m2.schemaId === "comparison_matrix") {
    const result = m2.result as { tradeoffs?: string[]; bestUseRecommendations?: string[] };
    if (Array.isArray(result?.tradeoffs) && result.tradeoffs.length > 0) out.push(heading("Trade-offs"), ...bulletList(result.tradeoffs));
    if (Array.isArray(result?.bestUseRecommendations) && result.bestUseRecommendations.length > 0)
      out.push(heading("Best-use recommendations"), ...bulletList(result.bestUseRecommendations));
  }
  return out;
}

// ─── Legacy-active primary content ─────────────────────────────────────

/**
 * metric[] gets a real DOCX table (Part 7 — financial_valuation is the
 * flagship example) — one table per model's own metrics, never a
 * merged/averaged cross-model row. `layout: FIXED` + explicit per-column
 * DXA widths are both required: without them, Word's "autofit" default
 * collapses every column to a near-zero width and wraps text one
 * character per line (confirmed via a real rendered preview — see
 * `fieldGrid`'s own doc comment for the full account). Total width here
 * (1600+1600+1200+1600+3360 = 9360 DXA) matches a standard US Letter page's
 * content width at 1" margins, so the table fits the page exactly rather
 * than overflowing or leaving a visibly incomplete right edge.
 */
const METRIC_COLUMN_WIDTHS = [1600, 1600, 1200, 1600, 3360];

function metricTable(items: Record<string, unknown>[]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: ["Metric", "Value", "Unit", "As of", "Source"].map(
      (h, i) =>
        new TableCell({
          width: { size: METRIC_COLUMN_WIDTHS[i], type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: "F1F1F1" },
          verticalAlign: VerticalAlign.CENTER,
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 16 })] })],
        })
    ),
  });
  const rows = items.map(
    (item) =>
      new TableRow({
        children: [String(item.label ?? ""), item.value != null ? String(item.value) : "—", String(item.unit ?? ""), String(item.asOf ?? ""), String(item.source ?? "")].map(
          (v, i) =>
            new TableCell({
              width: { size: METRIC_COLUMN_WIDTHS[i], type: WidthType.DXA },
              verticalAlign: VerticalAlign.CENTER,
              children: [new Paragraph({ children: [new TextRun({ text: v, size: 18 })] })],
            })
        ),
      })
  );
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: METRIC_COLUMN_WIDTHS,
    layout: TableLayoutType.FIXED,
    rows: [headerRow, ...rows],
  });
}

/** Generic fallback for any other array-of-object field — key: value paragraphs, matching the PDF composer's own GenericObjectArrayPdf (same shared `formatNestedFieldValue`, so "[object Object]" can never leak here either). */
function genericObjectArray(items: Record<string, unknown>[]): Paragraph[] {
  return items.flatMap((item) =>
    Object.entries(item).map(
      ([k, v]) =>
        new Paragraph({
          children: [new TextRun({ text: `${k}: `, bold: true, color: COLOR.muted, size: 18 }), new TextRun({ text: formatNestedFieldValue(v), color: COLOR.muted, size: 18 })],
          spacing: { after: 20 },
        })
    )
  );
}

function fieldValueDocx(field: FieldSpec, value: unknown): (Paragraph | Table)[] {
  if (value == null) return [];
  if (field.type === "string") {
    if (typeof value !== "string" || value.trim().length === 0) return [];
    return [body(value)];
  }
  if (field.type === "string[]") {
    return Array.isArray(value) && value.length > 0 ? bulletList(value as string[]) : [];
  }
  if (Array.isArray(value) && value.length > 0) {
    if (field.type === "metric[]") return [metricTable(value as Record<string, unknown>[])];
    return genericObjectArray(value as Record<string, unknown>[]);
  }
  return [];
}

function legacySection(record: AdaptiveResearchExportV1): (Paragraph | Table)[] {
  const legacy = record.reportSnapshot.legacy!;
  const schema = SCHEMA_REGISTRY[legacy.schemaId];
  const synthesis = legacy.synthesisReport;

  const out: (Paragraph | Table)[] = [];

  if (synthesis) {
    out.push(heading("Panel conclusion"), body(synthesis.unifiedAnswer));
    out.push(heading("Where models agree / disagree"));
    out.push(muted("Agreement"), body(synthesis.verdictCard.topConsensus));
    if (synthesis.verdictCard.keyDisagreement) {
      out.push(muted("Disagreement"), body(synthesis.verdictCard.keyDisagreement));
      if (synthesis.verdictCard.disagreementDetail) out.push(muted(synthesis.verdictCard.disagreementDetail));
    }
    if (synthesis.verdictCard.caveat) {
      out.push(new Paragraph({ children: [new TextRun({ text: synthesis.verdictCard.caveat, color: COLOR.warning, size: 18 })], spacing: { after: 80 } }));
    }
  } else {
    // creative_generative and any schema with alignedClaims=[] — Part 8:
    // never fabricate a synthesized consensus for a schema that never
    // computed one.
    out.push(
      heading("Panel conclusion"),
      muted("This schema does not produce a single synthesized panel conclusion — each model's own output below is the complete result. No consensus/disagreement scoring applies.")
    );
  }

  out.push(heading(`Model responses (${legacy.modelResponses?.length ?? 0})`));
  if (!legacy.modelResponses || legacy.modelResponses.length === 0) {
    out.push(muted("Raw per-model responses are not included in this export. Contact your administrator if full model output is needed."));
  } else {
    for (const r of legacy.modelResponses) {
      out.push(new Paragraph({ children: [new TextRun({ text: getModelDisplayNameSafe(r.modelId), bold: true, size: 20 })], spacing: { before: 120, after: 60 } }));
      for (const field of schema.fields) {
        const value = r.data?.[field.key];
        if (value == null) continue;
        out.push(new Paragraph({ children: [new TextRun({ text: fieldLabel(field.key), bold: true, color: COLOR.muted, size: 16 })], spacing: { after: 20 } }));
        out.push(...fieldValueDocx(field, value));
      }
    }
  }
  return out;
}

// ─── Provenance ─────────────────────────────────────────────────────────

function provenanceSection(record: AdaptiveResearchExportV1): (Paragraph | Table)[] {
  const snapshot = record.reportSnapshot;
  return [
    heading("Provenance"),
    ...fieldGrid([
      ["Run ID", record.runId],
      ["Export ID", record.exportId],
      ["Schema", record.schemaId],
      ["Schema data version", `v${record.schemaVersion}`],
      ["Report generated", formatExportTimestamp(snapshot.reportGeneratedAt)],
      ["Export generated", formatExportTimestamp(record.createdAt)],
    ]),
    muted("Generated with ConvergePanel. This document reflects a frozen snapshot of the report at the export timestamp above — later changes to the live run are not reflected here."),
  ];
}

/** Builds the full `Document` object — the caller (`renderAdaptiveResearchDocx.ts`) is responsible for packing it to bytes. Exported separately from the packer so structural tests can inspect the Document tree without invoking the ZIP packer. */
export function buildAdaptiveResearchDocxDocument(record: AdaptiveResearchExportV1): Document {
  const children: (Paragraph | Table)[] = [
    ...coverSection(record),
    ...statusSummarySection(record),
    ...(record.schemaFamily === "milestone2" ? milestone2Section(record) : legacySection(record)),
    ...provenanceSection(record),
  ];

  return new Document({
    creator: "ConvergePanel",
    title: `${record.reportSnapshot.reportTypeLabel} — ConvergePanel Export`,
    sections: [
      {
        properties: {},
        headers: {
          default: new Header({
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "ConvergePanel — Adaptive Research Export", color: COLOR.muted, size: 14 })] })],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: "Page ", color: COLOR.muted, size: 14 }),
                  new TextRun({ children: [PageNumber.CURRENT], color: COLOR.muted, size: 14 }),
                  new TextRun({ text: " of ", color: COLOR.muted, size: 14 }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], color: COLOR.muted, size: 14 }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
}
