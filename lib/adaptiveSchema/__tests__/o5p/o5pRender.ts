/**
 * Order 5 Contract P — renders one adaptive record through every supported consumer, as text, for the historical
 * parity oracles (captured once at 2c17feee) and the marked-record assertions. The calling spec must mock
 * "@react-pdf/renderer" (string host components) and "@/components/AuthProvider".
 *
 * Representations:
 *   strict bytes    — UI HTML (renderToStaticMarkup), Markdown, LinkedIn, X, memo input, JSON export bytes,
 *                     DOCX word/document.xml
 *   normalized      — memo text (its "Generated:" wall-clock line), PDF (the composer's element tree, functions
 *                     invoked, serialized; real PDF bytes embed a creation date and need the unmocked renderer)
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JSZip from "jszip";
import { Packer } from "docx";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import AdaptiveSynthesisReportView from "@/components/adaptive/AdaptiveSynthesisReportView";
import ListView from "@/components/adaptive/ListView";
import PrimarySynthesisStrip from "@/components/adaptive/PrimarySynthesisStrip";
import PanelEvidenceSection from "@/components/adaptive/PanelEvidenceSection";
import ClaimMatrix from "@/components/adaptive/ClaimMatrix";
import { ReviewGovernanceBody } from "@/components/adaptive/ReviewGovernanceSection";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { buildAdaptiveLinkedInPost, buildAdaptiveMemoInput, buildAdaptiveSynthesisMarkdown, buildAdaptiveXPost } from "@/lib/adaptiveSchema/shareBuilders";
import { generateVerificationMemo, MemoInput } from "@/lib/verification/generateMemo";
import { runModelProvenanceFromResultRow, RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { renderAdaptiveResearchJsonV1 } from "@/lib/adaptiveSchema/jsonExport";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { buildAdaptiveResearchDocxDocument } from "@/lib/docx/AdaptiveResearchDocxDocument";
import type { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import type { ModelResult } from "@/lib/types";

export const QUESTION = "Does raising the minimum wage reduce employment?";

/** The record a consumer receives: the live payload's fields, or a persisted envelope's (same names). */
export interface RecordUnderTest {
  schemaId: string;
  classification: any;
  results: any[];
  alignedClaims?: any[];
  gate?: any;
  synthesisReport?: any;
  trustSummary?: any;
}

/** The memo's only wall-clock field. */
export function normalizeMemo(memo: string): string {
  return memo.replace(/^Generated: .*$/m, "Generated: <normalized>");
}

/** A react-pdf element tree as data: host type, props other than children, children; function components invoked. */
export function serializeElementTree(node: unknown, depth = 0): unknown {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) return node.map((n) => serializeElementTree(n, depth));
  if (typeof node === "object" && "type" in (node as any) && "props" in (node as any)) {
    if (depth > 80) throw new Error("element tree too deep");
    const el = node as { type: any; props: any };
    if (typeof el.type === "function") return serializeElementTree(el.type(el.props), depth + 1);
    const { children, ...rest } = el.props ?? {};
    return { t: String(el.type), p: rest, c: serializeElementTree(children, depth + 1) };
  }
  return String(node);
}

export function provenanceOf(rows: ModelResult[]): RunModelProvenanceFacts[] {
  return rows.map((r) => runModelProvenanceFromResultRow(r as any));
}

function exportRecord(rec: RecordUnderTest, rows: ModelResult[], format: "pdf" | "docx" | "json"): AdaptiveResearchExportV1 | null {
  const legacy = rec as any;
  if (!legacy.synthesisReport && !legacy.alignedClaims) return null;
  const built = buildExportSnapshot({
    question: QUESTION,
    selectedModels: rows.map((r) => r.modelId),
    modelResultsOkByModelId: Object.fromEntries(rows.map((r) => [r.modelId, r.status === "ok" || r.status === "substituted"])),
    runDocument: { perModel: rows.map((r) => ({ modelId: r.modelId, status: r.status, provider: r.provider, requestedModel: r.requestedModel, ...(r.substitutedFrom ? { substitutedFrom: r.substitutedFrom } : {}) })) },
    legacy: { output: { version: 1, generatedAt: "2026-10-01T00:00:00.000Z", ...legacy }, governanceStatus: "approved", governanceMeta: { policyVersion: 3 } },
  });
  return {
    version: 1,
    exportId: "exp-o5p",
    runId: "run-o5p",
    schemaId: rec.schemaId as any,
    schemaFamily: "legacy",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    createdBy: "uid-o5p",
    format,
    artifactStatus: "ready",
    classification: built.classification,
    governanceStatusAtExport: built.governanceStatusAtExport,
    reportSnapshot: built.reportSnapshot,
    exportMetadata: { exportId: "exp-o5p", runId: "run-o5p", schemaVersion: 1, exportedSections: ["reportSnapshot"], createdAt: "2026-10-01T00:00:00.000Z", requestingUser: "uid-o5p", finalReportVersion: 1 },
  } as AdaptiveResearchExportV1;
}

