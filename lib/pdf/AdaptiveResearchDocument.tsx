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

import { Children } from "react";
import { Document, Page, View, Text } from "@react-pdf/renderer";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { exportModelIdentityLabel, exportRunProvenanceLines, readFrozenRunProvenance } from "@/lib/adaptiveSchema/exportRunProvenance";
import { CONSENSUS_LABELS, SOURCE_GROUNDING_LABELS } from "@/lib/adaptiveSchema/reportSummary";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { AdaptiveSynthesisReport, FieldSpec } from "@/lib/adaptiveSchema/types";
import { modelCaveatParts, presentVerdictCaveat, presentVerdictClaim, verdictClaimParts } from "@/lib/adaptiveSchema/agreementNarrative";
import { TextBlock, presentUnifiedAnswer } from "@/lib/adaptiveSchema/reportPresentation";
import {
  fieldLabel,
  formatExportTimestamp as formatTimestamp,
  formatNestedFieldValue,
  governanceStatusDisplay,
} from "@/lib/adaptiveSchema/exportContentDerivation";
import { COLORS, badgeStyle, pdfStyles } from "./theme";

/**
 * A bulleted list. Each row is mark + text side by side. The text paginates
 * (a bullet may be longer than a page), but its mark must never be left alone
 * at a page bottom while the text moves on: react-pdf moves a ≤ 3-line text
 * whole, and moves even a long one whole when fewer than 2 of its lines fit.
 * The mark is therefore a kept, non-breaking sibling (after a zero-width
 * anchor): when the text cannot start on this page with enough lines, the
 * mark — and the row with it — moves to the next page.
 *
 * `closing`: the padding to carry when this list ends a paginating card body
 * (its last text carries it — see `PaginatingCard`); 0 when it does not.
 */
