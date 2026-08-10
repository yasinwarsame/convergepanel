"use client";

/**
 * Adaptive Research Export, Phase 2 — the export-history surface shown
 * alongside `AdaptiveExportButton`. Smallest appropriate UI (mirrors Part
 * 13's instruction not to build a document-management system): a
 * collapsed-by-default list, fetched only on expand (same lazy-fetch
 * discipline as `AdaptiveReviewHistorySection`'s own Part 2 pattern from
 * the Adaptive Synthesis Report work), one row per export, each row's
 * "Regenerate PDF" action fully independent of every other row's state
 * (Part 14 — one failed regeneration must never affect other rows).
 *
 * Wording is deliberately "Regenerate PDF"/"Regenerate DOCX" rather than
 * "Download PDF/DOCX" — bytes are never stored (see researchExport.ts's
 * header comment), so every click genuinely re-renders the document from
 * its frozen snapshot; "Download" would imply a file sitting in storage
 * waiting to be fetched, which is not what happens here.
 *
 * Phase 3 — a historical row's OWN `item.format` drives its action label
 * and file extension; there is no control to change a historical export's
 * format during regeneration (Part 13). A row created as PDF always
 * regenerates PDF; a row created as DOCX always regenerates DOCX — this
 * is enforced server-side (the regeneration route reads `record.format`,
 * never anything client-supplied), this label is purely descriptive of
 * that server-side truth.
 */

import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import { REPORT_STATUS_LABELS, ReportStatusKind } from "@/lib/adaptiveSchema/reportStatus";
import { Card, SectionLabel } from "./shared";

const EXPORT_FLAG_ENABLED = process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED === "true";

export interface AdaptiveExportHistorySectionProps {
  runId?: string | null;
}

interface AdaptiveExportListItem {
  exportId: string;
  reportVersion: number;
  schemaId: string;
  schemaFamily: "milestone2" | "legacy";
  format: string;
  artifactStatus: string;
  createdAt: string;
  createdBy: string;
  governanceStatusAtExport:
    | { family: "milestone2"; kind: ReportStatusKind | "superseded"; isOwnerOverride: boolean }
    | { family: "legacy"; status: "approved" | "needs_review" | "blocked" | null };
  classification: string;
}

type ListState = "idle" | "loading" | "loaded" | "error";

/** "pdf" -> "PDF", "docx" -> "DOCX", "json" -> "JSON" — falls back to an uppercased raw value for any future format this component hasn't been taught about yet, rather than rendering nothing. */
function formatLabel(format: string): string {
  if (format === "pdf") return "PDF";
  if (format === "docx") return "DOCX";
  if (format === "json") return "JSON";
  return format.toUpperCase();
}

function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Same family-typed governance vocabulary as the PDF provenance block itself (AdaptiveResearchDocument.tsx's `governanceStatusDisplay`) — never re-labeled between the two surfaces. */
function governanceLabel(status: AdaptiveExportListItem["governanceStatusAtExport"]): string {
  if (status.family === "milestone2") {
    if (status.kind === "superseded") return "Superseded by a newer export";
    const label = REPORT_STATUS_LABELS[status.kind];
    return status.isOwnerOverride ? `Owner override — ${label}` : label;
  }
  switch (status.status) {
    case "approved":
      return "Reviewed and approved";
    case "needs_review":
      return "Needs review";
    case "blocked":
      return "Blocked by policy";
    default:
      return "Not yet evaluated";
  }
}

function ExportHistoryRow({ runId, item }: { runId: string; item: AdaptiveExportListItem }) {
  const { user, authReady } = useAuth();
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isCurrent = item.artifactStatus === "ready";
  const notReady = item.artifactStatus === "generating" || item.artifactStatus === "failed";

  async function handleRegenerate() {
    setState("loading");
    setErrorMessage(null);
    try {
      const res = await authedFetch(`/api/user/runs/${encodeURIComponent(runId)}/exports/${encodeURIComponent(item.exportId)}`, {
        method: "GET",
        user,
        authReady,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setErrorMessage(body?.message || `Couldn't regenerate this ${formatLabel(item.format)}. Please try again.`);
        setState("error");
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const fileNameMatch = disposition.match(/filename="([^"]+)"/);
      const fileName = fileNameMatch?.[1] || `convergepanel-export-${runId}-v${item.reportVersion}.${item.format}`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setState("idle");
    } catch {
      setErrorMessage(`Couldn't regenerate this ${formatLabel(item.format)}. Please check your connection and try again.`);
      setState("error");
    }
  }

  return (
    <li className="flex flex-col gap-2 border-b border-slate-100 py-2.5 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-slate-800">v{item.reportVersion}</span>
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              isCurrent ? "bg-green-50 text-green-700" : notReady ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600"
            }`}
          >
            {isCurrent ? "Current" : notReady ? item.artifactStatus : "Superseded"}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          {formatCreatedAt(item.createdAt)} · {formatLabel(item.format)} · {governanceLabel(item.governanceStatusAtExport)}
        </p>
      </div>

      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={handleRegenerate}
          disabled={state === "loading" || notReady}
          aria-busy={state === "loading"}
          aria-label={`Regenerate the ${formatLabel(item.format)} for export version ${item.reportVersion}`}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state === "loading" ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" aria-hidden="true" />
              Regenerating…
            </>
          ) : (
            `Regenerate ${formatLabel(item.format)}`
          )}
        </button>
        {state === "error" && errorMessage && (
          <p role="alert" className="max-w-[200px] text-right text-[11px] text-red-600">
            {errorMessage}
          </p>
        )}
      </div>
    </li>
  );
}

export default function AdaptiveExportHistorySection({ runId }: AdaptiveExportHistorySectionProps) {
  const { user, authReady } = useAuth();
  const [listState, setListState] = useState<ListState>("idle");
  const [items, setItems] = useState<AdaptiveExportListItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  if (!EXPORT_FLAG_ENABLED) return null;
  if (!runId) return null;

  async function loadHistory() {
    if (listState === "loading" || listState === "loaded") return;
    setListState("loading");
    setListError(null);
    try {
      const res = await authedFetch(`/api/user/runs/${encodeURIComponent(runId!)}/exports`, {
        method: "GET",
        user,
        authReady,
      });
      if (!res.ok) {
        setListError("Couldn't load export history.");
        setListState("error");
        return;
      }
      const body = await res.json();
      setItems(Array.isArray(body.exports) ? body.exports : []);
      setListState("loaded");
    } catch {
      setListError("Couldn't load export history. Please check your connection.");
      setListState("error");
    }
  }

  return (
    <Card>
      <details onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadHistory()}>
        <summary className="cursor-pointer">
          <SectionLabel>Previous exports</SectionLabel>
        </summary>

        <div className="mt-2">
          {listState === "loading" && <p className="text-sm text-slate-500">Loading export history…</p>}
          {listState === "error" && (
            <p role="alert" className="text-sm text-red-600">
              {listError}
            </p>
          )}
          {listState === "loaded" && items.length === 0 && <p className="text-sm text-slate-500">No previous exports for this report yet.</p>}
          {listState === "loaded" && items.length > 0 && <ul>{items.map((item) => <ExportHistoryRow key={item.exportId} runId={runId} item={item} />)}</ul>}
        </div>
      </details>
    </Card>
  );
}