export async function docxDocumentXml(record: AdaptiveResearchExportV1): Promise<string> {
  const bytes = await Packer.toBuffer(buildAdaptiveResearchDocxDocument(record));
  const zip = await JSZip.loadAsync(bytes);
  return zip.files["word/document.xml"].async("string");
}

/** Every consumer's output for one record. Keys are stable; absent consumers are null. */
export async function renderRecord(rec: RecordUnderTest, rows: ModelResult[]): Promise<Record<string, string | null>> {
  const schema = getResultSchema(rec.schemaId as any);
  const prov = provenanceOf(rows);
  const modelIds = rec.results.map((r: any) => r.modelId);
  const report = rec.synthesisReport;
  const gate = rec.gate;
  const html = (el: any, withProv = true) => renderToStaticMarkup(withProv ? createElement(RunModelProvenanceContext.Provider, { value: prov }, el) : el);
  const panelProps = { schema, classification: rec.classification, results: rec.results, alignedClaims: rec.alignedClaims, gate, synthesisReport: report, trustSummary: rec.trustSummary, question: QUESTION, runId: "run-o5p" };

  const out: Record<string, string | null> = {};
  out["ui.panelResponse"] = html(createElement(AdaptivePanelResponse as any, panelProps));
  out["ui.panelResponse.noProvenance"] = html(createElement(AdaptivePanelResponse as any, panelProps), false);
  out["ui.synthesisView"] = report && gate ? html(createElement(AdaptiveSynthesisReportView, { report, gate, alignedClaims: rec.alignedClaims, trustSummary: rec.trustSummary, question: QUESTION, modelsUsed: modelIds, runId: "run-o5p" })) : null;
  out["ui.listView"] = report && gate ? html(createElement(ListView as any, { schema, results: rec.results, alignedClaims: rec.alignedClaims, gate, synthesisReport: report, trustSummary: rec.trustSummary })) : null;
  out["ui.primaryStrip"] = report ? html(createElement(PrimarySynthesisStrip, { synthesisReport: report })) : null;
  out["ui.panelEvidence"] = html(createElement(PanelEvidenceSection as any, { schemaId: rec.schemaId, gate, synthesisReport: report, trustSummary: rec.trustSummary, alignedClaims: rec.alignedClaims, modelsUsed: modelIds, showClaimMatrix: true }));
  out["ui.claimMatrix"] = rec.alignedClaims && rec.alignedClaims.length > 0 ? html(createElement(ClaimMatrix, { claims: rec.alignedClaims, modelIds })) : null;
  out["ui.governance"] = html(
    createElement(ReviewGovernanceBody as any, { loading: false, unavailable: false, detail: null, gate, synthesisReport: report, trustSummary: rec.trustSummary, alignedClaims: rec.alignedClaims, modelsUsed: modelIds, question: QUESTION, runId: "run-o5p", persistenceStatus: "saved" })
  );
  if (report) {
    // The share / memo builders receive the rows, roster and provenance their real call site holds (a marked report is
    // presented from them; an unmarked one ignores them). Added after the 2c17feee capture: unmarked output unchanged.
    const positionInput = { rows: rec.alignedClaims ?? null, roster: modelIds, provenance: prov };
    out["text.markdown"] = (buildAdaptiveSynthesisMarkdown as any)(QUESTION, report, positionInput);
    out["text.linkedin"] = (buildAdaptiveLinkedInPost as any)(QUESTION, report, positionInput);
    out["text.x"] = (buildAdaptiveXPost as any)(QUESTION, report, positionInput);
    const memoInput = (buildAdaptiveMemoInput as any)(QUESTION, report, modelIds, "run-o5p", prov, rec.alignedClaims ?? null);
    out["text.memoInput"] = JSON.stringify(memoInput);
    out["text.memo"] = normalizeMemo(generateVerificationMemo(memoInput));
  } else {
    for (const k of ["text.markdown", "text.linkedin", "text.x", "text.memoInput", "text.memo"]) out[k] = null;
  }
  const json = exportRecord(rec, rows, "json");
  out["export.json"] = json ? renderAdaptiveResearchJsonV1(json).bytes.toString("utf-8") : null;
  const pdf = exportRecord(rec, rows, "pdf");
  out["export.pdfTree"] = pdf ? JSON.stringify(serializeElementTree(AdaptiveResearchDocument({ record: pdf }))) : null;
  const docx = exportRecord(rec, rows, "docx");
  out["export.docxXml"] = docx ? await docxDocumentXml(docx) : null;
  return out;
}

