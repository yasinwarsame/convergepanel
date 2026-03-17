/**
 * Social copy builders for LinkedIn, X, etc.
 * Professional, postable formats using full strings (no DOM/truncation issues).
 */

import type { VerificationGateResult } from "@/lib/verificationGate/verificationGate";
import type { PanelVerdict } from "@/lib/verificationGate/panelVerdict";

export interface LinkedInModelHealth {
  total: number;
  responded: number;
  substituted: number;
  failed: number;
  substitutedProviders?: string[];
}

export interface LinkedInParams {
  question: string;
  gate: VerificationGateResult;
  verdict: PanelVerdict;
  modelHealth: LinkedInModelHealth;
  sourceBacked?: boolean;
  synthesisMeta?: { provider?: string; status?: string };
}

function singleLine(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clamp(text: string, maxChars: number): string {
  const s = singleLine(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1).trimEnd() + "…";
}

function bullets(list: string[], max: number, maxPerBullet = 140): string[] {
  return list.slice(0, max).map((b) => clamp(b, maxPerBullet));
}

/**
 * Build a single-sentence intro line for LinkedIn post. Topic-aware, one line.
 * Deterministic; resilient to empty question or missing gate.
 */
export function buildIntroLine(params: {
  question: string;
  gate: VerificationGateResult | null | undefined;
  verdict: PanelVerdict;
}): string {
  const { question, gate } = params;

  const raw = singleLine(question || "").replace(/[.!?]+$/, "").trim();
  const topicLabel =
    raw.length <= 12 ? "" : raw.length > 90 ? raw.slice(0, 87).trimEnd() + "…" : raw;

  const gateLabel = gate?.label ?? "quick reliability pass";

  if (!topicLabel) {
    return `I ran a multi-model panel; verdict: ${gateLabel}.`;
  }
  return `Quick panel check on: ${topicLabel} — verdict: ${gateLabel}.`;
}

/**
 * Build a LinkedIn-ready post (8–14 lines, professional, immediately postable).
 * Deterministic; uses full underlying strings.
 */
export function buildLinkedInPost(params: LinkedInParams): string {
  const { question, gate, verdict, modelHealth } = params;
  const lines: string[] = [];

  // A) Intro line (one sentence, topic-aware)
  lines.push(buildIntroLine({ question, gate, verdict }));
  lines.push("");

  // B) Panel Verdict
  lines.push(`Panel Verdict: ${gate.label}`);
  lines.push("");

  // C) Why bullets (max 3)
  if (gate.reasons.length > 0) {
    lines.push("Why:");
    bullets(gate.reasons, 3).forEach((r) => lines.push(`• ${r}`));
    lines.push("");
  }

  // D) Next steps (max 3)
  if (gate.recommendedNextSteps.length > 0) {
    lines.push("Next steps:");
    bullets(gate.recommendedNextSteps, 3).forEach((s) => lines.push(`• ${s}`));
    lines.push("");
  }

  // E) Consensus + agreed count
  const consensus = clamp(verdict.topConsensus, 200);
  const agreedBy =
    verdict.consensusModelCount > 0
      ? ` Agreed by ${verdict.consensusModelCount} model${verdict.consensusModelCount !== 1 ? "s" : ""}.`
      : "";
  lines.push(`Consensus: ${consensus}${agreedBy}`);
  lines.push("");

  // F) Disagreement (topic + short why, ~180 chars)
  if (verdict.topDisagreement) {
    const topic = clamp(verdict.topDisagreement, 80);
    const detail = verdict.disagreementDetail ? clamp(verdict.disagreementDetail, 180) : "";
    lines.push(`Disagreement: ${topic}`);
    if (detail) lines.push(detail);
    lines.push("");
  }

  // Caveat (full text, no truncation — singleLine normalizes whitespace)
  if (verdict.keyBlindSpot) {
    lines.push(`Caveat: ${singleLine(verdict.keyBlindSpot)}`);
    lines.push("");
  }

  // G) Model health (compact)
  const { total, responded, substituted, failed } = modelHealth;
  let healthLine = `Model health: ${responded}/${total} responded`;
  if (substituted > 0 || failed > 0) {
    const parts: string[] = [];
    if (substituted > 0) {
      const list = modelHealth.substitutedProviders ?? [];
      const prov =
        list.length > 2 ? `${list[0]} +${list.length - 1}` : list.length ? list.join(", ") : "";
      parts.push(`Substituted: ${substituted}${prov ? ` (${prov})` : ""}`);
    }
    if (failed > 0) parts.push(`Failed: ${failed}`);
    healthLine += " • " + parts.join(" • ");
  }
  lines.push(healthLine);
  lines.push("");

  // H) ConvergePanel mention
  lines.push(
    "Built with ConvergePanel — a multi-model panel that highlights consensus, disagreements, and blind spots."
  );

  // Optional hashtags (max 4)
  lines.push("");
  lines.push("#AI #Research #DecisionMaking");

  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}
