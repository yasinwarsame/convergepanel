/**
 * Generates clean, professional verification memos for journalists.
 * Supports claim verification, video verification, and research synthesis.
 *
 * The memo is designed to be saved, shared internally, and cited in
 * editorial process — not as a definitive fact-check but as a structured
 * verification artifact showing what multiple AI models independently found.
 */

import { formatVerdictLabel } from "./shareText";
import { RUN_MODEL_FAMILY_NAMES } from "@/lib/panel/runModelIdentity";

export interface MemoInput {
  type: "claim" | "video" | "research";

  verdict?: string;
  consensusScore: number;
  confidenceLabel: string;
  evidenceQuality: string;
  verificationId: string;
  agreementPoints?: string[];
  disagreementPoints?: string[];
  modelEvidence?: Array<{
    modelId: string;
    modelName?: string;
    status?: string;
    verdict: string;
    confidence: string;
    summary?: string;
    correctParts?: string[];
    incorrectParts?: string[];
    unverifiableParts?: string[];
    manipulationSignals?: string[];
    authenticitySignals?: string[];
    productionSignals?: string[];
    deceptionIndicators?: string[];
    compressionNotes?: string[];
    limitations?: string[];
  }>;

  claim?: string;

  /** Aggregate video content type (plurality across models). */
  contentType?: string;

  fileName?: string;
  videoMetadata?: {
    duration?: number;
    width?: number;
    height?: number;
    codec?: string;
    fileSize?: number;
    createdAt?: string | null;
    encodingSoftware?: string | null;
    cameraModel?: string | null;
    hasAudio?: boolean;
  };
  metadataFlags?: Array<{ field: string; observation: string; severity: string }>;
  frameCount?: number;

  question?: string;
  keyFindings?: string[];
  synthesisAgreements?: string[];
  synthesisDisagreements?: string[];
  confidenceAssessment?: string;
  modelsUsed?: string[];
  /**
   * Research (legacy panel) memo only: the number of INDEPENDENT executing models among the usable responses (slots
   * answered by one substitute model are one model). When supplied it is the model count the memo states, and below two
   * the memo states no consensus score and no "where models agree" section. Absent → exactly the memo as before.
   */
  independentModelCount?: number;

  /**
   * Research (legacy panel) memo only: true when two or more slots answered but the run's rows do not record which
   * models executed (the gate's coverage "unverified"): the memo then withholds the consensus score and the cross-model
   * evidence quality and states no "where models agree / disagree" sections. Absent / false → exactly the memo as before.
   */
  researchIndependenceUnverified?: boolean;

  /**
   * C-a (E11): a research run whose answering slots outnumber its independent executing models (PC, corrected D-4 gate):
   * the score and the "independently" sentence are stated over answering slots. Absent → exactly the memo as before.
   */
  researchSlotCounts?: { answeredSlots: number; independentModels: number };

  /** C-a (E14): a label printed under CONFIDENCE ASSESSMENT (the text is the saved synthesis's own). Absent → as before. */
  confidenceAssessmentLabel?: string;

  /**
   * Research (legacy panel) memo only: the stored differences that are NOT disagreements between independent executing
   * models (`PanelVerdict.recordedDifferences`), stated in their own section with topic, reason and each position named
   * by its executing model — never under "where models disagree". Absent / empty → exactly the memo as before.
   */
  researchRecordedDifferences?: ReadonlyArray<{
    topic: string;
    whyTheyDiffer: string | null;
    basisText: string;
    positions: ReadonlyArray<{ voice: string; position: string }>;
  }>;

  /**
   * Claim memo only: whether the verification's stored rows prove >= 2 independent executing models with a usable answer
   * (`ClaimVerificationClientPayload.modelIndependence`). "insufficient" / "unverified" → no consensus score, no
   * cross-model evidence quality, the verdict stated as one model's assessment (or with unverified coverage), and no
   * "where models agree / disagree" sections. Absent → exactly the memo as before (callers that hold a payload always
   * pass it; lib/verification/claimConsensusPresentation.ts fails a missing value closed to "unverified").
   */
  claimModelIndependence?: "independent" | "insufficient" | "unverified";

  /**
   * C-b (CB-11): claim memo only, with `claimModelIndependence: "independent"` — the shared gate's counts over the
   * verification's rows (lib/panel/executionIdentity.ts): K independent executing models over M answering slots. The
   * memo then states K (never the number of rows: a failed slot is not an answer), names the answering slots only, and
   * states the slots when K < M (a substitute model that answered several slots counts once). Absent → as before.
   */
  claimExecution?: { independentModels: number; answeredSlots: number };

  /**
   * C-b (CB-12, PQ-2 (a) strict): video memo only — the independence of the video rows by the shared gate. Video rows
   * record no provider, so callers pass "unverified"; anything but "independent" → no consensus score, no cross-model
   * evidence quality, and the stored agreement / disagreement points (kept as recorded) under qualified headings.
   * Absent → exactly the memo as before.
   */
  videoModelIndependence?: "independent" | "insufficient" | "unverified";

