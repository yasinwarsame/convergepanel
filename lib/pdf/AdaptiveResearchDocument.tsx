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
import { REPORT_STATUS_LABELS } from "@/lib/adaptiveSchema/reportStatus";
import { CONSENSUS_LABELS, SOURCE_GROUNDING_LABELS } from "@/lib/adaptiveSchema/reportSummary";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { FieldSpec } from "@/lib/adaptiveSchema/types";
import { getModelDisplayNameSafe } from "@/lib/panelModels";
import { COLORS, badgeStyle, pdfStyles } from "./theme";

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

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

function SectionCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={pdfStyles.card} wrap={false}>
      <Text style={pdfStyles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

function governanceStatusDisplay(record: AdaptiveResearchExportV1): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const status = record.governanceStatusAtExport;
  if (status.family === "milestone2") {
    if (status.kind === "superseded") return { label: "Superseded by a newer export", tone: "neutral" };
    const label = REPORT_STATUS_LABELS[status.kind];
    const tone =
      status.kind === "approved" || status.kind === "approved_with_conditions"
        ? "success"
        : status.kind === "rejected"
        ? "danger"
        : status.kind === "changes_requested"
        ? "warning"
        : "neutral";
    return { label: status.isOwnerOverride ? `Owner override — ${label}` : label, tone };
  }
  // Legacy family — the real, distinct 3-value model this schema family
  // actually has. Never relabeled to match the 8-status vocabulary above.
  switch (status.status) {
    case "approved":
      return { label: "Reviewed and approved", tone: "success" };
    case "needs_review":
      return { label: "Needs review", tone: "warning" };
    case "blocked":
      return { label: "Blocked by policy", tone: "danger" };
    default:
      return { label: "Not yet evaluated", tone: "neutral" };
  }
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
      </View>
    </View>
  );
}

function StatusSummary({ record }: { record: AdaptiveResearchExportV1 }) {
  const snapshot = record.reportSnapshot;
  return (
    <SectionCard label="Report status summary">
      <View style={pdfStyles.fieldGrid}>
        <View style={pdfStyles.fieldCell}>
          <Text style={pdfStyles.fieldLabel}>Models</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {snapshot.models.map((m) => (
              <Text key={m.modelId} style={pdfStyles.modelChip}>
                {getModelDisplayNameSafe(m.modelId)}
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
      <SectionCard label="Primary synthesis">
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

/**
 * Formats one object-field's VALUE for display — never JSON.stringify, and
 * never a bare Array.prototype.join() default toString() call, which for
 * an array of objects (e.g. AlignedClaimCell.camps: {label, position}[])
 * silently renders the literal string "[object Object]" per item (a real
 * bug caught during manual PDF inspection). A nested array of primitives
 * joins normally; a nested array of objects extracts each object's own
 * string-valued fields instead.
 */
function formatNestedFieldValue(v: unknown): string {
  if (!Array.isArray(v)) return String(v);
  if (v.length === 0) return "";
  return v
    .map((item) => {
      if (item != null && typeof item === "object") {
        return Object.values(item as Record<string, unknown>)
          .filter((x) => typeof x === "string" || typeof x === "number")
          .join(" — ");
      }
      return String(item);
    })
    .join("; ");
}

/** Generic fallback for any other array-of-object field (claim[]/step[]/scenario[]/etc.) — one bounded block per item, key: value pairs. Matches ModelResponsesSection.tsx's own GenericObjectArrayList fallback. */
function GenericObjectArrayPdf({ items }: { items: Record<string, unknown>[] }) {
  return (
    <View>
      {items.map((item, idx) => (
        <View
          key={idx}
          style={{ marginBottom: 3, paddingBottom: 3, borderBottomWidth: idx < items.length - 1 ? 1 : 0, borderBottomColor: COLORS.borderSoft }}
          wrap={false}
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

function fieldLabel(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
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
            <Text style={{ ...pdfStyles.mutedText, marginBottom: 3 }}>Agreement</Text>
            <Text style={pdfStyles.bodyText}>{synthesis.verdictCard.topConsensus}</Text>
            {synthesis.verdictCard.keyDisagreement && (
              <View style={{ marginTop: 6 }}>
                <Text style={{ ...pdfStyles.mutedText, marginBottom: 3 }}>Disagreement</Text>
                <Text style={pdfStyles.bodyText}>{synthesis.verdictCard.keyDisagreement}</Text>
                {synthesis.verdictCard.disagreementDetail && (
                  <Text style={pdfStyles.mutedText}>{synthesis.verdictCard.disagreementDetail}</Text>
                )}
              </View>
            )}
            {synthesis.verdictCard.caveat && (
              <Text style={{ ...pdfStyles.mutedText, marginTop: 6, color: COLORS.warning }}>{synthesis.verdictCard.caveat}</Text>
            )}
          </SectionCard>
        </View>
      ) : (
        <SectionCard label="Panel conclusion">
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

      {/* Deliberately NOT a SectionCard here (that component forces
          wrap={false} on its whole body) — two models' worth of metrics/
          bull-case/bear-case/assumptions/risk-factors easily exceeds one
          page, and react-pdf's layout engine visibly mis-measures/overlaps
          content inside an over-tall non-wrapping block (confirmed during
          manual PDF inspection). Each MODEL's own card stays non-breaking
          (a single model's fields are always a bounded, reasonable size),
          but the section as a whole is free to paginate normally. */}
      <View style={{ marginBottom: 10 }}>
        <Text style={pdfStyles.sectionLabel}>{`Model responses (${legacy.modelResponses?.length ?? 0})`}</Text>
        {(legacy.modelResponses ?? []).map((r) => (
          <View key={r.modelId} style={pdfStyles.card} wrap={false}>
            <Text style={{ ...pdfStyles.fieldLabel, marginBottom: 4 }}>{getModelDisplayNameSafe(r.modelId)}</Text>
            {schema.fields.map((field) => {
              const value = r.data?.[field.key];
              if (value == null) return null;
              return (
                <View key={field.key} style={{ marginBottom: 6 }}>
                  <Text style={pdfStyles.fieldLabel}>{fieldLabel(field.key)}</Text>
                  <FieldValuePdf field={field} value={value} />
                </View>
              );
            })}
          </View>
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
  return (
    <SectionCard label="Provenance">
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
