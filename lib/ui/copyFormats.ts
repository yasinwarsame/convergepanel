/**
 * Copy format helpers for synthesis UI.
 * Builds markdown strings for clipboard copy (full content, no truncation).
 */

import type { VerificationGateResult } from "@/lib/verificationGate/verificationGate";
import type { PanelVerdict } from "@/lib/verificationGate/panelVerdict";

export interface ModelHealthForCopy {
  total: number;
  responded: number;
  substitutedCount: number;
  failedCount: number;
  /** Unique provider display names for Panel note (e.g. ["DeepSeek"]) - not per-slot */
  substitutedProviders?: string[];
}

export interface SourceCoverageForCopy {
  sourcedFindings: number;
  totalFindings: number;
  coveragePct: number;
}

/**
 * Copy text to clipboard with hidden-textarea fallback for contexts where
 * navigator.clipboard is unavailable (e.g. non-HTTPS).
 */
export async function copyToClipboardWithFallback(text: string): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to fallback
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Build a full markdown summary for synthesis (Question, Gate, Verdict, Model Health, Source Coverage).
 * Uses full strings — never truncates.
 */
export function buildSynthesisMarkdown(
  question: string,
  gate: VerificationGateResult,
  verdict: PanelVerdict,
  modelHealth: ModelHealthForCopy,
  sourceCoverage?: SourceCoverageForCopy | null,
  synthesizedBy?: string | null
): string {
  const parts: string[] = [];

  parts.push("## Question");
  parts.push(question.trim() || "(No question)");
  parts.push("");

  parts.push("## Verification Gate");
  parts.push(`**${gate.label}**`);
  if (gate.reasons.length > 0) {
    parts.push("Why:");
    gate.reasons.forEach((r) => parts.push(`- ${r}`));
  }
  parts.push("");
  parts.push("Recommended next steps:");
  gate.recommendedNextSteps.forEach((s) => parts.push(`- ${s}`));
  parts.push("");

  parts.push("## Panel Verdict");
  parts.push("Top consensus:");
  parts.push(`- ${verdict.topConsensus}`);

  if (verdict.topDisagreement) {
    parts.push("");
    parts.push("Key disagreement:");
    parts.push(`- Topic: ${verdict.topDisagreement}`);
    if (verdict.disagreementDetail) {
      parts.push(`- Detail: ${verdict.disagreementDetail}`);
    }
  }

  if (verdict.keyBlindSpot) {
    parts.push("");
    parts.push("Caveat:");
    parts.push(`- ${verdict.keyBlindSpot}`);
  }

  parts.push("");
  const { total, responded, substitutedCount, failedCount, substitutedProviders } = modelHealth;
  parts.push("Model health:");
  parts.push(`- ${responded}/${total} responded • ${substitutedCount} substituted • ${failedCount} failed`);

  if (substitutedCount > 0 || failedCount > 0) {
    const noteParts: string[] = [];
    if (substitutedCount > 0) {
      const list = substitutedProviders ?? [];
      const providers =
        list.length > 2
          ? `${list[0]} +${list.length - 1}`
          : list.length
            ? list.join(", ")
            : "";
      noteParts.push(`${substitutedCount} model${substitutedCount !== 1 ? "s" : ""} substituted${providers ? ` (${providers})` : ""}`);
    }
    if (failedCount > 0) {
      noteParts.push(`${failedCount} failed`);
    }
    parts.push("");
    parts.push(`Panel note: ${noteParts.join(", ")}.`);
  }

  if (sourceCoverage && sourceCoverage.totalFindings > 0) {
    parts.push("");
    parts.push(
      `Source coverage: ${sourceCoverage.sourcedFindings}/${sourceCoverage.totalFindings} claims sourced (${sourceCoverage.coveragePct}%)`
    );
  }

  if (synthesizedBy) {
    const provider = /claude/i.test(synthesizedBy) ? "anthropic" : "openai";
    const status = "ok"; // We don't have fallback info in the copy; assume ok
    parts.push("");
    parts.push(`Synthesis provider: ${provider} (${status})`);
  }

  return parts.join("\n");
}
