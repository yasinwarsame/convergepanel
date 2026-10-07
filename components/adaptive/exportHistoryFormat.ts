/**
 * Presentation helpers shared by the Personal export history
 * (`AdaptiveExportHistorySection`) and the Team export history
 * (`TeamResearchExport`, TEAM_EXPORT_E3). Pure formatting only — no data
 * access, no authority.
 */

import { REPORT_STATUS_LABELS, ReportStatusKind } from "@/lib/adaptiveSchema/reportStatus";

export type ExportGovernanceStatusDto =
  | { family: "milestone2"; kind: ReportStatusKind | "superseded"; isOwnerOverride: boolean }
  | { family: "legacy"; status: "approved" | "needs_review" | "blocked" | null };

export function formatLabel(format: string): string {
  if (format === "pdf") return "PDF";
  if (format === "docx") return "DOCX";
  if (format === "json") return "JSON";
  return format.toUpperCase();
}

export function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function governanceLabel(status: ExportGovernanceStatusDto): string {
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

/** Streams a fetched file Response to the browser as a download. */
export async function saveResponseAsDownload(res: Response, fallbackFileName: string): Promise<void> {
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const fileNameMatch = disposition.match(/filename="([^"]+)"/);
  const fileName = fileNameMatch?.[1] || fallbackFileName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
