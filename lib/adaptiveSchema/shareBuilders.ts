/**
 * Export/Share Text Builders for the Adaptive Synthesis Report (Part A4/A5)
 *
 * Client-safe (no "server-only" import) — these are pure string builders
 * called directly from AdaptiveSynthesisReportView.tsx's export action row,
 * mirroring the legacy PanelSynthesisView.tsx's inline
 * handleGenerateLinkedIn/handleGenerateX/copyStructuredSynthesisMarkdown
 * pattern, adapted to the adaptive report's field names.
 */

import { ModelId } from "@/lib/types";
import { RunModelProvenanceFacts, runModelFamilyName, runModelLabels } from "@/lib/panel/runModelIdentity";
import { MemoInput } from "@/lib/verification/generateMemo";
import { AdaptiveGateStatus, AdaptiveSynthesisReport } from "./types";
import { dedupeTextList } from "./textSimilarity";
import { TEXT_DEDUP_THRESHOLDS, WHERE_MODELS_AGREE_MAX_ITEMS } from "./config";
import { CLAIM_LABEL, MODEL_CAVEAT_LABEL, PANEL_RESULT_LABEL, quoteClaim } from "./agreementNarrative";
import {
  AnswerClaimBlock,
  ClaimBlock,
  TextBlock,
  blockText,
  claimLine,
  presentAgreeItems,
  presentCertainty,
  presentDisagreements,
  presentExecutiveSummary,
  presentUnifiedAnswer,
  shortClaimWithResult,
} from "./reportPresentation";
import { escapeMarkdownInline, markdownQuote, plainTextQuote } from "./textSerialization";

// R5 presentation contract: a report that carries `presentation` is rendered through reportPresentation.ts, so
// every block keeps its source label (Panel result / Claim / Model-written explanation). A report persisted
// before it existed takes the original code path below, unchanged.
//
// R6-2 / R6-3: in Markdown, every model-written string is serialized through textSerialization.ts — claims and
// short model text escaped inline, model prose as an escaped blockquote under its label — so model text cannot
// become a report heading, list, link or HTML. Headings and computed lines are written here.

const isModelText = (b: TextBlock) => b.source === "model_claim" || b.source === "model_explanation" || b.source === "model_bias";

/** One attributed block as Markdown: "**Label:**" on its own line, then the text — model prose as an escaped blockquote. */
function markdownBlock(block: TextBlock, indent = ""): string[] {
  const body = isModelText(block) ? markdownQuote(block.text, indent) : [`${indent}${block.text}`];
  return block.label ? [`${indent}**${block.label}:**`, ...body] : body;
}

/** A claim block as one Markdown line: the claim's text is model-written, so it is escaped. */
function markdownClaim(item: ClaimBlock | AnswerClaimBlock): string {
  const parts = [item.claim, item.result, item.contested, "supporters" in item ? item.supporters : null];
  return parts
    .filter((b): b is TextBlock => !!b)
    .map((b) => `**${b.label}:** ${b.source === "model_claim" ? escapeMarkdownInline(b.text) : b.text}`)
    .join(" — ");
}

/** A model-written block for plain text (memo): "Label:" on its own line, then every line quoted. */
function plainTextBlock(block: TextBlock, indent = ""): string {
  if (!isModelText(block) || block.source === "model_claim") return `${indent}${blockText(block)}`;
  return [`${indent}${block.label}:`, ...plainTextQuote(block.text, indent)].join("\n");
}

/** The panel verdict for Markdown: the computed figures, and the top claim with its own result (R6-1, R6-3). */
function markdownPanelVerdict(report: AdaptiveSynthesisReport): string[] {
  const card = report.verdictCard;
  if (!card.topConsensusAgreement) return [`**Panel verdict:** ${escapeMarkdownInline(report.panelVerdict)}`];
  const parts = [
    `**${CLAIM_LABEL}:** ${escapeMarkdownInline(quoteClaim(card.topConsensus))}`,
    `**${PANEL_RESULT_LABEL}:** ${card.topConsensusAgreement}`,
    ...(card.topConsensusContested ? [`**Contested:** ${card.topConsensusContested}`] : []),
  ];
  return [`**Panel verdict:** certainty ${Math.round(report.runCertainty * 100)}%; gate: ${report.gate}. Top claim:`, parts.join(" — ")];
}

/** The Unified Answer for Markdown: its computed note, then each claim with its own result. */
function markdownUnifiedAnswer(report: AdaptiveSynthesisReport): string[] {
  const answer = presentUnifiedAnswer(report);
  const out: string[] = [];
  if (answer.note) out.push(answer.note.text);
  if (answer.claimsHeading) out.push(`${answer.claimsHeading}:`);
  answer.claims.forEach((c) => out.push(`- ${markdownClaim(c)}`));
  return out;
}