  /**
   * Order 5 (Contract P): set ONLY by shareBuilders.buildAdaptiveMemoInput for an adaptive research report marked
   * presentation.disagreementPositionVersion === 1. Its findings, agreements and disagreements are then already stated
   * from the report's rows; the memo takes the adaptive-only path (isMarkedAdaptiveResearchMemo). Claim, video and
   * every other research memo never set it and are generated exactly as before.
   */
  adaptivePositionPresentation?: { reportKind: typeof ADAPTIVE_RESEARCH_REPORT_KIND; disagreementPositionVersion: 1 };
  /**
   * Order 5 (Contract P, F-1): read ONLY on the adaptive-only path — the consensus / majority entries grouped by what
   * their rows are (claims, value comparisons, rows not joined), each group under its own heading.
   */
  adaptiveAgreeGroups?: { heading: string; items: string[] }[];
}

/** The report type of an adaptive research memo (Contract P boundary). */
export const ADAPTIVE_RESEARCH_REPORT_KIND = "adaptive_research" as const;

/**
 * The validated boundary for the adaptive-only memo path: a research memo whose boundary object is exactly
 * { reportKind: "adaptive_research", disagreementPositionVersion: 1 } (own properties, nothing else). A claim or video
 * memo never takes it, whatever it carries; a malformed or partial boundary is ignored (the original path).
 */
export function isMarkedAdaptiveResearchMemo(input: MemoInput): boolean {
  if (input.type !== "research") return false;
  const b = (input as { adaptivePositionPresentation?: unknown }).adaptivePositionPresentation;
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  const keys = Object.keys(b).sort();
  const o = b as Record<string, unknown>;
  return keys.length === 2 && keys[0] === "disagreementPositionVersion" && keys[1] === "reportKind" && o.reportKind === ADAPTIVE_RESEARCH_REPORT_KIND && o.disagreementPositionVersion === 1;
}

/** A slot with no supplied name is named by its family only — never a guessed model version. */
const MEMO_MODEL_FALLBACK: Readonly<Record<string, string>> = RUN_MODEL_FAMILY_NAMES;

export function downloadTextFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatMemoGeneratedAt(d = new Date()): string {
  return (
    d.toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }) + " ET"
  );
}

function modelDisplayName(modelId: string, modelName?: string): string {
  const n = modelName?.trim();
  if (n) return n;
  const id = modelId.trim().toLowerCase();
  return MEMO_MODEL_FALLBACK[id] || modelId;
}

