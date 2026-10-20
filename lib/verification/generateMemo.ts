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
   * Order 5 (Contract P): set ONLY by shareBuilders.buildAdaptiveMemoInput for an adaptive research report marked
   * presentation.disagreementPositionVersion === 1. Its findings, agreements and disagreements are then already stated
   * from the report's rows; the memo takes the adaptive-only path (isMarkedAdaptiveResearchMemo). Claim, video and
   * every other research memo never set it and are generated exactly as before.
   */
  adaptivePositionPresentation?: { reportKind: typeof ADAPTIVE_RESEARCH_REPORT_KIND; disagreementPositionVersion: 1 };
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

function generateClaimMemo(input: MemoInput): string {
  const lines: string[] = [];
  const claim = (input.claim ?? "").trim() || "—";
  const verdictHuman = formatVerdictLabel(input.verdict ?? "");
  const rows = input.modelEvidence ?? [];
  const n = rows.length > 0 ? rows.length : 0;
  const modelNamesList = rows
    .map((m) => modelDisplayName(m.modelId, m.modelName))
    .filter((x, i, a) => a.indexOf(x) === i);

  lines.push("VERIFICATION MEMO");
  lines.push("ConvergePanel Multi-Model Claim Verification");
  lines.push(`Generated: ${formatMemoGeneratedAt()}`);
  lines.push("");
  lines.push("CLAIM VERIFIED");
  lines.push(`"${claim}"`);
  lines.push("");
  lines.push(`VERDICT: ${verdictHuman}`);
  lines.push(`CONSENSUS SCORE: ${input.consensusScore}/100 (${input.confidenceLabel} confidence)`);
  lines.push(`EVIDENCE QUALITY: ${input.evidenceQuality}`);
  lines.push("");
  lines.push("SUMMARY");
  lines.push(
    `${Math.max(1, n)} AI models evaluated this claim independently. ${claimSummarySentence(input.verdict)}`
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

  const agree = dedupeCap(input.agreementPoints ?? []);
  if (agree.length) {
    lines.push("WHERE MODELS AGREE");
    agree.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const disagree = dedupeCap(input.disagreementPoints ?? []);
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
    `This claim was independently evaluated by ${nn} large language model${nn === 1 ? "" : "s"}${namesPhrase} via ConvergePanel. Each model received the claim with identical instructions to evaluate accuracy, identify correct and incorrect parts, and provide evidence. Models were not shown each other's responses. The consensus score reflects the degree of agreement across models weighted by evidence quality.`
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
  lines.push(`VERDICT: ${verdictHuman}`);
  const ct = (input.contentType ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (ct && ct !== "unknown") {
    lines.push(`CONTENT TYPE: ${videoContentTypeMemoLabels[ct] ?? input.contentType}`);
  }
  lines.push(`CONSENSUS SCORE: ${input.consensusScore}/100 (${input.confidenceLabel} confidence)`);
  lines.push(`EVIDENCE QUALITY: ${input.evidenceQuality}`);
  lines.push("");
  lines.push("SUMMARY");
  lines.push(
    `${n} vision-capable AI models independently analyzed ${frames || "multiple"} frames extracted at regular intervals. ${videoSummarySentence(input.verdict)}`
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
    lines.push("WHERE MODELS AGREE");
    agree.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const disagree = dedupeCap(input.disagreementPoints ?? []);
  if (disagree.length) {
    lines.push("WHERE MODELS DISAGREE");
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
    `${frames || "Multiple"} frames were extracted at regular intervals from the uploaded video and sent to ${n} vision-capable AI model${n === 1 ? "" : "s"}${namesPhrase} via ConvergePanel. Each model independently analyzed frames for signs of AI generation, deepfake artifacts, and manipulation indicators. Models were not shown each other's responses. Video metadata was extracted from the file container and included in the analysis.`
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

function generateResearchMemo(input: MemoInput): string {
  const lines: string[] = [];
  const q = (input.question ?? "").trim() || "—";
  const findings = dedupeCap(input.keyFindings ?? []);
  const agree = dedupeCap(input.synthesisAgreements ?? []);
  const disagree = dedupeCap(input.synthesisDisagreements ?? []);
  const n = Math.max(1, input.modelsUsed?.length ?? 0);

  lines.push("VERIFICATION MEMO");
  lines.push("ConvergePanel Multi-Model Research Report");
  lines.push(`Generated: ${formatMemoGeneratedAt()}`);
  lines.push("");
  lines.push("RESEARCH QUERY");
  lines.push(`"${q}"`);
  lines.push("");
  lines.push(`CONSENSUS SCORE: ${input.consensusScore}/100 (${input.confidenceLabel} confidence)`);
  lines.push(`EVIDENCE QUALITY: ${input.evidenceQuality}`);
  lines.push("");
  lines.push("SUMMARY");
  lines.push(
    `${n} AI models researched this question independently. ${researchSummarySentence(input.consensusScore, input.evidenceQuality)}`
  );
  lines.push("");

  if (findings.length) {
    lines.push("KEY FINDINGS");
    findings.forEach((f) => lines.push(`- ${f}`));
    lines.push("");
  }

  if (agree.length) {
    lines.push("WHERE MODELS AGREE");
    agree.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  if (disagree.length) {
    lines.push("WHERE MODELS DISAGREE");
    disagree.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  const assess = (input.confidenceAssessment ?? "").trim();
  if (assess) {
    lines.push("CONFIDENCE ASSESSMENT");
    lines.push(assess);
    lines.push("");
  }

  lines.push("MODELS CONSULTED");
  lines.push(formatModelsConsultedGrid(input.modelsUsed ?? []));
  lines.push("");

  lines.push("METHODOLOGY");
  lines.push(
    `This question was independently researched by ${n} large language model${n === 1 ? "" : "s"} via ConvergePanel. Each model received identical instructions. Models were not shown each other's responses. Results were synthesized to identify areas of agreement and disagreement. The consensus score reflects the degree of convergence across models weighted by evidence quality and source backing.`
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
  const q = (input.question ?? "").trim() || "—";
  const findings = dedupeCap(input.keyFindings ?? []);
  const agree = dedupeCap(input.synthesisAgreements ?? []);
  const unresolved = dedupeCap(input.synthesisDisagreements ?? []);
  const slots = input.modelsUsed ?? [];
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
  lines.push(`${n} panel slot${n === 1 ? "" : "s"} answered this question independently. Positions below are stated from the recorded panel rows; value comparisons are computed, not model positions.`);
  lines.push("");

  if (findings.length) {
    lines.push("KEY FINDINGS");
    findings.forEach((f) => lines.push(`- ${f}`));
    lines.push("");
  }
  if (agree.length) {
    lines.push("CONSENSUS AND MAJORITY ROWS");
    agree.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }
  if (unresolved.length) {
    lines.push("UNRESOLVED CLAIMS AND VALUE DIFFERENCES");
    unresolved.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }
  const assess = (input.confidenceAssessment ?? "").trim();
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
    `This question was researched by ${n} panel slot${n === 1 ? "" : "s"} via ConvergePanel. Each slot received identical instructions and was not shown the others' responses. Each slot's recorded position on a claim is shown as recorded; comparisons of stated values are computed. The run certainty is computed from the scored rows and does not by itself establish factual accuracy.`
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
