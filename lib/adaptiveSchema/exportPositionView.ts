/**
 * Order 5 (Contract P): the position-safe view of an exported legacy-family report, for the PDF and DOCX composers.
 * The export snapshot already carries everything the view needs — the stored rows (legacy.alignedClaims), the
 * dispatched slots (reportSnapshot.models) and the frozen per-slot provenance (reportSnapshot.runProvenance) — so the
 * composers state positions exactly as the report view does. The JSON export is not built from this view: it keeps the
 * stored report verbatim. An unmarked report is returned unchanged.
 *
 * Pure and client-safe: no "server-only", no I/O.
 */

import type { AdaptiveResearchExportV1 } from "./researchExport";
import type { AdaptiveSynthesisReport } from "./types";
import { readFrozenRunProvenance } from "./exportRunProvenance";
import { runModelProvenanceFromExport } from "@/lib/panel/runModelIdentity";
import { PositionView, positionView, presentPositionSafeReport } from "./positionPresentation";

export function exportPositionSafeReport(record: AdaptiveResearchExportV1): { report: AdaptiveSynthesisReport | undefined; view: PositionView | null } {
  const legacy = record.reportSnapshot.legacy;
  const stored = legacy?.synthesisReport;
  if (!legacy || !stored) return { report: stored, view: null };
  const roster = (record.reportSnapshot.models ?? []).map((m) => m.modelId as string);
  const frozen = readFrozenRunProvenance(record.reportSnapshot.runProvenance);
  // A pre-6.2b export carries no frozen provenance: slots are then named by their logical slot only.
  const provenance = frozen ? roster.map((modelId) => runModelProvenanceFromExport(frozen, modelId)) : null;
  const report = presentPositionSafeReport(stored, { rows: legacy.alignedClaims, roster, provenance });
  return { report, view: positionView(report) };
}

/** The section heading the composers use for the verdict card's two claims on a marked report. */
export const MARKED_VERDICT_SECTION_HEADING = "Top claim and key unresolved claim";
