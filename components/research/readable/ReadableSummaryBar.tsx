"use client";

/**
 * #290 Increment 1 — the readable layout's report header (readable mode, Phase 2 pilot schemas only).
 *
 * TopSummaryBar without its Consensus and Source grounding fields: for the pilot schemas those badges are the gate tier
 * and the model-behaviour composite under misleading names (proposal §0.2 defects 1-3), and the readable layout states
 * both, correctly labelled, in TrustSignalsPanel. Report type, Status, Models, Generated, the export control and export
 * history are the same values from the same frozen helpers. TopSummaryBar itself is not edited: it is pinned by the
 * Order 6 boundary suite, and classic mode keeps rendering it unchanged.
 *
 * The export decision is the same single ancillary resolution TopSummaryBar makes: a delegated_read_only caller gets
 * only its own export surfaces, never the Personal components.
 */

import type { AdaptiveModelResult, QueryType } from "@/lib/adaptiveSchema/types";
import { deriveReportStatus, REPORT_STATUS_LABELS, type ReportStatusInput } from "@/lib/adaptiveSchema/reportStatus";
import { getReportTypeLabel } from "@/lib/adaptiveSchema/reportSummary";
import AdaptiveExportButton from "@/components/adaptive/AdaptiveExportButton";
import AdaptiveExportHistorySection from "@/components/adaptive/AdaptiveExportHistorySection";
import { resolveAdaptiveAncillaryPresentation, type AdaptiveAncillaryPresentation } from "@/components/adaptive/adaptiveAncillaryPresentation";

export interface ReadableSummaryBarProps {
  schemaId: QueryType;
  results: AdaptiveModelResult[];
  runId?: string | null;
  generatedAt?: string;
  persistenceStatus?: ReportStatusInput["persistenceStatus"];
  humanReview?: ReportStatusInput["humanReview"];
  reviewRouting?: ReportStatusInput["reviewRouting"];
  ancillaryPresentation?: AdaptiveAncillaryPresentation;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-cp-muted">{label}</p>
      <div className="mt-0.5 text-sm text-cp-text">{children}</div>
    </div>
  );
}

function formatGeneratedAt(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function ReadableSummaryBar(props: ReadableSummaryBarProps) {
  const { schemaId, results, runId, generatedAt, persistenceStatus, humanReview, reviewRouting } = props;
  const status = deriveReportStatus({ humanReview, reviewRouting, persistenceStatus });
  const statusLabel = status.isOwnerOverride ? `Owner override — ${REPORT_STATUS_LABELS[status.kind]}` : REPORT_STATUS_LABELS[status.kind];
  const modelCount = results.length;
  const okCount = results.filter((r) => r.ok).length;

  const ancillary = resolveAdaptiveAncillaryPresentation(props.ancillaryPresentation);
  const exportControl = ancillary.kind === "delegated_read_only" ? (ancillary.exportSurface ?? null) : <AdaptiveExportButton runId={runId} />;
  const exportHistory = ancillary.kind === "delegated_read_only" ? (ancillary.exportHistorySurface ?? null) : <AdaptiveExportHistorySection runId={runId} />;

  return (
    <>
      <div data-readable-tier="header" className="rounded-xl border border-cp-border bg-cp-raised p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
          <div className="sm:min-w-[160px]">
            <Field label="Report type">
              <span className="font-semibold">{getReportTypeLabel(schemaId)}</span>
            </Field>
          </div>
          <div className="sm:min-w-[220px] sm:flex-1">
            <Field label="Status">
              <span title={status.conditions?.join("; ")}>{statusLabel}</span>
            </Field>
          </div>
          {exportControl}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-cp-border-soft pt-3">
          <Field label="Models">{modelCount > 0 ? `${okCount} of ${modelCount}` : "—"}</Field>
          <Field label="Generated">{formatGeneratedAt(generatedAt)}</Field>
        </div>
      </div>
      {exportHistory}
    </>
  );
}
