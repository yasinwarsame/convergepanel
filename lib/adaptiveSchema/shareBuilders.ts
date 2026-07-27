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
import { getModelDisplayNameSafe } from "@/lib/panelModels";
import { MemoInput } from "@/lib/verification/generateMemo";
import { AdaptiveGateStatus, AdaptiveSynthesisReport } from "./types";

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

  if (report.whereModelsAgree.length > 0) {
    lines.push("## Where models agree");
    report.whereModelsAgree.forEach((a) => lines.push(`- ${a}`));
    lines.push("");
  }

  if (report.disagreements.length > 0) {
    lines.push("## Where models disagree");
    report.disagreements.forEach((d) => {
      lines.push(`- **${d.topic}** — ${d.whyTheyDiffer}`);
      d.positions.forEach((p) => lines.push(`  - ${getModelDisplayNameSafe(p.modelId)}: ${p.position}`));
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

export function buildAdaptiveMemoInput(
  question: string,
  report: AdaptiveSynthesisReport,
  modelsUsed: ModelId[],
  verificationId: string
): MemoInput {
  return {
    type: "research",
    question,
    consensusScore: Math.round(report.runCertainty * 100),
    confidenceLabel: GATE_CONFIDENCE_LABEL[report.gate],
    evidenceQuality: "mixed",
    keyFindings: report.whereModelsAgree.slice(0, 8),
    synthesisAgreements: report.whereModelsAgree,
    synthesisDisagreements: report.disagreements.map((d) => `${d.topic}: ${d.whyTheyDiffer}`),
    confidenceAssessment: report.executiveSummary || report.certaintyAssessment,
    modelsUsed: modelsUsed.map((id) => getModelDisplayNameSafe(id)),
    verificationId,
  };
}

export function buildAdaptiveLinkedInPost(question: string, report: AdaptiveSynthesisReport): string {
  const lines: string[] = [];
  lines.push(`I researched "${truncate(question, 120)}" across a multi-model AI panel using ConvergePanel.`);
  lines.push("");
  lines.push(`Certainty: ${Math.round(report.runCertainty * 100)}% (gate: ${report.gate})`);
  lines.push("");

  if (report.whereModelsAgree.length > 0) {
    lines.push("Where models agree:");
    report.whereModelsAgree.slice(0, 2).forEach((a) => lines.push(`→ ${truncate(a, 140)}`));
    lines.push("");
  }

  if (report.disagreements.length > 0) {
    lines.push("Where models disagree:");
    report.disagreements.slice(0, 2).forEach((d) => lines.push(`→ ${truncate(d.topic, 140)}`));
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
  if (report.disagreements.length > 0) {
    parts.push(`Models split on: ${truncate(report.disagreements[0].topic, 80)}`);
  }
  parts.push("via ConvergePanel");
  return truncate(parts.join("\n\n"), 280);
}
