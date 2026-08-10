/**
 * Adaptive Research Export, Phase 3 — pure, format-agnostic content
 * derivations shared by every export renderer (PDF, DOCX, and any future
 * format). Extracted from the PDF composer (`lib/pdf/AdaptiveResearchDocument.tsx`,
 * Phase 1) so that adding a second output format never means re-deriving
 * governance labels, timestamp formatting, or nested-field formatting a
 * second time — a single semantic interpretation layer, consumed by
 * however many renderers exist (Part 6: "Reuse the same semantic
 * derivations already used by PDF/live UI where possible. Do not
 * introduce a second interpretation layer.").
 *
 * These functions take only the frozen `AdaptiveResearchExportV1` record
 * (or plain values already extracted from it) and return plain strings/
 * data — no JSX, no docx-library types, no format-specific rendering
 * concerns at all.
 */

import { AdaptiveResearchExportV1 } from "./researchExport";
import { REPORT_STATUS_LABELS } from "./reportStatus";

export function formatExportTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export type GovernanceDisplayTone = "success" | "warning" | "danger" | "neutral";

export interface GovernanceDisplay {
  label: string;
  tone: GovernanceDisplayTone;
}

/**
 * Family-typed governance label — milestone2's real 8-status vocabulary,
 * legacy's real 3-status vocabulary, never force-unified or relabeled
 * (Part 8/9, carried over unchanged from Phase 1/2). The ONLY place this
 * logic lives; both `AdaptiveResearchDocument.tsx` (PDF) and the DOCX
 * composer call this same function.
 */
export function governanceStatusDisplay(record: AdaptiveResearchExportV1): GovernanceDisplay {
  const status = record.governanceStatusAtExport;
  if (status.family === "milestone2") {
    if (status.kind === "superseded") return { label: "Superseded by a newer export", tone: "neutral" };
    const label = REPORT_STATUS_LABELS[status.kind];
    const tone: GovernanceDisplayTone =
      status.kind === "approved" || status.kind === "approved_with_conditions"
        ? "success"
        : status.kind === "rejected"
          ? "danger"
          : status.kind === "changes_requested"
            ? "warning"
            : "neutral";
    return { label: status.isOwnerOverride ? `Owner override — ${label}` : label, tone };
  }
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

/**
 * Formats one object-field's VALUE for display — never JSON.stringify,
 * never a bare Array.prototype.join() default toString() call (which for
 * an array of objects silently renders the literal string "[object
 * Object]" per item — a real bug caught during Phase 1 manual PDF
 * inspection, never reintroduced for DOCX).
 */
export function formatNestedFieldValue(v: unknown): string {
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

export function fieldLabel(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}