/** Same merge pass the Synthesis Report view applies to "Where models agree" (Bias & Blind Spots Tiers fix, Part 4) — keeps exported markdown/memo/social copy free of the same near-duplicate paraphrases. */
function dedupedAgreementItems(report: AdaptiveSynthesisReport): string[] {
  return dedupeTextList(report.whereModelsAgree, { ...TEXT_DEDUP_THRESHOLDS, cap: WHERE_MODELS_AGREE_MAX_ITEMS });
}

const GATE_CONFIDENCE_LABEL: Record<AdaptiveGateStatus, string> = {
  pass: "High",
  caution: "Medium",
  fail: "Low",
};

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function buildAdaptiveSynthesisMarkdown(question: string, report: AdaptiveSynthesisReport): string {
  if (report.presentation) return buildPresentedMarkdown(question, report);
  const lines: string[] = [];
  lines.push("# Synthesis Report");
  lines.push("");
  lines.push(`**Question:** ${question}`);
  lines.push("");
  lines.push(`**Panel verdict:** ${report.panelVerdict}`);
  lines.push("");
  lines.push("## Unified Answer");
  lines.push(report.unifiedAnswer);
  lines.push("");
  lines.push("## Executive Summary");
  lines.push(report.executiveSummary);
  lines.push("");

  const agreementItems = dedupedAgreementItems(report);
  if (agreementItems.length > 0) {
    lines.push("## Where models agree");
    agreementItems.forEach((a) => lines.push(`- ${a}`));
    lines.push("");
  }

  if (report.disagreements.length > 0) {
    lines.push("## Where models disagree");
    report.disagreements.forEach((d) => {
      lines.push(`- **${d.topic}** — ${d.whyTheyDiffer}`);
      d.positions.forEach((p) => lines.push(`  - ${runModelFamilyName(p.modelId)}: ${p.position}`));
    });
    lines.push("");
  }

  if (report.biasAndBlindSpots.length > 0) {
    lines.push("## Bias & blind spots");
    report.biasAndBlindSpots.forEach((b) => {
      lines.push(`- **${b.biasType}** — ${b.description}`);
    });
    lines.push("");
  }

  lines.push("## Certainty");
  lines.push(`${Math.round(report.runCertainty * 100)}% (gate: ${report.gate}) — ${report.certaintyAssessment}`);
  lines.push("");
  lines.push("Source: convergepanel.com");

  return lines.join("\n");
}

function buildPresentedMarkdown(question: string, report: AdaptiveSynthesisReport): string {
  const lines: string[] = [];
  lines.push("# Synthesis Report");
  lines.push("");
  lines.push(`**Question:** ${question}`);
  lines.push("");
  lines.push(...markdownPanelVerdict(report));
  lines.push("");
  lines.push("## Unified Answer");
  lines.push(...markdownUnifiedAnswer(report));
  lines.push("");
  lines.push("## Executive Summary");
  for (const block of presentExecutiveSummary(report)) {
    lines.push(...markdownBlock(block));
    lines.push("");
  }

  const agreeItems = presentAgreeItems(report);
  if (agreeItems.length > 0) {
    lines.push("## Where models agree");
    agreeItems.forEach((a) => lines.push(`- ${markdownClaim(a)}`));
    lines.push("");
  }

  const disagreements = presentDisagreements(report);
  if (disagreements.length > 0) {
    lines.push("## Where models disagree");
    disagreements.forEach((d, i) => {
      lines.push(`- ${markdownClaim(d)}`);
      if (isModelText(d.why)) {
        lines.push(`  - **${d.why.label}:**`);
        lines.push("");
        lines.push(...markdownQuote(d.why.text, "    "));
        lines.push("");
      } else {
        lines.push(`  - ${d.why.text}`);
      }
      report.disagreements[i].positions.forEach((p) => lines.push(`  - ${runModelFamilyName(p.modelId)}: ${escapeMarkdownInline(p.position)}`));
    });
    lines.push("");
  }

  if (report.biasAndBlindSpots.length > 0) {
    lines.push("## Bias & blind spots");
    lines.push(`**${MODEL_CAVEAT_LABEL}:**`);
    report.biasAndBlindSpots.forEach((b) => {
      lines.push(`- ${escapeMarkdownInline(b.biasType)} — ${escapeMarkdownInline(b.description)}`);
    });
    lines.push("");
  }

  lines.push("## Certainty");
  const [certaintyLine, ...certaintyRest] = presentCertainty(report);
  lines.push(`${Math.round(report.runCertainty * 100)}% (gate: ${report.gate}) — ${certaintyLine.text}`);
  for (const block of certaintyRest) {
    lines.push("");
    lines.push(...markdownBlock(block));
  }
  lines.push("");
  lines.push("Source: convergepanel.com");

  return lines.join("\n");
}