function dedupeCap(lines: (string | undefined | null)[], max = 10): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const t = (raw ?? "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function formatVideoDuration(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function formatFileSize(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) {
    const kb = bytes / 1024;
    return `${kb.toFixed(1)} KB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function severityPrefix(sev: string): string {
  const s = sev.toLowerCase();
  if (s === "suspicious") return "[!]";
  if (s === "warning") return "[~]";
  return "[i]";
}

function claimSummarySentence(verdict: string | undefined): string {
  const v = (verdict ?? "").toLowerCase().replace(/\s+/g, "_");
  if (v === "confirmed")
    return "The models largely supported the claim, with meaningful alignment on the core statement.";
  if (v === "disputed")
    return "Models diverged on important aspects of this claim; treat conclusions as contested.";
  if (v === "partially_true")
    return "The core statement may hold, but models flagged imprecise or debatable details.";
  if (v === "unverifiable")
    return "Models could not verify the claim with sufficient independent evidence or agreement.";
  return "Models evaluated this claim independently; review per-model detail below.";
}

function videoSummarySentence(verdict: string | undefined): string {
  const v = (verdict ?? "").toLowerCase().replace(/\s+/g, "_");
  if (v === "authentic_captured" || v === "authentic")
    return "Independently, vision models treated this as camera-captured content without strong manipulation signals.";
  if (v === "authentic_produced")
    return "Models largely read this as legitimately produced or animated content rather than deceptive fakery.";
  if (v === "likely_manipulated")
    return "Multiple models noted patterns or artifacts consistent with deceptive manipulation.";
  if (v === "inconclusive")
    return "Signals were mixed; models could not reach a firm authenticity conclusion.";
  if (v === "insufficient")
    return "Available frames or context were too limited for confident assessment.";
  return "Vision-capable models reviewed extracted frames and metadata independently.";
}

const videoContentTypeMemoLabels: Record<string, string> = {
  camera_footage: "Camera Footage",
  animation: "Animation",
  screen_recording: "Screen Recording",
  ai_generated_creative: "AI-Generated (Creative/Non-Deceptive)",
  ai_generated_deceptive: "AI-Generated (Deceptive)",
  mixed: "Mixed Content",
  unknown: "Unknown",
};

function researchSummarySentence(score: number, evidenceQuality: string): string {
  const eq = evidenceQuality.toLowerCase();
  if (score >= 72 && eq === "strong")
    return "Models converged on several themes with comparatively strong evidentiary support.";
  if (score < 45 || eq === "weak")
    return "Themes are contested or thinly evidenced; further reporting and sourcing are advised.";
  if (score >= 72)
    return "Models showed meaningful convergence on major themes in this research pass.";
  return "Models produced overlapping and diverging themes; use findings as a starting point for review.";
}

function formatModelsConsultedGrid(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return "  —";
  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += 3) {
    const chunk = clean.slice(i, i + 3);
    lines.push(`  ${chunk.join("    ")}`);
  }
  return lines.join("\n");
}

/** Claim memo lines when fewer than two independent models answered, or model independence is not recorded. */
export const CLAIM_MEMO_SINGLE_MODEL_VERDICT_NOTE = "one independent model's assessment; not agreement between models";
export const CLAIM_MEMO_UNVERIFIED_VERDICT_NOTE = "independent-model coverage unverified";
export const CLAIM_MEMO_NO_CONSENSUS_LINE =
  "CONSENSUS SCORE: none (fewer than two independent models answered; slots answered by the same substitute model count as one)";
export const CLAIM_MEMO_WITHHELD_CONSENSUS_LINE = "CONSENSUS SCORE: withheld (model independence not recorded)";
export const CLAIM_MEMO_UNVERIFIED_EVIDENCE = "not assessed (model independence not recorded)";
export const CLAIM_MEMO_SINGLE_MODEL_SUMMARY =
  "Fewer than two independent AI models answered this claim, so there is no cross-model agreement to report. Treat the verdict as a single model's assessment.";
export const CLAIM_MEMO_UNVERIFIED_SUMMARY =
  "Which models executed this verification could not be established, so the verdict is not presented as agreement between models.";
export const CLAIM_MEMO_SINGLE_MODEL_METHODOLOGY =
  "This claim was sent to a panel of large language models via ConvergePanel with identical instructions, but fewer than two independent models answered (slots answered by the same substitute model count as one). No cross-model comparison was possible: no consensus score is reported and nothing in this memo reflects agreement between models.";
export const CLAIM_MEMO_UNVERIFIED_METHODOLOGY =
  "This claim was sent to a panel of large language models via ConvergePanel with identical instructions. Which models actually executed could not be established from the stored record, so no consensus score is reported and nothing in this memo is presented as agreement between independent models.";

/** The gate's counts a claim memo may state: only for an "independent" claim with K ≥ 1 and M ≥ K (else null: as before). */
function claimExecutionCounts(input: MemoInput): { independentModels: number; answeredSlots: number } | null {
  const e = input.claimExecution;
  if (input.claimModelIndependence !== "independent" || !e) return null;
  const k = e.independentModels;
  const m = e.answeredSlots;
  if (!Number.isInteger(k) || !Number.isInteger(m) || k < 1 || m < k) return null;
  return { independentModels: k, answeredSlots: m };
}

/** Video memo lines when the video rows do not verify ≥ 2 independent executing models (always, for recorded video rows). */
// The claim memo's "unverified" family, shared (mirrored, not forked).
export const VIDEO_MEMO_UNVERIFIED_VERDICT_NOTE = CLAIM_MEMO_UNVERIFIED_VERDICT_NOTE;
export const VIDEO_MEMO_WITHHELD_CONSENSUS_LINE = CLAIM_MEMO_WITHHELD_CONSENSUS_LINE;
export const VIDEO_MEMO_UNVERIFIED_EVIDENCE = CLAIM_MEMO_UNVERIFIED_EVIDENCE;
export const VIDEO_MEMO_UNVERIFIED_SUMMARY_LEAD = "Which models executed this review could not be established from the stored record, so nothing in this memo is presented as agreement between independent models.";
export const VIDEO_MEMO_NOT_INDEPENDENT_AGREE_HEADING = "POINTS REPEATED ACROSS RESPONSES (NOT AGREEMENT BETWEEN INDEPENDENT MODELS)";
export const VIDEO_MEMO_NOT_INDEPENDENT_DISAGREE_HEADING = "POINTS THAT DIFFER ACROSS RESPONSES (NOT A DISAGREEMENT BETWEEN INDEPENDENT MODELS)";
export const VIDEO_MEMO_UNVERIFIED_METHODOLOGY_TAIL = "Which models actually executed could not be established from the stored record (model independence unverified), so no consensus score is reported.";

function generateClaimMemo(input: MemoInput): string {
  const lines: string[] = [];
  const claim = (input.claim ?? "").trim() || "—";
  const verdictHuman = formatVerdictLabel(input.verdict ?? "");
  const rows = input.modelEvidence ?? [];
  const exec = claimExecutionCounts(input);
  // C-b (CB-11): with the gate's counts the memo states independent executing models over the answering slots only.
  const n = exec ? exec.independentModels : rows.length > 0 ? rows.length : 0;
  const slotsOverModels = exec !== null && exec.answeredSlots > exec.independentModels;
  const modelNamesList = (exec ? rows.filter((m) => m.status === "ok") : rows)
    .map((m) => modelDisplayName(m.modelId, m.modelName))
    .filter((x, i, a) => a.indexOf(x) === i);

  lines.push("VERIFICATION MEMO");
  lines.push("ConvergePanel Multi-Model Claim Verification");
  lines.push(`Generated: ${formatMemoGeneratedAt()}`);
  lines.push("");
  lines.push("CLAIM VERIFIED");
  lines.push(`"${claim}"`);
  lines.push("");
  const coverage = input.claimModelIndependence;
  const noConsensus = coverage === "insufficient" || coverage === "unverified";
  if (noConsensus) {
    lines.push(`VERDICT: ${verdictHuman} (${coverage === "insufficient" ? CLAIM_MEMO_SINGLE_MODEL_VERDICT_NOTE : CLAIM_MEMO_UNVERIFIED_VERDICT_NOTE})`);
    lines.push(coverage === "insufficient" ? CLAIM_MEMO_NO_CONSENSUS_LINE : CLAIM_MEMO_WITHHELD_CONSENSUS_LINE);
    lines.push(`EVIDENCE QUALITY: ${coverage === "insufficient" ? RESEARCH_MEMO_NO_CROSS_MODEL_EVIDENCE : CLAIM_MEMO_UNVERIFIED_EVIDENCE}`);
  } else {
    lines.push(`VERDICT: ${verdictHuman}`);
    lines.push(`CONSENSUS SCORE: ${input.consensusScore}/100 (${input.confidenceLabel} confidence)`);
    lines.push(`EVIDENCE QUALITY: ${input.evidenceQuality}`);
  }
  lines.push("");
  lines.push("SUMMARY");
  lines.push(
    coverage === "insufficient"
      ? CLAIM_MEMO_SINGLE_MODEL_SUMMARY
      : coverage === "unverified"
        ? CLAIM_MEMO_UNVERIFIED_SUMMARY
        : slotsOverModels
          ? `${exec!.answeredSlots} panel slots answered this claim; ${exec!.independentModels} independent executing models wrote those answers. ${claimSummarySentence(input.verdict)}`
          : `${Math.max(1, n)} AI models evaluated this claim independently. ${claimSummarySentence(input.verdict)}`
  );
  lines.push("");

  const modelLines = rows.map((m) => {
    const name = modelDisplayName(m.modelId, m.modelName);
    const st = m.status as string | undefined;
    if (st === "parse_error" || st === "failed") {
      return `  ${name}:    (${st === "parse_error" ? "Parse error" : "Failed"})`;
    }
    return `  ${name}:    ${formatVerdictLabel(m.verdict)} (${m.confidence} confidence)`;
  });
  if (modelLines.length) {
    lines.push("MODEL VERDICTS");
    lines.push(...modelLines);
    lines.push("");
  }

  // Below two independent models (or with unverified coverage) nothing is agreement or disagreement between models.
  const agree = noConsensus ? [] : dedupeCap(input.agreementPoints ?? []);
  if (agree.length) {
    lines.push("WHERE MODELS AGREE");
    agree.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const disagree = noConsensus ? [] : dedupeCap(input.disagreementPoints ?? []);
  if (disagree.length) {
    lines.push("WHERE MODELS DISAGREE");
    disagree.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const correct = dedupeCap(
    (input.modelEvidence ?? []).flatMap((m) => m.correctParts ?? [])
  );
  if (correct.length) {
    lines.push("CORRECT PARTS");
    correct.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const incorrect = dedupeCap(
    (input.modelEvidence ?? []).flatMap((m) => m.incorrectParts ?? [])
  );
  if (incorrect.length) {
    lines.push("IMPRECISE OR INCORRECT PARTS");
    incorrect.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const unver = dedupeCap(
    (input.modelEvidence ?? []).flatMap((m) => m.unverifiableParts ?? [])
  );
  if (unver.length) {
    lines.push("UNVERIFIABLE PARTS");
    unver.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const nn = Math.max(1, n);
  const namesPhrase =
    modelNamesList.length > 0 ? ` (${modelNamesList.join(", ")})` : "";

  lines.push("METHODOLOGY");
  lines.push(
    noConsensus
      ? coverage === "insufficient"
        ? CLAIM_MEMO_SINGLE_MODEL_METHODOLOGY
        : CLAIM_MEMO_UNVERIFIED_METHODOLOGY
      : slotsOverModels
        ? `This claim was sent to ${exec!.answeredSlots} answering panel slots${namesPhrase} via ConvergePanel, written by ${exec!.independentModels} independent executing models (a model that answered several slots counts once). Each slot received the claim with identical instructions to evaluate accuracy, identify correct and incorrect parts, and provide evidence. The consensus score was computed over answering slots, so it is not a count of independent models.`
        : `This claim was independently evaluated by ${nn} large language model${nn === 1 ? "" : "s"}${namesPhrase} via ConvergePanel. Each model received the claim with identical instructions to evaluate accuracy, identify correct and incorrect parts, and provide evidence. Models were not shown each other's responses. The consensus score reflects the degree of agreement across models weighted by evidence quality.`
  );
  lines.push("");
  lines.push("DISCLAIMER");
  lines.push(
    "This is an AI-assisted verification, not a definitive fact-check. Results should inform editorial judgment, not replace it. AI models have known limitations including training data cutoffs, potential biases, and the possibility of confident but incorrect outputs."
  );
  lines.push("");
  lines.push(`Report ID: ${input.verificationId || "—"}`);
  lines.push("Source: convergepanel.com");

  return lines.join("\n").trimEnd() + "\n";
}

