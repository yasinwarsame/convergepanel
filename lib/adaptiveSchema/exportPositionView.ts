/**
 * Order 5 (Contract P): the position-safe view of an exported legacy-family report, for the PDF and DOCX composers.
 * The export snapshot already carries everything the view needs — the stored rows (legacy.alignedClaims), the
 * dispatched slots (reportSnapshot.models) and the frozen per-slot provenance (reportSnapshot.runProvenance) — so the
 * composers state positions exactly as the report view does. The JSON export is not built from this view: it keeps the
 * stored report verbatim. An unmarked report is returned unchanged unless its agreement statements need their executing
 * models stated (verdictIndependence.ts), with `independence` carrying the verdict section's headings in that case.
 *
 * Pure and client-safe: no "server-only", no I/O.
 */

import type { AdaptiveResearchExportV1 } from "./researchExport";
import type { AdaptiveSynthesisReport } from "./types";
import { readFrozenRunProvenance } from "./exportRunProvenance";
import { runModelProvenanceFromExport } from "@/lib/panel/runModelIdentity";
import { PositionView, VERDICT_SECTION_HEADINGS, positionView, presentPositionSafeReport } from "./positionPresentation";
import { independenceQualification, qualifiedTopHeading } from "./verdictIndependence";

/**
 * An UNMARKED report's verdict section headings when its top claim's supporting slots are not independent executing
 * models (verdictIndependence.ts): the section is "Where models agree / disagree (counted by executing model)" or
 * "(model independence unverified)", and the top claim is headed as on the report view. Null otherwise — the composers
 * then use their fixed headings, exactly as before.
 */
export interface ExportVerdictIndependence {
  sectionHeading: string;
  topHeading: string;
}

export const EXPORT_VERDICT_SECTION_COUNTED_BY_EXECUTING_MODEL = "Where models agree / disagree (counted by executing model)";
export const EXPORT_VERDICT_SECTION_INDEPENDENCE_UNVERIFIED = "Where models agree / disagree (model independence unverified)";

function verdictIndependence(report: AdaptiveSynthesisReport | undefined): ExportVerdictIndependence | null {
  const q = independenceQualification(report);
  if (!q?.top) return null;
  return {
    sectionHeading: q.top.kind === "unverified" ? EXPORT_VERDICT_SECTION_INDEPENDENCE_UNVERIFIED : EXPORT_VERDICT_SECTION_COUNTED_BY_EXECUTING_MODEL,
    topHeading: qualifiedTopHeading(q.top, q.topStatus),
  };
}

export function exportPositionSafeReport(record: AdaptiveResearchExportV1): { report: AdaptiveSynthesisReport | undefined; view: PositionView | null; independence: ExportVerdictIndependence | null } {
  const legacy = record.reportSnapshot.legacy;
  const stored = legacy?.synthesisReport;
  if (!legacy || !stored) return { report: stored, view: null, independence: null };
  const roster = (record.reportSnapshot.models ?? []).map((m) => m.modelId as string);
  const frozen = readFrozenRunProvenance(record.reportSnapshot.runProvenance);
  // A pre-6.2b export carries no frozen provenance: slots are then named by their logical slot only.
  const provenance = frozen ? roster.map((modelId) => runModelProvenanceFromExport(frozen, modelId)) : null;
  // An unmarked report is returned as stored, except that agreement statements whose supporting slots are not
  // independent executing models are stated by their executing models (the frozen provenance decides; without it,
  // nothing is inferred).
  const report = presentPositionSafeReport(stored, { rows: legacy.alignedClaims, roster, provenance });
  const view = positionView(report);
  return { report, view, independence: view ? null : verdictIndependence(report) };
}

/** The composers' verdict section heading on a marked report whose top and key rows are claims (otherwise PositionView.verdict.sectionHeading names what they are). */
export const MARKED_VERDICT_SECTION_HEADING = VERDICT_SECTION_HEADINGS.claim;