function Bullets({ items, closing = 0 }: { items: string[]; closing?: number }) {
  if (!items || items.length === 0) return null;
  return (
    <View>
      {items.map((item, idx) => (
        <View key={idx} style={idx === items.length - 1 && closing > 0 ? { ...pdfStyles.bulletRow, marginBottom: 0 } : pdfStyles.bulletRow}>
          <BreakAnchor />
          <Text style={pdfStyles.bulletMark} wrap={false} minPresenceAhead={BULLET_MARK_PRESENCE_AHEAD}>
            {"•"}
          </Text>
          {/* The closing bullet folds the row's 3 pt gap into its closing padding (same geometry). */}
          <Text {...textProps(idx === items.length - 1 && closing > 0 ? { ...pdfStyles.bulletText, marginBottom: 3 } : pdfStyles.bulletText, idx === items.length - 1 ? closing : 0)}>{item}</Text>
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
 * How much must follow a kept element. react-pdf splits a Text only between
 * its orphans (default 2) and widows (default 2), so a Text of up to
 * orphans + widows − 1 = 3 lines is never split — it needs ALL of its lines on
 * the page at once. react-pdf measures the presence from below the element's
 * OWN bottom margin (top + height + marginBottom + minPresenceAhead), so the
 * margin is not part of the distance. The last content of a paginating card
 * also carries the card's closing padding (CARD_CLOSING_PADDING), which must
 * fit with it. Each distance below adds a small conservative slack on top.
 * Presence distances also nest: a heading must guarantee room for the next
 * heading's own guarantee, or the inner heading would break away and strand
 * the outer one.
 * The largest closing padding is a model card's last field: the 6 pt field
 * gap plus the 12 pt card padding = 18 (FIELD_CLOSING_PADDING); the closing
 * text also covers the body's 1 pt bottom border (`closingBox`).
 *   - field label:   3 × 15 (body lines) + 18 (closing) + 1 (border)
 *                    + 1 slack                                           = 65;
 *   - sub-label:     3 × 15 + 12 (card closing) + 1 + 2 slack            = 60;
 *   - bullet mark:   3 × 14 (bullet lines) − 14 (the mark's own line)
 *                    + 18 + 1 + 1 slack                                  = 48;
 *   - card heading:  first in-body label (sub-label ≈ 15.6) + 3 × 15 + 18
 *                    + 1 = 79.6 → 82;
 *   - section label: card heading block (12 + ≈ 9 + 4 ≈ 25) + 82 → 112 ≥ 107.
 */
const UNSPLITTABLE_TEXT_LINES = 3;
const BODY_LINE_HEIGHT = 15;
const BULLET_LINE_HEIGHT = 14;
/** A paginating card's bottom padding, carried by its last text (see `PaginatingCard`). */
const CARD_CLOSING_PADDING = 12;
/** Gap after each model-card field value. */
const FIELD_GAP = 6;
/** The last field of a model card closes the card: field gap + card padding. */
const FIELD_CLOSING_PADDING = FIELD_GAP + CARD_CLOSING_PADDING;
const FIELD_LABEL_PRESENCE_AHEAD = UNSPLITTABLE_TEXT_LINES * BODY_LINE_HEIGHT + FIELD_CLOSING_PADDING + 2;
const SUB_LABEL_PRESENCE_AHEAD = UNSPLITTABLE_TEXT_LINES * BODY_LINE_HEIGHT + CARD_CLOSING_PADDING + 3;
/**
 * A metric value is kept beside at least the first 2 lines of its label, or
 * the whole label when it has ≤ 3 lines (the label is at most 2 lines taller
 * than its ≥ 1-line value): 2 × 15 + 2 slack.
 */
const METRIC_VALUE_PRESENCE_AHEAD = (UNSPLITTABLE_TEXT_LINES - 1) * BODY_LINE_HEIGHT + 2;
const BULLET_MARK_PRESENCE_AHEAD = UNSPLITTABLE_TEXT_LINES * BULLET_LINE_HEIGHT - BULLET_LINE_HEIGHT + FIELD_CLOSING_PADDING + 2;
const CARD_HEADING_PRESENCE_AHEAD = 82;
const SECTION_LABEL_PRESENCE_AHEAD = 112;

/*
 * A metric[] field needs more after its label: its first row (3 pt top
 * padding) must keep its value — up to 3 lines, plus the closing box when it
 * closes the card (3 + 18 + 1 + 2 = 24) — and the value's own presence:
 *   3 + 3 × 15 + 24 + 32 + 2 slack = 106.
 * The card and section headings above a card whose FIRST field is a metric[]
 * nest that distance in turn: field label block (≈ 8.25 + 2) + 106 → 118, and
 * card heading block (≈ 25.25) + 118 → 148.
 */
const METRIC_FIELD_PRESENCE_AHEAD = 3 + UNSPLITTABLE_TEXT_LINES * BODY_LINE_HEIGHT + 24 + METRIC_VALUE_PRESENCE_AHEAD + 2;
const METRIC_FIRST_CARD_HEADING_PRESENCE_AHEAD = 118;
const METRIC_FIRST_SECTION_LABEL_PRESENCE_AHEAD = 148;

/** The keep-with-next distance of a model-card field label. */
function fieldLabelPresenceAhead(field: { type: string }): number {
  return field.type === "metric[]" ? METRIC_FIELD_PRESENCE_AHEAD : FIELD_LABEL_PRESENCE_AHEAD;
}

/** The card body's bottom border width (`pdfStyles.cardBody`). */
const CARD_BORDER = Number(pdfStyles.cardBody.borderBottomWidth ?? 0);

/**
 * How far the closing element's box reaches past the end of the content chain
 * that contains it: slack for layout rounding (yoga rounds boxes to the point
 * grid).
 */
const CLOSING_REACH = 2;

/**
 * The trailing box of the element that closes a paginating card body: all of
 * its trailing space as PADDING (`closing` + the element's own bottom margin
 * + the body's bottom border), plus CLOSING_REACH, with a −CLOSING_REACH
 * margin. Together with the body's content wrapper (−CARD_BORDER margin, see
 * `PaginatingCard`) every box between the body and its closing element ends at
 * or above the closing element's own box, and the body's outer edge (border
 * included) ends exactly where the content chain does. So whenever the body
 * does not fit a page, every box down to the closing element does not fit
 * either, and react-pdf can only split or move that element itself — never
 * leave the body's border behind alone. Rendered geometry is unchanged
 * (padding + margins = the old padding).
 */
function closingBox(closing: number, ownMarginBottom = 0): { paddingBottom: number; marginBottom: number } {
  return { paddingBottom: ownMarginBottom + closing + CARD_BORDER + CLOSING_REACH, marginBottom: -CLOSING_REACH };
}

/**
 * Props for a Text; when `closingPadding` > 0, it closes a paginating card
 * body (`closingBox`). Such a text never stays behind without at least one
 * line going with its padding: with orphans = 1 react-pdf moves a 1–2-line
 * text whole, moves 2 of 3 lines, and keeps the last 2 lines of a longer text
 * with the padding (with the default orphans = 2 a 1-line text would stay and
 * its padding would go to the next page alone).
 */
function textProps<T extends object>(style: T, closingPadding: number): { style: T; orphans?: number } {
  if (closingPadding <= 0) return { style };
  const ownMargin = Number((style as { marginBottom?: unknown }).marginBottom ?? 0);
  return { style: { ...style, ...closingBox(closingPadding, ownMargin) }, orphans: 1 };
}

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
 *
 * The body has NO bottom padding of its own: when a body's content fits a
 * page but its padding does not, react-pdf carries the padding and bottom
 * border to the next page as an empty strip. Instead the LAST text of the body
 * carries the closing padding (`textProps`): a Text whose lines fit but
 * whose padding does not moves its last lines (or, if ≤ 3 lines, all of them)
 * along with the padding, so the card always closes under real content. The
 * body's content sits in one wrapper whose −CARD_BORDER margin makes the body's
 * outer edge, border included, end where its content chain ends (`closingBox`):
 * the body can never overflow a page while all of its content fits.
 *
 * A card with NO body content (a failed model, or a model with no shown field)
 * has nothing to paginate and no text to carry the closing padding: it is its
 * heading alone, drawn as one bounded box (`labelOnlyCard`) that moves whole.
 */
function PaginatingCard({ heading, children, keepAhead = CARD_HEADING_PRESENCE_AHEAD }: { heading: React.ReactNode; children: React.ReactNode; keepAhead?: number }) {
  if (Children.toArray(children).length === 0) {
    return (
      <>
        <BreakAnchor />
        <View style={pdfStyles.labelOnlyCard} wrap={false}>
          {heading}
        </View>
        <View style={pdfStyles.cardGap} />
      </>
    );
  }
  return (
    <>
      <BreakAnchor />
      <View style={pdfStyles.cardHead} wrap={false} minPresenceAhead={keepAhead}>
        {heading}
      </View>
      <View style={pdfStyles.cardBody}>
        {/* Content wrapper: its −CARD_BORDER margin lets the closing element's box cover the body's border (`closingBox`). */}
        <View style={{ marginBottom: -CARD_BORDER }}>
          {/* A non-breaking first child that moves to the next page would otherwise make react-pdf keep this whole
              wrapper on the current page (it keeps a parent whose every child moved when it is its parent's first). */}
          <BreakAnchor />
          {children}
        </View>
      </View>
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
    // The anchor: a non-breaking first child that moves to the next page would make react-pdf keep its parent whole
    // on the current page instead (see `PaginatingCard`).
    return (
      <>
        <BreakAnchor />
        <View style={pdfStyles.card} wrap={false}>
          <Text style={pdfStyles.sectionLabel}>{label}</Text>
          {children}
        </View>
      </>
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
        <Text {...textProps(pdfStyles.bodyText, CARD_CLOSING_PADDING)}>{r.conclusion}</Text>
      </SectionCard>
      {r.basis.length > 0 && (
        <SectionCard label="Basis">
          <Bullets items={r.basis} closing={CARD_CLOSING_PADDING} />
        </SectionCard>
      )}
      {r.assumptions.length > 0 && (
        <SectionCard label="Assumptions">
          <Bullets items={r.assumptions} closing={CARD_CLOSING_PADDING} />
        </SectionCard>
      )}
      {r.uncertainties.length > 0 && (
        <SectionCard label="Uncertainties">
          <Bullets items={r.uncertainties} closing={CARD_CLOSING_PADDING} />
        </SectionCard>
      )}
      {r.limitations.length > 0 && (
        <SectionCard label="Limitations">
          <Bullets items={r.limitations} closing={CARD_CLOSING_PADDING} />
        </SectionCard>
      )}
      {r.sources.length > 0 && (
        <SectionCard label="Sources">
          <Bullets items={r.sources} closing={CARD_CLOSING_PADDING} />
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
          <Bullets items={result.tradeoffs} closing={CARD_CLOSING_PADDING} />
        </SectionCard>
      )}
      {Array.isArray(result?.bestUseRecommendations) && result.bestUseRecommendations.length > 0 && (
        <SectionCard label="Best-use recommendations">
          <Bullets items={result.bestUseRecommendations} closing={CARD_CLOSING_PADDING} />
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
/**
 * A metric's label and value must stay together, but a label can be of any
 * length, so no metric row is kept whole (a non-breaking row taller than a
 * page loses its text). Instead each row paginates, and its VALUE is kept with
 * the first lines of the label:
 *  - the value is short (≤ METRIC_ROW_MAX_VALUE_CHARS, at most
 *    METRIC_ROW_MAX_VALUE_WIDTH of the row → at most 3 lines) and
 *    non-breaking; it is the row's first content child (`row-reverse` keeps it
 *    visually on the right), after a `BreakAnchor`, so when it moves to the
 *    next page the label — a later sibling — moves with it;
 *  - its `minPresenceAhead` (METRIC_VALUE_PRESENCE_AHEAD) moves it, and so the
 *    whole metric, unless the label either fits completely or keeps at least
 *    its first 2 lines beside the value (react-pdf keeps ≥ 2 lines — orphans —
 *    of a split label, and moves a label of ≤ 3 lines whole);
 *  - both texts are top-aligned (never stretched to the row's height: a
 *    stretched non-breaking value beside a page-long label would itself be
 *    taller than a page);
 *  - the rule between rows is the top border of the next row, so it always
 *    travels with the row it precedes.
 * A metric whose value is longer is the same row with BOTH texts paginating:
 * the value (still at most METRIC_ROW_MAX_VALUE_WIDTH of the row) and the
 * label each split at any line (orphans = widows = 1). The two texts of a row
 * start at the same height, so in a row that does not close the card, whenever
 * the first line fits on a page both texts start on it; when it does not, the
 * row moves whole. (One "label — value" paragraph, the earlier rendering,
 * split 2 / 2 across pages and moved the value away from the start of its
 * label.)
 * A row that CLOSES the card is different: both texts carry the closing box,
 * and at a page bottom where a line fits but not a line plus that box, a
 * 1-line text moves whole while a text of 2 or more lines keeps its first
 * line — so a 1-line label and a 2-line value (or the reverse) would start on
 * different pages (R5 MINOR 1). The closing row therefore opens with a
 * zero-height, non-breaking gate after the anchor, kept with
 * `metricClosingRowPresenceAhead` (one line plus the closing box): unless the
 * whole row fits, the gate — and with it both texts, its later siblings —
 * moves to the next page whenever less than that space is left. Where the gate
 * stays, a 1-line text fits whole with its box and a longer text keeps at
 * least its first line, so both texts start on the page. Only this window
 * (under ≈ 41 pt left) moves the row; a longer row still splits at any line.
 */
export const METRIC_ROW_MAX_VALUE_CHARS = 32;
/**
 * The space a closing long-value metric row needs before either text may stay
 * on a page: one body line plus the closing box's padding (which a 1-line
 * text needs to fit whole, `closingBox(closing, 3)`), plus CLOSING_REACH
 * slack — 15 + 24 + 2 = 41 for a model card's last field (closing 18).
 */
function metricClosingRowPresenceAhead(closing: number): number {
  return BODY_LINE_HEIGHT + closingBox(closing, 3).paddingBottom + CLOSING_REACH;
}
/** The value column never takes more than this, so the label always keeps the rest of the row's width. */
const METRIC_ROW_MAX_VALUE_WIDTH = "40%";

function MetricRows({ items, closing = 0 }: { items: Record<string, unknown>[]; closing?: number }) {
  return (
    <View>
      {items.map((item, idx) => {
        const label = String(item.label ?? "");
        const valueText = item.value != null ? `${item.value} ${item.unit ?? ""}`.trim() : "—";
        const closes = closing > 0 && idx === items.length - 1;
        const rule = idx > 0 ? { borderTopWidth: 1, borderTopColor: COLORS.borderSoft } : {};
        if (valueText.length <= METRIC_ROW_MAX_VALUE_CHARS) {
          // The row's 3 pt bottom padding moves onto both texts when the row closes the card (`closingBox`).
          const textEnd = closes ? closingBox(closing, 3) : {};
          return (
            <View key={idx} style={{ ...pdfStyles.metricRow, ...rule, ...(closes ? { paddingBottom: 0 } : {}) }}>
              <BreakAnchor />
              <Text
                style={{ ...pdfStyles.metricValue, maxWidth: METRIC_ROW_MAX_VALUE_WIDTH, ...textEnd }}
                wrap={false}
                minPresenceAhead={METRIC_VALUE_PRESENCE_AHEAD}
              >
                {valueText}
              </Text>
              <Text style={{ ...pdfStyles.metricLabel, ...textEnd }} {...(closes ? { orphans: 1 } : {})}>
                {label}
              </Text>
            </View>
          );
        }
        const textEnd = closes ? closingBox(closing, 3) : {};
        return (
          <View key={idx} style={{ ...pdfStyles.metricRow, ...rule, ...(closes ? { paddingBottom: 0 } : {}) }}>
            <BreakAnchor />
            {closes && <View style={{ height: 0 }} wrap={false} minPresenceAhead={metricClosingRowPresenceAhead(closing)} />}
            <Text style={{ ...pdfStyles.metricValue, maxWidth: METRIC_ROW_MAX_VALUE_WIDTH, ...textEnd }} orphans={1} widows={1}>
              {valueText}
            </Text>
            <Text style={{ ...pdfStyles.metricLabel, ...textEnd }} orphans={1} widows={1}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** Generic fallback for any other array-of-object field (claim[]/step[]/scenario[]/etc.) — one block per item, key: value pairs. Matches ModelResponsesSection.tsx's own GenericObjectArrayList fallback. An item paginates: a single claim with long competing positions can exceed a page. */
function GenericObjectArrayPdf({ items, closing = 0 }: { items: Record<string, unknown>[]; closing?: number }) {
  return (
    <View>
      {items.map((item, idx) => {
        const entries = Object.entries(item);
        const lastItem = idx === items.length - 1;
        // The item's closing space and separator rule are carried by its LAST text, not by the item block:
        // a block whose text fits but whose padding/rule does not would carry them alone onto the next page.
        const itemEnd = {
          ...(closing > 0 && lastItem ? closingBox(closing, 3 + 3) : { marginBottom: 3, paddingBottom: 3 }),
          borderBottomWidth: lastItem ? 0 : 1,
          borderBottomColor: COLORS.borderSoft,
        };
        return (
          <View key={idx}>
            {entries.map(([k, v], i) => (
              <Text
                key={k}
                style={i === entries.length - 1 ? { ...pdfStyles.mutedText, ...itemEnd } : pdfStyles.mutedText}
                {...(closing > 0 && lastItem && i === entries.length - 1 ? { orphans: 1 } : {})}
              >
                <Text style={{ fontFamily: "Helvetica-Bold" }}>{k}: </Text>
                {formatNestedFieldValue(v)}
              </Text>
            ))}
          </View>
        );
      })}
    </View>
  );
}

/** Whether `FieldValuePdf` renders anything for this value (mirrors its own conditions exactly). */
function fieldValueRenders(field: FieldSpec, value: unknown): boolean {
  if (value == null) return false;
  if (field.type === "string") return typeof value === "string" && value.trim().length > 0;
  return Array.isArray(value) && value.length > 0;
}

function FieldValuePdf({ field, value, closing = 0 }: { field: FieldSpec; value: unknown; closing?: number }) {
  if (!fieldValueRenders(field, value)) return null;
  if (field.type === "string") {
    return <Text {...textProps(pdfStyles.bodyText, closing)}>{value as string}</Text>;
  }
  if (field.type === "string[]") return <Bullets items={value as string[]} closing={closing} />;
  if (field.type === "metric[]") return <MetricRows items={value as Record<string, unknown>[]} closing={closing} />;
  return <GenericObjectArrayPdf items={value as Record<string, unknown>[]} closing={closing} />;
}

/**
 * "Where models agree / disagree" body. "Agreement" is the body's first child —
 * kept by the card heading's guarantee. "Disagreement" is a sibling of the
 * content before it, so it is kept with its own text. The LAST text present
 * carries the card's closing padding.
 */
function VerdictCardBody({
  verdictCard,
}: {
  verdictCard: {
    topConsensus: string;
    topConsensusContested?: string;
    topConsensusAgreement?: string;
    keyDisagreement?: string | null;
    keyDisagreementAgreement?: string;
    disagreementDetail?: string | null;
    caveat?: string | null;
    caveatSource?: "model_bias_check";
  };
}) {
  // Consensus Integrity: the computed status (R4-1) and the canonical contested note (verdictCard.ts) as further
  // lines of the same text, labels bold and the quoted claim oblique (R9, see sourcedLines) — so a report without
  // them (every one persisted before they existed) composes exactly the same element tree as before.
  const topParts = verdictClaimParts(verdictCard.topConsensus, verdictCard.topConsensusAgreement);
  const agreementText = topParts
    ? sourcedLines([
        { ...topParts.claim, model: true },
        { ...topParts.result, model: false },
        ...(verdictCard.topConsensusContested ? [{ label: "Contested", text: verdictCard.topConsensusContested, model: false }] : []),
      ])
    : [presentVerdictClaim(verdictCard.topConsensus, undefined).claim, verdictCard.topConsensusContested ? `Contested: ${verdictCard.topConsensusContested}` : null]
        .filter(Boolean)
        .join("\n");
  const splitParts = verdictCard.keyDisagreement ? verdictClaimParts(verdictCard.keyDisagreement, verdictCard.keyDisagreementAgreement) : null;
  const disagreementText = !verdictCard.keyDisagreement
    ? null
    : splitParts
      ? sourcedLines([
          { ...splitParts.claim, model: true },
          { ...splitParts.result, model: false },
        ])
      : presentVerdictClaim(verdictCard.keyDisagreement, undefined).claim;
  const caveatParts = modelCaveatParts({ caveat: verdictCard.caveat ?? null, caveatSource: verdictCard.caveatSource });
  const caveat = caveatParts ? sourcedLines([{ ...caveatParts, model: true }], undefined, pdfStyles.modelCaveatText) : presentVerdictCaveat({ caveat: verdictCard.caveat ?? null, caveatSource: verdictCard.caveatSource });
  const showDisagreement = Boolean(verdictCard.keyDisagreement);
  const showDetail = showDisagreement && Boolean(verdictCard.disagreementDetail);
  const showCaveat = Boolean(caveat);
  const last = showCaveat ? "caveat" : showDetail ? "detail" : showDisagreement ? "disagreement" : "consensus";
  const end = <T extends object>(which: string, style: T) => textProps(style, which === last ? CARD_CLOSING_PADDING : 0);
  return (
    <>
      <Text style={pdfStyles.subLabel}>Agreement</Text>
      <Text {...end("consensus", pdfStyles.bodyText)}>{agreementText}</Text>
      {showDisagreement && (
        <Text style={pdfStyles.subLabelAfterContent} wrap={false} minPresenceAhead={SUB_LABEL_PRESENCE_AHEAD}>
          Disagreement
        </Text>
      )}
      {showDisagreement && <Text {...end("disagreement", pdfStyles.bodyText)}>{disagreementText}</Text>}
      {showDetail && <Text {...end("detail", pdfStyles.mutedText)}>{verdictCard.disagreementDetail}</Text>}
      {showCaveat && <Text {...end("caveat", { ...pdfStyles.mutedText, marginTop: 6, color: COLORS.warning })}>{caveat}</Text>}
    </>
  );
}

/** One line of a new-format claim / result / caveat text: its label (application text) and its text, model-written or not. */
interface SourcedLine {
  label: string | null;
  text: string;
  model: boolean;
}

/**
 * Consensus Integrity (R9): the lines of a new-format text as inline runs of ONE react-pdf text — the label of each
 * line in bold, model-written text (a quoted claim, the bias caveat) oblique on a tinted band (`modelText`), computed
 * text in the text's own face — joined by line breaks. Model text wraps by width like any text; whatever it says,
 * every line it wraps onto lies inside the band and never starts with the bold label of a computed line. One text,
 * as before: pagination is unchanged.
 */
function sourcedLines(lines: SourcedLine[], separator: (index: number) => string = () => "\n", modelStyle = pdfStyles.modelText): React.ReactNode[] {
  return lines.flatMap((line, i) => [
    ...(i > 0 ? [separator(i)] : []),
    ...(line.label ? [<Text key={`l${i}`} style={pdfStyles.appLabel}>{`${line.label}: `}</Text>] : []),
    line.model ? (
      <Text key={`t${i}`} style={modelStyle}>
        {line.text}
      </Text>
    ) : (
      line.text
    ),
  ]);
}

const fromBlock = (block: TextBlock): SourcedLine => ({ label: block.label, text: block.text, model: block.source.startsWith("model_") });

/** The Unified Answer of a report carrying presentation.answer: note, then each claim's lines, claims separated by a blank line. */
function unifiedAnswerText(synthesis: AdaptiveSynthesisReport): React.ReactNode[] {
  const answer = presentUnifiedAnswer(synthesis);
  const groups: SourcedLine[][] = [
    [...(answer.note ? [fromBlock(answer.note)] : []), ...(answer.claimsHeading ? [{ label: null, text: `${answer.claimsHeading}:`, model: false }] : [])],
    ...answer.claims.map((item) => [item.claim, item.result, item.contested, item.supporters].filter((b): b is TextBlock => !!b).map(fromBlock)),
  ].filter((g) => g.length > 0);
  const lines = groups.flat();
  const groupStarts = new Set(groups.map((g) => lines.indexOf(g[0])));
  return sourcedLines(lines, (i) => (groupStarts.has(i) ? "\n\n" : "\n"));
}

function LegacyContent({ record }: { record: AdaptiveResearchExportV1 }) {
  const legacy = record.reportSnapshot.legacy!;
  const schema = SCHEMA_REGISTRY[legacy.schemaId];
  const synthesis = legacy.synthesisReport;

  const shownFields = (r: { data?: Record<string, unknown> | null } | undefined) => schema.fields.filter((field) => r?.data?.[field.key] != null);
  const firstShownField = (r: { data?: Record<string, unknown> | null } | undefined) => shownFields(r)[0];

  return (
    <View>
      {synthesis ? (
        <View>
          {synthesis.presentation?.answer ? (
            // R6-1: the Unified Answer's computed note, then each claim with its own computed result, as one text
            // (one paginating element, like the verdict card's lines). Reports persisted before it: unchanged.
            <SectionCard label="Unified answer">
              <Text {...textProps(pdfStyles.bodyText, CARD_CLOSING_PADDING)}>{unifiedAnswerText(synthesis)}</Text>
            </SectionCard>
          ) : (
            <SectionCard label="Panel conclusion">
              <Text {...textProps(pdfStyles.bodyText, CARD_CLOSING_PADDING)}>{synthesis.unifiedAnswer}</Text>
            </SectionCard>
          )}
          <SectionCard label="Where models agree / disagree">
            <VerdictCardBody verdictCard={synthesis.verdictCard} />
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
        <Text
          style={pdfStyles.sectionLabel}
          wrap={false}
          minPresenceAhead={firstShownField(legacy.modelResponses?.[0])?.type === "metric[]" ? METRIC_FIRST_SECTION_LABEL_PRESENCE_AHEAD : SECTION_LABEL_PRESENCE_AHEAD}
        >
          {`Model responses (${legacy.modelResponses?.length ?? 0})`}
        </Text>
        {(legacy.modelResponses ?? []).map((r) => (
          <PaginatingCard
            key={r.modelId}
            heading={<Text style={pdfStyles.modelLabel}>{exportModelIdentityLabel(record.reportSnapshot.runProvenance, r.modelId)}</Text>}
            keepAhead={firstShownField(r)?.type === "metric[]" ? METRIC_FIRST_CARD_HEADING_PRESENCE_AHEAD : CARD_HEADING_PRESENCE_AHEAD}
          >
            {shownFields(r).map((field, idx, shown) => {
                const value = r.data?.[field.key];
                // The last field closes the card: its value's last text carries the closing padding — or, when the
                // value renders nothing, its label does.
                const closesCard = idx === shown.length - 1;
                const valueRenders = fieldValueRenders(field, value);
                // Label and value are siblings, so every label after the first is kept with its value. The first
                // label is kept by the card heading's own guarantee instead (which covers this label's distance).
                const keep = idx > 0 ? { minPresenceAhead: fieldLabelPresenceAhead(field) } : {};
                return [
                  <Text
                    key={`${field.key}-label`}
                    {...textProps(pdfStyles.fieldLabel, closesCard && !valueRenders ? FIELD_CLOSING_PADDING : 0)}
                    wrap={false}
                    {...keep}
                  >
                    {fieldLabel(field.key)}
                  </Text>,
                  // Spacing as padding, not margin: a margin that does not fit would push a fitting value away from its
                  // label. The closing field's value carries the card's closing padding on its last text instead.
                  <View key={`${field.key}-value`} style={closesCard ? undefined : { paddingBottom: FIELD_GAP }}>
                    <FieldValuePdf field={field} value={value} closing={closesCard ? FIELD_CLOSING_PADDING : 0} />
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
