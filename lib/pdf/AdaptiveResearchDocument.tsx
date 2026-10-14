/**
 * Adaptive Research Export, Phase 1 — the PDF document composer. Generates
 * the PDF from the frozen `AdaptiveResearchExportV1` snapshot (never live
 * data, never a browser screenshot — Part 7/11), reusing the exact label
 * constants the live UI uses (`REPORT_STATUS_LABELS`, `CONSENSUS_LABELS`,
 * `SOURCE_GROUNDING_LABELS`) so the PDF can never disagree with what a
 * reader would see on convergepanel.com for the same run.
 *
 * Schema-family-aware (see researchExport.ts's header comment):
 * - Milestone-2 branch renders `decisionReceipt` (conclusion/basis/
 *   assumptions/uncertainties/limitations/sources) — the uniform shape all
 *   9 Milestone-2 schemas share — plus a small comparison_matrix-specific
 *   enrichment (tradeoffs/recommendations), since that's this phase's one
 *   explicitly required Milestone-2 manual-inspection target.
 * - Legacy branch has no decisionReceipt at all (confirmed by code audit —
 *   see researchExport.ts). Renders `synthesisReport`'s unified answer/
 *   verdict card when present, then each model's own structured fields via
 *   a schema-registry-driven generic renderer — the SAME
 *   `schema.fields: FieldSpec[]`-driven pattern
 *   components/adaptive/ModelResponsesSection.tsx already uses client-side,
 *   so every one of the 8 legacy schemas (financial_valuation,
 *   forecast_speculative, creative_generative, legal_regulatory,
 *   medical_health, contested_empirical, procedural, factual_lookup) gets
 *   correct, schema-specific field labels and grouping without a
 *   hand-written per-schema branch.
 */

import { Document, Page, View, Text } from "@react-pdf/renderer";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { exportModelIdentityLabel, exportRunProvenanceLines, readFrozenRunProvenance } from "@/lib/adaptiveSchema/exportRunProvenance";
import { CONSENSUS_LABELS, SOURCE_GROUNDING_LABELS } from "@/lib/adaptiveSchema/reportSummary";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { FieldSpec } from "@/lib/adaptiveSchema/types";
import {
  fieldLabel,
  formatExportTimestamp as formatTimestamp,
  formatNestedFieldValue,
  governanceStatusDisplay,
} from "@/lib/adaptiveSchema/exportContentDerivation";
import { COLORS, badgeStyle, pdfStyles } from "./theme";