/** Shared claim / video / legacy-research memo inputs: these never carry an adaptive marker, and must render byte-identically. */
export const SHARED_MEMO_INPUTS: Record<string, MemoInput> = {
  "claim.confirmed": { type: "claim", verdict: "confirmed", claim: "The bridge opened in 1937.", consensusScore: 88, confidenceLabel: "High", evidenceQuality: "strong", verificationId: "v-1", agreementPoints: ["Opened 1937"], disagreementPoints: ["Exact day differs"], modelEvidence: [{ modelId: "chatgpt", verdict: "confirmed", confidence: "high", summary: "Yes.", correctParts: ["1937"] }, { modelId: "claude", modelName: "Claude Opus", verdict: "partially_true", confidence: "medium", incorrectParts: ["May 27"] }] },
  "claim.disputed": { type: "claim", verdict: "disputed", claim: "X causes Y.", consensusScore: 40, confidenceLabel: "Low", evidenceQuality: "weak", verificationId: "v-2", agreementPoints: [], disagreementPoints: ["Causality unclear", "Models diverge"], modelEvidence: [{ modelId: "grok", verdict: "disputed", confidence: "low" }] },
  "video.manipulated": { type: "video", verdict: "likely_manipulated", consensusScore: 70, confidenceLabel: "Medium", evidenceQuality: "mixed", verificationId: "v-3", fileName: "clip.mp4", contentType: "ai_generated_deceptive", frameCount: 12, videoMetadata: { duration: 12.5, width: 1920, height: 1080, codec: "h264", fileSize: 1048576, createdAt: null, encodingSoftware: "Lavf", cameraModel: null, hasAudio: true }, metadataFlags: [{ field: "encoder", observation: "re-encoded", severity: "warning" }], agreementPoints: ["Frame artifacts"], disagreementPoints: ["Audio sync"], modelEvidence: [{ modelId: "gemini", verdict: "likely_manipulated", confidence: "medium", manipulationSignals: ["warping"] }] },
  "video.inconclusive": { type: "video", verdict: "inconclusive", consensusScore: 50, confidenceLabel: "Low", evidenceQuality: "weak", verificationId: "v-4", agreementPoints: [], disagreementPoints: [] },
  "research.legacyPanel": { type: "research", question: "Q?", consensusScore: 60, confidenceLabel: "Medium", evidenceQuality: "mixed", verificationId: "r-1", keyFindings: ["F1", "F2"], synthesisAgreements: ["A1"], synthesisDisagreements: ["D1: models diverge"], confidenceAssessment: "Moderate.", modelsUsed: ["ChatGPT", "Claude"] },
  "research.legacyPanelStrong": { type: "research", question: "Q2?", consensusScore: 80, confidenceLabel: "High", evidenceQuality: "strong", verificationId: "r-2", keyFindings: [], synthesisAgreements: [], synthesisDisagreements: [], modelsUsed: [] },
  "claim.carryingAdaptiveMarker": { type: "claim", verdict: "disputed", claim: "Y.", consensusScore: 41, confidenceLabel: "Low", evidenceQuality: "weak", verificationId: "v-5", disagreementPoints: ["Models diverge"], ...({ adaptivePositionPresentation: { reportKind: "adaptive_research", disagreementPositionVersion: 1 } } as any) },
  "video.carryingAdaptiveMarker": { type: "video", verdict: "inconclusive", consensusScore: 52, confidenceLabel: "Low", evidenceQuality: "weak", verificationId: "v-6", disagreementPoints: ["Signals mixed"], ...({ adaptivePositionPresentation: { reportKind: "adaptive_research", disagreementPositionVersion: 1 } } as any) },
  "research.wrongKindMarker": { type: "research", question: "Q4?", consensusScore: 30, confidenceLabel: "Low", evidenceQuality: "weak", verificationId: "r-4", synthesisDisagreements: ["D"], ...({ adaptivePositionPresentation: { reportKind: "legacy_panel", disagreementPositionVersion: 1 } } as any) },
  "research.forgedMarkerNotAdaptive": { type: "research", question: "Q3?", consensusScore: 30, confidenceLabel: "Low", evidenceQuality: "weak", verificationId: "r-3", synthesisDisagreements: ["D"], ...({ adaptivePositionPresentation: { reportKind: "adaptive_research", disagreementPositionVersion: "1" } } as any) },
};