export function buildAdaptiveMemoInput(
  question: string,
  report: AdaptiveSynthesisReport,
  modelsUsed: ModelId[],
  verificationId: string,
  /**
   * The run's per-slot provenance (live or saved result rows), when the caller
   * holds it: each model is then named with its recorded requested model.
   * Without it, models are named by family only — never by a product label.
   */
  modelProvenance?: readonly RunModelProvenanceFacts[] | null
): MemoInput {
  if (report.presentation) {
    const agree = presentAgreeItems(report).map(claimLine);
    const summary = presentExecutiveSummary(report).map((b) => plainTextBlock(b)).join("\n\n");
    return {
      type: "research",
      question,
      consensusScore: Math.round(report.runCertainty * 100),
      confidenceLabel: GATE_CONFIDENCE_LABEL[report.gate],
      evidenceQuality: "mixed",
      keyFindings: agree.slice(0, 8),
      synthesisAgreements: agree,
      synthesisDisagreements: presentDisagreements(report).map((d) =>
        isModelText(d.why) ? `${claimLine(d)}\n${plainTextBlock(d.why, "  ")}` : `${claimLine(d)} — ${blockText(d.why)}`
      ),
      confidenceAssessment: summary || presentCertainty(report).map((b) => plainTextBlock(b)).join("\n\n"),
      modelsUsed: runModelLabels(modelsUsed, modelProvenance),
      verificationId,
    };
  }
  return {
    type: "research",
    question,
    consensusScore: Math.round(report.runCertainty * 100),
    confidenceLabel: GATE_CONFIDENCE_LABEL[report.gate],
    evidenceQuality: "mixed",
    keyFindings: dedupedAgreementItems(report).slice(0, 8),
    synthesisAgreements: dedupedAgreementItems(report),
    synthesisDisagreements: report.disagreements.map((d) => `${d.topic}: ${d.whyTheyDiffer}`),
    confidenceAssessment: report.executiveSummary || report.certaintyAssessment,
    modelsUsed: runModelLabels(modelsUsed, modelProvenance),
    verificationId,
  };
}

export function buildAdaptiveLinkedInPost(question: string, report: AdaptiveSynthesisReport): string {
  const lines: string[] = [];
  lines.push(`I researched "${truncate(question, 120)}" across a multi-model AI panel using ConvergePanel.`);
  lines.push("");
  lines.push(`Certainty: ${Math.round(report.runCertainty * 100)}% (gate: ${report.gate})`);
  lines.push("");

  const presented = report.presentation;
  const agreementItems = presented ? [] : dedupedAgreementItems(report);
  if (presented ? presented.agree.length > 0 : agreementItems.length > 0) {
    lines.push("Where models agree:");
    if (presented) presented.agree.slice(0, 2).forEach((a) => lines.push(`→ ${shortClaimWithResult(a, 100)}`));
    else agreementItems.slice(0, 2).forEach((a) => lines.push(`→ ${truncate(a, 140)}`));
    lines.push("");
  }

  if (report.disagreements.length > 0) {
    lines.push("Where models disagree:");
    if (presented) presented.disagree.slice(0, 2).forEach((d) => lines.push(`→ ${shortClaimWithResult(d, 100)}`));
    else report.disagreements.slice(0, 2).forEach((d) => lines.push(`→ ${truncate(d.topic, 140)}`));
    lines.push("");
  }

  lines.push("The disagreements tell you more than any single answer.");
  lines.push("");
  lines.push("→ convergepanel.com");

  return lines.join("\n");
}

export function buildAdaptiveXPost(question: string, report: AdaptiveSynthesisReport): string {
  const parts: string[] = [];
  parts.push(`Asked a multi-model AI panel: "${truncate(question, 80)}"`);
  parts.push(`Certainty: ${Math.round(report.runCertainty * 100)}% (${report.gate})`);
  const split = report.presentation?.disagree[0];
  if (split) {
    // The post is capped at 280 characters: the claim gives way, the computed result never does.
    const fixed = [...parts, "via ConvergePanel"].join("\n\n").length + 2;
    const room = 280 - fixed - `Models split on: `.length - shortClaimWithResult({ ...split, claim: "" }, 0).length;
    parts.push(`Models split on: ${shortClaimWithResult(split, Math.max(12, Math.min(60, room)))}`);
  } else if (report.disagreements.length > 0) {
    parts.push(`Models split on: ${truncate(report.disagreements[0].topic, 80)}`);
  }
  parts.push("via ConvergePanel");
  return truncate(parts.join("\n\n"), 280);
}