function Bullets({ items }: { items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <View>
      {items.map((item, idx) => (
        <View key={idx} style={pdfStyles.bulletRow}>
          <Text style={pdfStyles.bulletMark}>{"•"}</Text>
          <Text style={pdfStyles.bulletText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

/*
 * ── Keeping headings with their content ─────────────────────────────────
 * Content of unbounded length (model text, receipt sections, synthesis) must
 * PAGINATE: a non-breaking block taller than the space left on a page is laid
 * out past the page's content area, overlapping the next block and losing
 * text. But a heading must not be left alone at a page bottom with its
 * content on the next page.
 *
 * react-pdf's keep-with-next is `minPresenceAhead`: it moves an element to the
 * next page when less than N points would follow it on this one — but ONLY
 * when the element has an earlier non-fixed sibling in the same parent (it
 * never breaks before a first child). So every kept heading here is a
 * SIBLING of its content, never a first child: a zero-height `BreakAnchor`
 * precedes it, and cards are drawn as a heading block plus a body block.
 *
 * Each kept heading is itself a short, bounded, NON-BREAKING unit
 * (`wrap={false}`): otherwise a heading that only partly fits is split rather
 * than moved, and `minPresenceAhead` is never consulted.
 *
 * How much must follow a heading: react-pdf splits a Text only between its
 * orphans (default 2) and widows (default 2), so a Text of up to
 * orphans + widows − 1 = 3 lines is never split — it needs ALL of its lines on
 * the page at once. A heading must therefore keep its own bottom margin plus
 * three lines of the tallest content line (body text: 10 pt × 1.5 = 15 pt).
 * Presence distances also nest: a heading must guarantee room for the next
 * heading's own guarantee, or the inner heading would break away and strand
 * the outer one.
 *   - field label:    2 (margin) + 3 × 15 = 47;
 *   - sub-label:      3 (margin) + 3 × 15 = 48 ("Disagreement");
 *   - card heading:   first in-body label (field label ≈ 11, sub-label ≈ 15.6)
 *                     + 3 × 15 → 64 ≥ 60.6;
 *   - section label:  card heading block (12 + ≈9 + 4 ≈ 25) + 64 → 112 ≥ 89.
 */
const UNSPLITTABLE_TEXT_LINES = 3;
const BODY_LINE_HEIGHT = 15;
const FIELD_LABEL_PRESENCE_AHEAD = 2 + UNSPLITTABLE_TEXT_LINES * BODY_LINE_HEIGHT;
const SUB_LABEL_PRESENCE_AHEAD = 3 + UNSPLITTABLE_TEXT_LINES * BODY_LINE_HEIGHT;
const CARD_HEADING_PRESENCE_AHEAD = 64;
const SECTION_LABEL_PRESENCE_AHEAD = 112;

/** Zero-height, non-fixed sibling placed immediately before a kept heading (see above). Draws nothing. */
function BreakAnchor() {
  return <View style={{ height: 0 }} />;
}

/**
 * A titled card whose content paginates: heading block + body block as
 * siblings (together they draw the `card` box), the heading kept with the
 * first lines of the body.
 *
 * The space after the card is its own element, not a margin on the body:
 * react-pdf moves an element that fits on the page to the next one when its
 * bottom MARGIN does not fit, which would leave the heading behind alone.
 */
function PaginatingCard({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <BreakAnchor />
      <View style={pdfStyles.cardHead} wrap={false} minPresenceAhead={CARD_HEADING_PRESENCE_AHEAD}>
        {heading}
      </View>
      <View style={pdfStyles.cardBody}>{children}</View>
      <View style={pdfStyles.cardGap} />
    </>
  );
}

/**
 * A titled card. Content-bearing cards paginate (`PaginatingCard`). Only
 * cards whose content is structurally bounded and always far shorter than
 * one page (`bounded`) stay on one page as a single non-breaking block —
 * their heading then moves with them and can never be stranded.
 */
function SectionCard({ label, bounded = false, children }: { label: string; bounded?: boolean; children: React.ReactNode }) {
  if (bounded) {
    return (
      <View style={pdfStyles.card} wrap={false}>
        <Text style={pdfStyles.sectionLabel}>{label}</Text>
        {children}
      </View>
    );
  }
  return <PaginatingCard heading={<Text style={pdfStyles.sectionLabel}>{label}</Text>}>{children}</PaginatingCard>;
}

function CoverHeader({ record }: { record: AdaptiveResearchExportV1 }) {
  const snapshot = record.reportSnapshot;
  const status = governanceStatusDisplay(record);
  return (
    <View>
      <View style={pdfStyles.brandRow}>
        <View>
          <Text style={pdfStyles.brandName}>ConvergePanel</Text>
          <Text style={pdfStyles.brandTagline}>RESEARCH · VERIFY · GOVERN</Text>
        </View>
        <Text style={badgeStyle(status.tone)}>{status.label}</Text>
      </View>

      <Text style={pdfStyles.title}>{snapshot.reportTypeLabel}</Text>
      <Text style={pdfStyles.subtitle}>{snapshot.question}</Text>

      <View style={pdfStyles.fieldGrid}>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Report generated</Text>
          <Text style={pdfStyles.fieldValue}>{formatTimestamp(snapshot.reportGeneratedAt)}</Text>
        </View>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Export generated</Text>
          <Text style={pdfStyles.fieldValue}>{formatTimestamp(record.createdAt)}</Text>
        </View>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Report version</Text>
          <Text style={pdfStyles.fieldValue}>v{record.reportVersion}</Text>
        </View>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Export ID</Text>
          <Text style={pdfStyles.fieldValue}>{record.exportId}</Text>
        </View>
        {/* Export Generator Provenance — absent (never fabricated) for any
            export created before this feature shipped; the historical
            record simply has no `generatedBy` key. */}
        {record.generatedBy?.displayName && (
          <View style={pdfStyles.fieldCell}>
            <Text style={pdfStyles.fieldLabel}>Generated by</Text>
            <Text style={pdfStyles.fieldValue}>{record.generatedBy.displayName}</Text>
          </View>
        )}
        {record.generatedBy?.maskedEmail && (
          <View style={pdfStyles.fieldCell}>
            <Text style={pdfStyles.fieldLabel}>Email</Text>
            <Text style={pdfStyles.fieldValue}>{record.generatedBy.maskedEmail}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function StatusSummary({ record }: { record: AdaptiveResearchExportV1 }) {
  const snapshot = record.reportSnapshot;
  return (
    <SectionCard label="Report status summary" bounded>
      <View style={pdfStyles.fieldGrid}>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Models</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {snapshot.models.map((m) => (
              <Text key={m.modelId} style={pdfStyles.modelChip}>
                {exportModelIdentityLabel(snapshot.runProvenance, m.modelId)}
                {m.ok === false ? " (failed)" : ""}
              </Text>
            ))}
          </View>
        </View>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Consensus</Text>
          <Text style={pdfStyles.fieldValue}>{CONSENSUS_LABELS[snapshot.consensusLevel]}</Text>
        </View>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Source grounding</Text>
          <Text style={pdfStyles.fieldValue}>{SOURCE_GROUNDING_LABELS[snapshot.sourceGroundingLevel]}</Text>
        </View>
      </View>
      {/* Part 8 — never present a consensus/grounding number as factual
          correctness, evidence strength, or valuation confidence; the
          labels above are exactly the same "Not scored"/"Weak"/etc. tiers
          the live UI shows, never a fabricated precise number. */}
      <Text style={pdfStyles.mutedText}>
        Consensus reflects panel agreement, not factual correctness. Source grounding reflects citation coverage, not evidence
        strength.
      </Text>
    </SectionCard>
  );
}

// ─── Milestone-2 primary content ──────────────────────────────────────────

function Milestone2Content({ record }: { record: AdaptiveResearchExportV1 }) {
  const m2 = record.reportSnapshot.milestone2!;
  if (!m2.decisionReceipt) {
    return (
      <SectionCard label="Primary synthesis" bounded>
        <Text style={pdfStyles.mutedText}>
          No governance record exists yet for this run, so no reviewed conclusion has been composed. The report has not been
          reviewed.
        </Text>
      </SectionCard>
    );
  }
  const r = m2.decisionReceipt;
  return (
    <View>
      <SectionCard label="Conclusion">
        <Text style={pdfStyles.bodyText}>{r.conclusion}</Text>
      </SectionCard>
      {r.basis.length > 0 && (
        <SectionCard label="Basis">
          <Bullets items={r.basis} />
        </SectionCard>
      )}
      {r.assumptions.length > 0 && (
        <SectionCard label="Assumptions">
          <Bullets items={r.assumptions} />
        </SectionCard>
      )}
      {r.uncertainties.length > 0 && (
        <SectionCard label="Uncertainties">
          <Bullets items={r.uncertainties} />
        </SectionCard>
      )}
      {r.limitations.length > 0 && (
        <SectionCard label="Limitations">
          <Bullets items={r.limitations} />
        </SectionCard>
      )}
      {r.sources.length > 0 && (
        <SectionCard label="Sources">
          <Bullets items={r.sources} />
        </SectionCard>
      )}
      {m2.schemaId === "comparison_matrix" && <ComparisonMatrixEnrichment result={m2.result as any} />}
    </View>
  );
}

/** comparison_matrix-specific enrichment (Part 7's own example: "conclusion + matrix + tradeoffs + recommendations") — the decisionReceipt above already covers conclusion/basis; this adds the two list fields it doesn't. */
function ComparisonMatrixEnrichment({ result }: { result: { tradeoffs?: string[]; bestUseRecommendations?: string[] } }) {
  return (
    <View>
      {Array.isArray(result?.tradeoffs) && result.tradeoffs.length > 0 && (
        <SectionCard label="Trade-offs">
          <Bullets items={result.tradeoffs} />
        </SectionCard>
      )}
      {Array.isArray(result?.bestUseRecommendations) && result.bestUseRecommendations.length > 0 && (
        <SectionCard label="Best-use recommendations">
          <Bullets items={result.bestUseRecommendations} />
        </SectionCard>
      )}
    </View>
  );
}

// ─── Legacy-active primary content ────────────────────────────────────────

/**
 * metric[] (financial_valuation's own field type) gets a dedicated,
 * readable row layout instead of the generic key:value dump below —
 * mirrors MetricsGridView.tsx's own "label · value unit · as-of" emphasis,
 * never averaged/blended across items (each item is its own row).
 */
function MetricRows({ items }: { items: Record<string, unknown>[] }) {
  return (
    <View>
      {items.map((item, idx) => (
        <View
          key={idx}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            paddingVertical: 3,
            borderBottomWidth: idx < items.length - 1 ? 1 : 0,
            borderBottomColor: COLORS.borderSoft,
          }}
        >
          <Text style={{ ...pdfStyles.bodyText, flex: 1 }}>{String(item.label ?? "")}</Text>
          <Text style={{ ...pdfStyles.bodyText, fontFamily: "Helvetica-Bold" }}>
            {item.value != null ? `${item.value} ${item.unit ?? ""}`.trim() : "—"}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Generic fallback for any other array-of-object field (claim[]/step[]/scenario[]/etc.) — one block per item, key: value pairs. Matches ModelResponsesSection.tsx's own GenericObjectArrayList fallback. An item paginates: a single claim with long competing positions can exceed a page. */
function GenericObjectArrayPdf({ items }: { items: Record<string, unknown>[] }) {
  return (
    <View>
      {items.map((item, idx) => (
        <View
          key={idx}
          style={{ marginBottom: 3, paddingBottom: 3, borderBottomWidth: idx < items.length - 1 ? 1 : 0, borderBottomColor: COLORS.borderSoft }}
        >
          {Object.entries(item).map(([k, v]) => (
            <Text key={k} style={pdfStyles.mutedText}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>{k}: </Text>
              {formatNestedFieldValue(v)}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function FieldValuePdf({ field, value }: { field: FieldSpec; value: unknown }) {
  if (value == null) return null;
  if (field.type === "string") {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    return <Text style={pdfStyles.bodyText}>{value}</Text>;
  }
  if (field.type === "string[]") {
    return Array.isArray(value) && value.length > 0 ? <Bullets items={value as string[]} /> : null;
  }
  if (Array.isArray(value) && value.length > 0) {
    if (field.type === "metric[]") return <MetricRows items={value as Record<string, unknown>[]} />;
    return <GenericObjectArrayPdf items={value as Record<string, unknown>[]} />;
  }
  return null;
}

function LegacyContent({ record }: { record: AdaptiveResearchExportV1 }) {
  const legacy = record.reportSnapshot.legacy!;
  const schema = SCHEMA_REGISTRY[legacy.schemaId];
  const synthesis = legacy.synthesisReport;

  return (
    <View>
      {synthesis ? (
        <View>
          <SectionCard label="Panel conclusion">
            <Text style={pdfStyles.bodyText}>{synthesis.unifiedAnswer}</Text>
          </SectionCard>
          <SectionCard label="Where models agree / disagree">
            {/* "Agreement" is the body's first child — kept by the card heading's guarantee. "Disagreement" is a
                sibling of the content before it, so it can be kept with its own text. */}
            <Text style={pdfStyles.subLabel}>Agreement</Text>
            <Text style={pdfStyles.bodyText}>{synthesis.verdictCard.topConsensus}</Text>
            {synthesis.verdictCard.keyDisagreement && (
              <Text style={pdfStyles.subLabelAfterContent} wrap={false} minPresenceAhead={SUB_LABEL_PRESENCE_AHEAD}>
                Disagreement
              </Text>
            )}
            {synthesis.verdictCard.keyDisagreement && <Text style={pdfStyles.bodyText}>{synthesis.verdictCard.keyDisagreement}</Text>}
            {synthesis.verdictCard.keyDisagreement && synthesis.verdictCard.disagreementDetail && (
              <Text style={pdfStyles.mutedText}>{synthesis.verdictCard.disagreementDetail}</Text>
            )}
            {synthesis.verdictCard.caveat && (
              <Text style={{ ...pdfStyles.mutedText, marginTop: 6, color: COLORS.warning }}>{synthesis.verdictCard.caveat}</Text>
            )}
          </SectionCard>
        </View>
      ) : (
        <SectionCard label="Panel conclusion" bounded>
          {/* creative_generative and any schema with alignedClaims=[] —
              Part 8: never fabricate a synthesized consensus for a schema
              that never computed one. The per-model outputs below are the
              real content. */}
          <Text style={pdfStyles.mutedText}>
            This schema does not produce a single synthesized panel conclusion — each model&apos;s own output below is the
            complete result. No consensus/disagreement scoring applies.
          </Text>
        </SectionCard>
      )}

      {/* Model responses paginate at every level: the section, each model's
          card and each field. A single model's response is NOT bounded —
          long claims with competing positions routinely exceed a page — and
          a non-breaking card taller than the remaining page space overlaps
          the next card and loses text (seen in Production exports). Each
          heading is kept with the first lines of its content (see
          "Keeping headings with their content" above). */}
      <View style={{ marginBottom: 10 }}>
        <BreakAnchor />
        <Text style={pdfStyles.sectionLabel} wrap={false} minPresenceAhead={SECTION_LABEL_PRESENCE_AHEAD}>{`Model responses (${legacy.modelResponses?.length ?? 0})`}</Text>
        {(legacy.modelResponses ?? []).map((r) => (
          <PaginatingCard
            key={r.modelId}
            heading={<Text style={pdfStyles.modelLabel}>{exportModelIdentityLabel(record.reportSnapshot.runProvenance, r.modelId)}</Text>}
          >
            {schema.fields
              .filter((field) => r.data?.[field.key] != null)
              .map((field, idx) => {
                const value = r.data?.[field.key];
                // Label and value are siblings, so every label after the first is kept with its value. The first
                // label is the body's first child — where react-pdf ignores minPresenceAhead — and is kept by the
                // card heading's own guarantee instead, so it carries no (inert) prop.
                const keep = idx > 0 ? { minPresenceAhead: FIELD_LABEL_PRESENCE_AHEAD } : {};
                return [
                  <Text key={`${field.key}-label`} style={pdfStyles.fieldLabel} wrap={false} {...keep}>
                    {fieldLabel(field.key)}
                  </Text>,
                  // Spacing as padding, not margin: a margin that does not fit would push a fitting value away from its label.
                  <View key={`${field.key}-value`} style={{ paddingBottom: 6 }}>
                    <FieldValuePdf field={field} value={value} />
                  </View>,
                ];
              })}
          </PaginatingCard>
        ))}
        {(!legacy.modelResponses || legacy.modelResponses.length === 0) && (
          <Text style={pdfStyles.mutedText}>
            Raw per-model responses are not included in this export. Contact your administrator if full model output is needed.
          </Text>
        )}
      </View>
    </View>
  );
}

function Provenance({ record }: { record: AdaptiveResearchExportV1 }) {
  const snapshot = record.reportSnapshot;
  // Step 6.2b — frozen run provenance; null for every pre-6.2b record, which
  // therefore renders exactly as before.
  const runProvenance = readFrozenRunProvenance(snapshot.runProvenance);
  return (
    <SectionCard label="Provenance" bounded>
      <View style={pdfStyles.fieldGrid}>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Run ID</Text>
          <Text style={pdfStyles.fieldValue}>{record.runId}</Text>
        </View>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Export ID</Text>
          <Text style={pdfStyles.fieldValue}>{record.exportId}</Text>
        </View>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Schema</Text>
          <Text style={pdfStyles.fieldValue}>{record.schemaId}</Text>
        </View>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Schema data version</Text>
          <Text style={pdfStyles.fieldValue}>v{record.schemaVersion}</Text>
        </View>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Report generated</Text>
          <Text style={pdfStyles.fieldValue}>{formatTimestamp(snapshot.reportGeneratedAt)}</Text>
        </View>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Export generated</Text>
          <Text style={pdfStyles.fieldValue}>{formatTimestamp(record.createdAt)}</Text>
        </View>
      </View>
      {runProvenance && (
        <View>
          <Text style={pdfStyles.fieldLabel}>Run provenance</Text>
          <Bullets items={exportRunProvenanceLines(runProvenance)} />
        </View>
      )}
      <Text style={pdfStyles.mutedText}>
        Generated with ConvergePanel. This document reflects a frozen snapshot of the report at the export timestamp above —
        later changes to the live run are not reflected here.
      </Text>
    </SectionCard>
  );
}

function PageFooter() {
  return (
    <View style={pdfStyles.pageFooter} fixed>
      <Text>ConvergePanel — Adaptive Research Export</Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

export function AdaptiveResearchDocument({ record }: { record: AdaptiveResearchExportV1 }) {
  return (
    <Document
      title={`${record.reportSnapshot.reportTypeLabel} — ConvergePanel Export`}
      author="ConvergePanel"
      creationDate={new Date(record.createdAt)}
    >
      <Page size="A4" style={pdfStyles.page} wrap>
        <CoverHeader record={record} />
        <StatusSummary record={record} />
        {record.schemaFamily === "milestone2" ? <Milestone2Content record={record} /> : <LegacyContent record={record} />}
        <Provenance record={record} />
        <PageFooter />
      </Page>
    </Document>
  );
}
