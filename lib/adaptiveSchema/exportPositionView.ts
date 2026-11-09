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
import { readFrozenRunExecutionProvenance } from "./exportRunProvenance";
import { runModelProvenanceFromExport, type RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";
import { PositionView, VERDICT_SECTION_HEADINGS, positionView, presentPositionSafeReport } from "./positionPresentation";
import { independenceQualification, qualifiedTopHeading, runIndependence, type QualifiedIndependence } from "./verdictIndependence";

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

/** The composers' fixed top sub-label, kept when the top claim itself is supported by independent executing models. */
const EXPORT_TOP_LABEL = "Agreement";

function verdictIndependence(report: AdaptiveSynthesisReport | undefined): ExportVerdictIndependence | null {
  const q = independenceQualification(report);
  // c16: the section states the run's slots as a whole (its key row, too, is counted by panel slot), not only the top.
  const t = q?.top ?? q?.run;
  if (!q || !t) return null;
  return {
    sectionHeading: t.kind === "unverified" ? EXPORT_VERDICT_SECTION_INDEPENDENCE_UNVERIFIED : EXPORT_VERDICT_SECTION_COUNTED_BY_EXECUTING_MODEL,
    topHeading: q.top ? qualifiedTopHeading(q.top, q.topStatus) : EXPORT_TOP_LABEL,
  };
}

function exportRoster(record: AdaptiveResearchExportV1): string[] {
  return (record.reportSnapshot.models ?? []).map((m) => m.modelId as string);
}

/**
 * The export's per-slot provenance for judging model independence. A pre-6.2b export carries no frozen provenance
 * (owner ruling, c16 MINOR-3): every slot is then a slot whose execution is NOT RECORDED — no `substituted` fact — so
 * every agreement statement is stated as "model independence unverified"; slot names stay the logical slot only (the
 * labels read `substituted === true` alone) and no execution data is manufactured. A version-2 snapshot's frozen
 * per-slot outcome becomes each slot's recorded status (runModelProvenanceFromExport); a version-1 entry has none, so
 * the shared gate reads the export as "model independence unverified" (Order 29 A1 / A2, owner-accepted).
 */
function exportSlotProvenance(record: AdaptiveResearchExportV1): RunModelProvenanceFacts[] {
  const roster = exportRoster(record);
  const frozen = readFrozenRunExecutionProvenance(record.reportSnapshot.runProvenance);
  return frozen ? roster.map((modelId) => runModelProvenanceFromExport(frozen, modelId)) : roster.map((modelId) => ({ modelId }));
}

/**
 * The exported run's model independence (the report status summary's level): null when every slot is its own recorded
 * executing model; a pre-6.2b export (no frozen provenance) is unverified. Only a gate-scored legacy-family report has
 * such a level; any other export → null (its summary is unchanged).
 */
export function exportRunIndependence(record: AdaptiveResearchExportV1): QualifiedIndependence | null {
  if (!record.reportSnapshot.legacy?.synthesisReport) return null;
  return runIndependence(exportSlotProvenance(record));
}

export function exportPositionSafeReport(record: AdaptiveResearchExportV1): { report: AdaptiveSynthesisReport | undefined; view: PositionView | null; independence: ExportVerdictIndependence | null } {
  const legacy = record.reportSnapshot.legacy;
  const stored = legacy?.synthesisReport;
  if (!legacy || !stored) return { report: stored, view: null, independence: null };
  const roster = exportRoster(record);
  const provenance = exportSlotProvenance(record);
  // An unmarked report is returned as stored, except that agreement statements whose slots are not independent
  // executing models are stated by their executing models (the frozen provenance decides; a pre-6.2b export records
  // none, so its model independence is stated as unverified — nothing is inferred).
  const report = presentPositionSafeReport(stored, { rows: legacy.alignedClaims, roster, provenance });
  const view = positionView(report);
  return { report, view, independence: view ? null : verdictIndependence(report) };
}

/** The composers' verdict section heading on a marked report whose top and key rows are claims (otherwise PositionView.verdict.sectionHeading names what they are). */
export const MARKED_VERDICT_SECTION_HEADING = VERDICT_SECTION_HEADINGS.claim;
