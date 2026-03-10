/**
 * Panel Verdict Builder
 *
 * Assembles a compact, shareable summary from existing synthesis
 * and Verification Gate data. Picks the highest-signal items.
 */

import { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";
import { VerificationGateResult } from "@/lib/verificationGate/verificationGate";
import { classifyGrounding, GroundingResult } from "./sourceGrounding";

export interface PanelVerdict {
  question: string;
  topConsensus: string;
  consensusModelCount: number;
  topDisagreement: string | null;
  disagreementDetail: string | null;
  disagreementModelCount: number;
  gateLabel: string;
  gateStatus: string;
  keyBlindSpot: string | null;
  grounding: GroundingResult;
  recommendedNextSteps: string[];
}

/**
 * Build a panel verdict from synthesis data.
 * Picks the most important single item from each category.
 */
export function buildPanelVerdict(
  question: string,
  report: StructuredSynthesis,
  gate: VerificationGateResult
): PanelVerdict {
  const topFinding = report.keyFindings?.[0];
  const topConsensus = topFinding?.claim ?? report.executiveSummary?.slice(0, 200) ?? "No consensus identified.";
  const consensusModelCount = topFinding?.modelsSupporting?.length ?? 0;

  const topDisagreementItem = report.disagreements?.[0];
  const topDisagreement = topDisagreementItem?.topic ?? null;
  const disagreementDetail = topDisagreementItem?.whyTheyDiffer ?? null;
  const disagreementModelCount = topDisagreementItem
    ? Object.keys(topDisagreementItem.positionsByModel ?? {}).length
    : 0;

  const biasItem = report.biasAndBlindSpots?.[0];
  const keyBlindSpot =
    typeof biasItem === "string"
      ? biasItem
      : biasItem?.description ?? null;

  const grounding = classifyGrounding(
    topConsensus,
    topFinding?.evidenceRefs,
    topDisagreement ?? undefined
  );

  return {
    question,
    topConsensus,
    consensusModelCount,
    topDisagreement,
    disagreementDetail,
    disagreementModelCount,
    gateLabel: gate.label,
    gateStatus: gate.status,
    keyBlindSpot,
    grounding,
    recommendedNextSteps: gate.recommendedNextSteps,
  };
}

/**
 * Format the verdict as a plain-text block suitable for
 * clipboard copy (LinkedIn, Slack, etc.).
 * Uses full raw strings — never truncates with "...".
 */
export function formatVerdictText(v: PanelVerdict, platform: "linkedin" | "x"): string {
  if (platform === "x") {
    return buildCopyForXShort(v);
  }

  const parts: string[] = [];
  parts.push(v.question);
  parts.push("");
  parts.push(`Consensus: ${v.topConsensus}`);

  if (v.topDisagreement) {
    parts.push(`Key disagreement: ${v.topDisagreement}`);
    if (v.disagreementDetail) {
      parts.push(v.disagreementDetail);
    }
  }

  parts.push(`Verification Gate: ${v.gateLabel}`);
  parts.push(`Grounding: ${v.grounding.label}`);

  if (v.keyBlindSpot) {
    parts.push(`Caveat: ${v.keyBlindSpot}`);
  }

  parts.push("");
  parts.push("Generated with ConvergePanel — multi-model AI synthesis");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// X (Twitter) copy helpers
// ---------------------------------------------------------------------------

/**
 * Trim text to the last full sentence that fits within maxLen.
 * Never produces trailing "...".
 */
function trimToSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const slice = text.slice(0, maxLen);
  const lastPeriod = slice.lastIndexOf(". ");
  if (lastPeriod > maxLen * 0.3) {
    return slice.slice(0, lastPeriod + 1);
  }
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.3) {
    return slice.slice(0, lastSpace);
  }
  return slice;
}

/**
 * Build a single-tweet copy using full raw strings.
 * Each field is kept to the first sentence to stay compact.
 * Critical: never uses slice+ellipsis truncation.
 */
export function buildCopyForXShort(v: PanelVerdict): string {
  const firstSentence = (s: string): string => {
    const m = s.match(/^[^.!?]*[.!?]/);
    return m ? m[0] : s;
  };

  const parts: string[] = [];
  parts.push(trimToSentence(v.question, 120));
  parts.push("");
  parts.push(`Consensus: ${firstSentence(v.topConsensus)}`);

  if (v.topDisagreement) {
    parts.push(`Disagreement: ${firstSentence(v.topDisagreement)}`);
  }

  parts.push(`Gate: ${v.gateLabel}`);

  if (v.keyBlindSpot) {
    parts.push(`Caveat: ${firstSentence(v.keyBlindSpot)}`);
  }

  parts.push("");
  parts.push("via ConvergePanel");

  let text = parts.join("\n");

  // If still over 280, drop optional sections one at a time
  if (text.length > 280 && v.keyBlindSpot) {
    const idx = parts.findIndex((p) => p.startsWith("Caveat:"));
    if (idx !== -1) { parts.splice(idx, 1); text = parts.join("\n"); }
  }
  if (text.length > 280 && v.topDisagreement) {
    const idx = parts.findIndex((p) => p.startsWith("Disagreement:"));
    if (idx !== -1) { parts.splice(idx, 1); text = parts.join("\n"); }
  }

  return text;
}

/**
 * Split long text into numbered tweet-sized chunks.
 * Splits at sentence boundaries; each chunk ≤ maxLen.
 */
export function splitIntoXThread(text: string, maxLen = 280): string[] {
  if (text.length <= maxLen) return [text];

  const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    const candidate = current ? `${current} ${trimmed}` : trimmed;

    if (candidate.length <= maxLen - 6) {
      current = candidate;
    } else {
      if (current) chunks.push(current);

      if (trimmed.length <= maxLen - 6) {
        current = trimmed;
      } else {
        // Sentence itself is too long — split at word boundaries
        const words = trimmed.split(/\s+/);
        current = "";
        for (const word of words) {
          const next = current ? `${current} ${word}` : word;
          if (next.length > maxLen - 6) {
            if (current) chunks.push(current);
            current = word;
          } else {
            current = next;
          }
        }
      }
    }
  }
  if (current) chunks.push(current);

  if (chunks.length <= 1) return chunks;

  return chunks.map((c, i) => `${i + 1}/${chunks.length} ${c}`);
}

/**
 * Build a full verdict for X as a numbered thread.
 * Returns an array of tweet strings; the caller joins with "\n\n".
 */
export function buildCopyForXThread(v: PanelVerdict): string[] {
  const parts: string[] = [];
  parts.push(v.question);
  parts.push("");
  parts.push(`Consensus: ${v.topConsensus}`);

  if (v.topDisagreement) {
    parts.push(`Key disagreement: ${v.topDisagreement}`);
    if (v.disagreementDetail) {
      parts.push(v.disagreementDetail);
    }
  }

  parts.push(`Verification Gate: ${v.gateLabel}`);

  if (v.keyBlindSpot) {
    parts.push(`Caveat: ${v.keyBlindSpot}`);
  }

  parts.push("");
  parts.push("via ConvergePanel — multi-model AI synthesis");

  const fullText = parts.join("\n");
  return splitIntoXThread(fullText);
}