function generateVideoMemo(input: MemoInput): string {
  const lines: string[] = [];
  const meta = input.videoMetadata ?? {};
  const fileName = (input.fileName ?? "").trim() || "—";
  const verdictHuman = formatVerdictLabel(input.verdict ?? "");
  const models = input.modelEvidence ?? [];
  const n = Math.max(1, models.length);
  const modelNamesList = models
    .map((m) => modelDisplayName(m.modelId, m.modelName))
    .filter((x, i, a) => a.indexOf(x) === i);
  const frames = input.frameCount ?? 0;

  lines.push("VERIFICATION MEMO");
  lines.push("ConvergePanel Video Authenticity Review");
  lines.push(`Generated: ${formatMemoGeneratedAt()}`);
  lines.push("");
  lines.push("VIDEO ANALYZED");
  lines.push(`File: ${fileName}`);
  lines.push(
    `Duration: ${formatVideoDuration(meta.duration)} | Resolution: ${meta.width ?? "—"}x${meta.height ?? "—"} | Codec: ${meta.codec ?? "—"}`
  );
  lines.push(
    `File size: ${formatFileSize(meta.fileSize)} | Frames analyzed: ${frames || "—"}`
  );
  lines.push(`Creation date: ${meta.createdAt?.trim() || "Not available"}`);
  lines.push(`Encoding software: ${meta.encodingSoftware?.trim() || "Not identified"}`);
  lines.push(`Camera / device: ${meta.cameraModel?.trim() || "Not identified"}`);
  lines.push(`Has audio: ${meta.hasAudio === true ? "Yes" : meta.hasAudio === false ? "No" : "—"}`);
  lines.push("");
  // C-b (CB-12, PQ-2 strict): the video rows record no provider, so independence is unverified — no consensus score,
  // no cross-model evidence quality, no "independently" count; the stored points are kept under qualified headings.
  const videoQualified = input.videoModelIndependence !== undefined && input.videoModelIndependence !== "independent";
  lines.push(videoQualified ? `VERDICT: ${verdictHuman} (${VIDEO_MEMO_UNVERIFIED_VERDICT_NOTE})` : `VERDICT: ${verdictHuman}`);
  const ct = (input.contentType ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (ct && ct !== "unknown") {
    lines.push(`CONTENT TYPE: ${videoContentTypeMemoLabels[ct] ?? input.contentType}`);
  }
  if (videoQualified) {
    lines.push(VIDEO_MEMO_WITHHELD_CONSENSUS_LINE);
    lines.push(`EVIDENCE QUALITY: ${VIDEO_MEMO_UNVERIFIED_EVIDENCE}`);
  } else {
    lines.push(`CONSENSUS SCORE: ${input.consensusScore}/100 (${input.confidenceLabel} confidence)`);
    lines.push(`EVIDENCE QUALITY: ${input.evidenceQuality}`);
  }
  lines.push("");
  lines.push("SUMMARY");
  lines.push(
    videoQualified
      ? `${VIDEO_MEMO_UNVERIFIED_SUMMARY_LEAD} ${models.length} panel slot${models.length === 1 ? "" : "s"} reviewed ${frames || "multiple"} frames extracted at regular intervals.`
      : `${n} vision-capable AI models independently analyzed ${frames || "multiple"} frames extracted at regular intervals. ${videoSummarySentence(input.verdict)}`
  );
  lines.push("");

  const modelLines = models.map((m) => {
    const name = modelDisplayName(m.modelId, m.modelName);
    return `  ${name}:    ${formatVerdictLabel(m.verdict)} (${m.confidence} confidence)`;
  });
  if (modelLines.length) {
    lines.push("MODEL VERDICTS");
    lines.push(...modelLines);
    lines.push("");
  }

  const agree = dedupeCap(input.agreementPoints ?? []);
  if (agree.length) {
    lines.push(videoQualified ? VIDEO_MEMO_NOT_INDEPENDENT_AGREE_HEADING : "WHERE MODELS AGREE");
    agree.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const disagree = dedupeCap(input.disagreementPoints ?? []);
  if (disagree.length) {
    lines.push(videoQualified ? VIDEO_MEMO_NOT_INDEPENDENT_DISAGREE_HEADING : "WHERE MODELS DISAGREE");
    disagree.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const flags = input.metadataFlags ?? [];
  if (flags.length) {
    lines.push("METADATA FLAGS");
    flags.slice(0, 10).forEach((f) => {
      lines.push(`${severityPrefix(f.severity)} ${f.field}: ${f.observation}`);
    });
    lines.push("");
  }

  const manip = dedupeCap(models.flatMap((m) => m.manipulationSignals ?? []));
  if (manip.length) {
    lines.push("MANIPULATION SIGNALS");
    manip.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const prod = dedupeCap(models.flatMap((m) => m.productionSignals ?? []));
  if (prod.length) {
    lines.push("PRODUCTION SIGNALS");
    prod.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const decep = dedupeCap(models.flatMap((m) => m.deceptionIndicators ?? []));
  if (decep.length) {
    lines.push("DECEPTION INDICATORS");
    decep.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const auth = dedupeCap(models.flatMap((m) => m.authenticitySignals ?? []));
  if (auth.length) {
    lines.push("AUTHENTICITY SIGNALS");
    auth.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const namesPhrase =
    modelNamesList.length > 0 ? ` (${modelNamesList.join(", ")})` : "";

  lines.push("METHODOLOGY");
  lines.push(
    videoQualified
      ? `${frames || "Multiple"} frames were extracted at regular intervals from the uploaded video and sent to ${models.length} panel slot${models.length === 1 ? "" : "s"}${namesPhrase} via ConvergePanel with identical instructions to look for signs of AI generation, deepfake artifacts, and manipulation indicators. Video metadata was extracted from the file container and included in the analysis. ${VIDEO_MEMO_UNVERIFIED_METHODOLOGY_TAIL}`
      : `${frames || "Multiple"} frames were extracted at regular intervals from the uploaded video and sent to ${n} vision-capable AI model${n === 1 ? "" : "s"}${namesPhrase} via ConvergePanel. Each model independently analyzed frames for signs of AI generation, deepfake artifacts, and manipulation indicators. Models were not shown each other's responses. Video metadata was extracted from the file container and included in the analysis.`
  );
  lines.push("");
  lines.push("DISCLAIMER");
  lines.push(
    "This is an AI-assisted video authenticity review, not forensic analysis. Results should inform editorial judgment, not replace it. AI vision models have known limitations including difficulty distinguishing compression artifacts from manipulation, and the possibility of false positives with heavily compressed or stylized content. Do not use this report as legal or forensic evidence."
  );
  lines.push("");
  lines.push(`Report ID: ${input.verificationId || "—"}`);
  lines.push("Source: convergepanel.com");

  return lines.join("\n").trimEnd() + "\n";
}

/** Research memo evidence-quality line when fewer than two independent models responded. */
export const RESEARCH_MEMO_NO_CROSS_MODEL_EVIDENCE = "not assessed (fewer than two independent models responded)";

/** Research memo METHODOLOGY when fewer than two independent models responded: no consensus or convergence is claimed. */
export const RESEARCH_MEMO_SINGLE_MODEL_METHODOLOGY =
  "This question was sent to a panel of large language models via ConvergePanel with identical instructions, but fewer than two independent models responded (slots answered by the same substitute model count as one). No cross-model comparison was possible: no consensus score is reported and nothing in this memo reflects agreement or convergence between models.";

/** Research memo section of stored differences that are not disagreements between independent models. */
export const RESEARCH_MEMO_RECORDED_DIFFERENCES_HEADING = "RECORDED DIFFERENCES NOT COUNTED AS MODEL DISAGREEMENTS";
export const RESEARCH_MEMO_RECORDED_DIFFERENCES_NOTE =
  "The synthesis recorded these differing positions, but they are not counted as disagreements between independent models. Each position is named by the model that actually answered.";

/** Research memo lines when two or more slots answered but which models executed is not recorded. */
export const RESEARCH_MEMO_UNVERIFIED_SUMMARY =
  "Which models actually answered this question could not be established, so nothing in this memo is presented as agreement or disagreement between models.";
export const RESEARCH_MEMO_UNVERIFIED_METHODOLOGY =
  "This question was sent to a panel of large language models via ConvergePanel with identical instructions, but which models actually executed could not be established (model independence unverified). No consensus score is reported and nothing in this memo reflects agreement or convergence between models.";

/** Order 35 A (F-1): research memo lines when no independent model returned a successful response. */
export const RESEARCH_MEMO_NO_RESPONSES_CONSENSUS_LINE = "CONSENSUS SCORE: none (no successful model responses; consensus cannot be assessed)";
export const RESEARCH_MEMO_NO_RESPONSES_EVIDENCE = "not assessed (no successful model responses)";
export const RESEARCH_MEMO_NO_RESPONSES_SUMMARY =
  "No model responses are available for this question, so consensus cannot be assessed and nothing in this memo is presented as agreement between models.";
export const RESEARCH_MEMO_NO_RESPONSES_METHODOLOGY =
  "This question was sent to a panel of large language models via ConvergePanel with identical instructions. No model returned a successful response, so no consensus score is reported and nothing in this memo reflects agreement or convergence between models.";

function generateResearchMemo(input: MemoInput): string {
  const lines: string[] = [];
  const q = (input.question ?? "").trim() || "—";
  const findings = dedupeCap(input.keyFindings ?? []);
  const agree = dedupeCap(input.synthesisAgreements ?? []);
  const disagree = dedupeCap(input.synthesisDisagreements ?? []);
  const independent =
    typeof input.independentModelCount === "number" && Number.isFinite(input.independentModelCount)
      ? Math.max(0, Math.floor(input.independentModelCount))
      : null;
  const n = independent !== null ? Math.max(1, independent) : Math.max(1, input.modelsUsed?.length ?? 0);
  // Fewer than two independent executing models: one model's output is not a consensus.
  const singleModel = independent !== null && independent < 2;
  // Unknown execution identity: no consensus either, stated as unverified (never as one model's output).
  const unverified = !singleModel && input.researchIndependenceUnverified === true;
  // Order 35 A (F-1): no independent model returned a successful response — nothing to assess, never "one model".
  const noResponses = independent === 0;
  const noConsensus = singleModel || unverified;
  const rs = input.researchSlotCounts;
  const slots = !noConsensus && rs && rs.independentModels >= 2 && rs.answeredSlots > rs.independentModels ? rs : null;

  lines.push("VERIFICATION MEMO");
  lines.push("ConvergePanel Multi-Model Research Report");
  lines.push(`Generated: ${formatMemoGeneratedAt()}`);
  lines.push("");
  lines.push("RESEARCH QUERY");
  lines.push(`"${q}"`);
  lines.push("");
  if (unverified) {
    lines.push(CLAIM_MEMO_WITHHELD_CONSENSUS_LINE);
  } else if (noResponses) {
    lines.push(RESEARCH_MEMO_NO_RESPONSES_CONSENSUS_LINE);
  } else if (noConsensus) {
    lines.push("CONSENSUS SCORE: none (fewer than two independent models responded; slots answered by the same substitute model count as one)");
  } else if (slots) {
    lines.push(`CONSENSUS SCORE: ${input.consensusScore}/100 (${input.confidenceLabel} confidence; computed over ${slots.answeredSlots} answering slots by the saved synthesis; ${slots.independentModels} independent executing models)`);
  } else {
    lines.push(`CONSENSUS SCORE: ${input.consensusScore}/100 (${input.confidenceLabel} confidence)`);
  }
  // The stored evidence quality is a cross-model support rollup: with one independent model it measures nothing.
  lines.push(
    unverified
      ? `EVIDENCE QUALITY: ${CLAIM_MEMO_UNVERIFIED_EVIDENCE}`
      : noResponses
        ? `EVIDENCE QUALITY: ${RESEARCH_MEMO_NO_RESPONSES_EVIDENCE}`
        : noConsensus
        ? `EVIDENCE QUALITY: ${RESEARCH_MEMO_NO_CROSS_MODEL_EVIDENCE}`
        : `EVIDENCE QUALITY: ${input.evidenceQuality}`
  );
  lines.push("");
  lines.push("SUMMARY");
  lines.push(
    unverified
      ? RESEARCH_MEMO_UNVERIFIED_SUMMARY
      : noResponses
      ? RESEARCH_MEMO_NO_RESPONSES_SUMMARY
      : noConsensus
      ? "Fewer than two independent AI models responded to this question, so there is no cross-model agreement to report. Treat the findings as a single model's output."
      : slots
        ? `${slots.answeredSlots} panel slots answered this question; ${slots.independentModels} independent executing models wrote those answers. ${researchSummarySentence(input.consensusScore, input.evidenceQuality)}`
        : `${n} AI models researched this question independently. ${researchSummarySentence(input.consensusScore, input.evidenceQuality)}`
  );
  lines.push("");

  if (findings.length) {
    lines.push("KEY FINDINGS");
    findings.forEach((f) => lines.push(`- ${f}`));
    lines.push("");
  }

  if (agree.length && !noConsensus) {
    lines.push("WHERE MODELS AGREE");
    agree.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  // Below two independent models no disagreement between models exists to report.
  if (disagree.length && !noConsensus) {
    lines.push("WHERE MODELS DISAGREE");
    disagree.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const recorded = input.researchRecordedDifferences ?? [];
  if (recorded.length) {
    lines.push(RESEARCH_MEMO_RECORDED_DIFFERENCES_HEADING);
    lines.push(RESEARCH_MEMO_RECORDED_DIFFERENCES_NOTE);
    for (const d of recorded) {
      lines.push(`- ${d.topic} — ${d.basisText}`);
      if (d.whyTheyDiffer) lines.push(`  ${d.whyTheyDiffer}`);
      d.positions.forEach((p) => lines.push(`  ${p.voice}: ${p.position}`));
    }
    lines.push("");
  }

  const assess = (input.confidenceAssessment ?? "").trim();
  if (assess) {
    lines.push("CONFIDENCE ASSESSMENT");
    if (input.confidenceAssessmentLabel) lines.push(input.confidenceAssessmentLabel);
    lines.push(assess);
    lines.push("");
  }

  lines.push("MODELS CONSULTED");
  lines.push(formatModelsConsultedGrid(input.modelsUsed ?? []));
  lines.push("");

  lines.push("METHODOLOGY");
  lines.push(
    unverified
      ? RESEARCH_MEMO_UNVERIFIED_METHODOLOGY
      : noResponses
      ? RESEARCH_MEMO_NO_RESPONSES_METHODOLOGY
      : noConsensus
      ? RESEARCH_MEMO_SINGLE_MODEL_METHODOLOGY
      : slots
        ? `This question was sent to ${slots.answeredSlots} answering panel slots via ConvergePanel, written by ${slots.independentModels} independent executing models (a model that answered several slots counts once). Each slot received identical instructions. The consensus score was computed over answering slots by the saved synthesis, so it is not a count of independent models.`
        : `This question was independently researched by ${n} large language model${n === 1 ? "" : "s"} via ConvergePanel. Each model received identical instructions. Models were not shown each other's responses. Results were synthesized to identify areas of agreement and disagreement. The consensus score reflects the degree of convergence across models weighted by evidence quality and source backing.`
  );
  lines.push("");
  lines.push("DISCLAIMER");
  lines.push(
    "This is an AI-assisted research synthesis, not professional advice. Results should inform human judgment and further investigation, not replace professional counsel. AI models have known limitations including training data cutoffs, potential biases, and the possibility of confident but incorrect outputs."
  );
  lines.push("");
  lines.push(`Report ID: ${input.verificationId || "—"}`);
  lines.push("Source: convergepanel.com");

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Order 5 (Contract P): the memo of a marked adaptive research report. Its sections carry what buildAdaptiveMemoInput
 * stated from the report's rows; nothing here characterizes the panel (no "converged" / "diverging themes", no
 * "where models agree / disagree"). The figure shown is the run certainty, as computed and stored — renamed from
 * "consensus score", never recomputed.
 */
function generateMarkedAdaptiveResearchMemo(input: MemoInput): string {
  const lines: string[] = [];
  const q = (typeof input.question === "string" ? input.question : "").trim() || "—";
  // N-4: on this path a malformed input (non-string items) loses those items rather than throwing.
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((i): i is string => typeof i === "string") : []);
  const findings = dedupeCap(strings(input.keyFindings));
  // F-1: grouped by the builder; an input without groups (not built by buildAdaptiveMemoInput) lists its entries
  // under a neutral heading, never as consensus.
  const agreeGroups = Array.isArray(input.adaptiveAgreeGroups)
    ? input.adaptiveAgreeGroups
        .map((g) => ({ heading: typeof g?.heading === "string" ? g.heading : "", items: dedupeCap(strings(g?.items)) }))
        .filter((g) => g.heading && g.items.length)
    : [{ heading: "Scored rows", items: dedupeCap(strings(input.synthesisAgreements)) }].filter((g) => g.items.length);
  const unresolved = dedupeCap(strings(input.synthesisDisagreements));
  const slots = strings(input.modelsUsed);
  const n = Math.max(1, slots.length);

  lines.push("VERIFICATION MEMO");
  lines.push("ConvergePanel Multi-Model Research Report");
  lines.push(`Generated: ${formatMemoGeneratedAt()}`);
  lines.push("");
  lines.push("RESEARCH QUERY");
  lines.push(`"${q}"`);
  lines.push("");
  lines.push(`RUN CERTAINTY: ${input.consensusScore}/100 (${input.confidenceLabel} confidence)`);
  lines.push(`EVIDENCE QUALITY: ${input.evidenceQuality}`);
  lines.push("");
  lines.push("SUMMARY");
  // m-4: the record says how many slots were dispatched, not that each answered (a slot may have failed or been retried).
  lines.push(`${n} panel slot${n === 1 ? " was" : "s were"} dispatched for this question. Positions below are stated from the recorded panel rows; value comparisons are computed, not model positions.`);
  lines.push("");

  if (findings.length) {
    lines.push("KEY FINDINGS");
    findings.forEach((f) => lines.push(`- ${f}`));
    lines.push("");
  }
  for (const g of agreeGroups) {
    lines.push(g.heading.toUpperCase());
    g.items.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }
  if (unresolved.length) {
    lines.push("UNRESOLVED CLAIMS AND VALUE DIFFERENCES");
    unresolved.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }
  const assess = (typeof input.confidenceAssessment === "string" ? input.confidenceAssessment : "").trim();
  if (assess) {
    lines.push("CERTAINTY AND LIMITS");
    lines.push(assess);
    lines.push("");
  }

  lines.push("PANEL SLOTS (AS RECORDED)");
  lines.push(formatModelsConsultedGrid(slots));
  lines.push("");

  lines.push("METHODOLOGY");
  lines.push(
    `This question was dispatched to ${n} panel slot${n === 1 ? "" : "s"} via ConvergePanel. Each slot's recorded position on a claim is shown as recorded; comparisons of stated values are computed. The run certainty is computed from the scored rows and does not by itself establish factual accuracy.`
  );
  lines.push("");
  lines.push("DISCLAIMER");
  lines.push(
    "This is an AI-assisted research synthesis, not professional advice. Results should inform human judgment and further investigation, not replace professional counsel. AI models have known limitations including training data cutoffs, potential biases, and the possibility of confident but incorrect outputs."
  );
  lines.push("");
  lines.push(`Report ID: ${input.verificationId || "—"}`);
  lines.push("Source: convergepanel.com");

  return lines.join("\n").trimEnd() + "\n";
}

export function generateVerificationMemo(input: MemoInput): string {
  if (input.type === "claim") return generateClaimMemo(input);
  if (input.type === "video") return generateVideoMemo(input);
  if (isMarkedAdaptiveResearchMemo(input)) return generateMarkedAdaptiveResearchMemo(input);
  return generateResearchMemo(input);
}
