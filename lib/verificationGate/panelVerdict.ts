/**
 * Panel Verdict Builder
 *
 * Assembles a compact, shareable summary from existing synthesis
 * and Verification Gate data. Picks the highest-signal items.
 */

import { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";
import { VerificationGateResult } from "@/lib/verificationGate/verificationGate";
import { classifyGrounding, GroundingResult } from "./sourceGrounding";
import { independentVoiceCount, type ExecutingIdentityRow } from "@/lib/panel/executingVoiceLabel";
import { rowsRecordExecutionIdentity, type ClientSynthesisRow } from "@/lib/panel/independentVoices";
import { classifyDisagreementAgainstRows, rowsCollapsed } from "@/lib/panel/storedDisagreementIndependence";

/**
 * Heading of the verdict's top item when fewer than two independent executing models responded: one model's finding is
 * not a consensus (two slots answered by the same substitute model are one model).
 */
export const PANEL_VERDICT_SINGLE_MODEL_HEADING = "Top finding (one independent model; not a consensus)";

/** Share / memo line in place of a consensus score when fewer than two independent executing models responded. */
export const NO_CONSENSUS_SCORE_SHARE_LINE =
  "No consensus score: fewer than two independent models responded (slots answered by the same substitute model count as one).";

/**
 * Share-post closing line in place of a multi-model tagline ("The disagreements tell you more…", "Five give you the shape
 * of the problem.", "…highlights consensus, disagreements…") when fewer than two independent models responded.
 */
export const SINGLE_MODEL_SHARE_TAGLINE =
  "Only one independent model responded, so this is one model's answer, not a cross-model comparison.";

/** Verdict card text in place of "No major disagreements detected." when fewer than two independent models responded. */
export const NO_CROSS_MODEL_COMPARISON_TEXT = "No cross-model comparison: fewer than two independent models responded.";

/**
 * The disagreements that are REAL cross-model disagreements: with fewer than two independent executing models in the run
 * (`crossModel === false`) there are none. Otherwise each item is judged by the SAME rule the governance queue applies
 * to the stored record (`classifyDisagreementAgainstRows`, lib/panel/storedDisagreementIndependence.ts): an item whose
 * positions come from two or more slots that collapse to fewer than two independent executing models (e.g. ChatGPT and
 * Claude both answered by DeepSeek) is one model's positions, and an item naming fewer than two slots (or none) in a run
 * where some slots collapsed cannot be attributed to independent models — neither is kept. In a run whose usable slots
 * are all independent models every item is kept, as before. Without rows nothing is inferred (only the raw-key rule);
 * rows that do not record execution identity (`rowsRecordExecutionIdentity`) prove no item cross-model (none kept).
 * Order preserved; never mutates its input.
 */
export function crossModelDisagreements<T extends { positionsByModel?: Record<string, string> | null }>(
  items: readonly T[] | null | undefined,
  rows: readonly ExecutingIdentityRow[] | null | undefined,
  crossModel: boolean
): T[] {
  if (!crossModel || !items) return [];
  if (!rows) {
    return items.filter((d) => {
      const slots = Array.from(new Set(Object.keys(d?.positionsByModel ?? {}).map((k) => k.trim()).filter((k) => k.length > 0)));
      return slots.length < 2 || independentVoiceCount(slots, rows) >= 2;
    });
  }
  // Rows that do not record which model executed (the gate's `executionProvenanceUnverified`): no item can be shown to
  // be between independent models — the queue's "independence_unverified" for a run without persisted identity.
  if (!rowsRecordExecutionIdentity(rows)) return [];
  const ctx = liveRunContext(rows);
  return items.filter((d) => classifyDisagreementAgainstRows(d, ctx) === "cross_model");
}

/** The live run's rows as a ≥ 2-independent-model context (callers pass it only when `crossModel` is true). */
function liveRunContext(rows: readonly ExecutingIdentityRow[]) {
  const clientRows = rows.filter((r) => r && typeof r.modelId === "string") as unknown as ClientSynthesisRow[];
  return { independence: "independent" as const, rows: clientRows, collapsed: rowsCollapsed(clientRows) };
}

/**
 * The disagreements whose model independence is UNKNOWN — classified "independence_unverified" by the same rule the
 * governance queue applies (`classifyDisagreementAgainstRows`): in a run with ≥ 2 independent executing models where
 * some slots collapsed onto one executing model, an item naming fewer than two attributable slots (or none). They are
 * neither a disagreement between models nor repeated output from one model, and the gate states them under their own
 * reason (`INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON`). Rows that do not record execution identity
 * (`rowsRecordExecutionIdentity`) make every item one of unknown independence. Empty when `crossModel` is false (every item is then one
 * model's — the run has fewer than two independent models) or without rows (nothing is inferred). Order preserved;
 * never mutates its input.
 */
export function independenceUnverifiedDisagreements<T extends { positionsByModel?: Record<string, string> | null }>(
  items: readonly T[] | null | undefined,
  rows: readonly ExecutingIdentityRow[] | null | undefined,
  crossModel: boolean
): T[] {
  if (!crossModel || !items || !rows) return [];
  if (!rowsRecordExecutionIdentity(rows)) return [...items];
  const ctx = liveRunContext(rows);
  return items.filter((d) => classifyDisagreementAgainstRows(d, ctx) === "independence_unverified");
}

export interface PanelVerdict {
  question: string;
  /**
   * At least two independent executing models responded, so the top item may be presented as a cross-model consensus
   * and its model counts as agreement / split. False → no consensus, no "agreed by" / "split" counts on any surface.
   * Absent (a verdict built elsewhere, e.g. a fixture) → treated as true, the behaviour before this field existed.
   */
  crossModel?: boolean;
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
  gate: VerificationGateResult,
  /**
   * The run's result rows, when the caller holds them. "Agreed by N models"
   * counts INDEPENDENT executing models (lib/panel/executingVoiceLabel.ts):
   * slots answered by one substitute model are one model. Without rows each
   * distinct slot counts once (nothing is inferred).
   */
  rows?: readonly ExecutingIdentityRow[] | null,
  /**
   * `crossModel`: whether the run has at least two independent executing models among its usable responses (the
   * caller's `independentSynthesisResponders` count). Omitted → true (callers without rows; nothing is inferred).
   */
  opts?: { crossModel?: boolean }
): PanelVerdict {
  const crossModel = opts?.crossModel !== false;
  const topFinding = report.keyFindings?.[0];
  const topConsensus = topFinding?.claim ?? report.executiveSummary?.slice(0, 200) ?? "No consensus identified.";
  const consensusModelCount = independentVoiceCount(topFinding?.modelsSupporting ?? [], rows);

  // Only real cross-model disagreements (crossModelDisagreements): never one model's positions presented as a split.
  const topDisagreementItem = crossModelDisagreements(report.disagreements, rows, crossModel)[0];
  const topDisagreement = topDisagreementItem?.topic ?? null;
  const disagreementDetail = topDisagreementItem?.whyTheyDiffer ?? null;
  // Independent executing models, like consensusModelCount: positions from two slots answered by one substitute
  // model are one model's position, not a two-model split.
  const disagreementModelCount = topDisagreementItem
    ? independentVoiceCount(Object.keys(topDisagreementItem.positionsByModel ?? {}), rows)
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
    crossModel,
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

/** "Consensus", or — with fewer than two independent executing models — a label that claims no consensus. */
function topItemPrefix(v: PanelVerdict): string {
  return v.crossModel === false ? "Finding (one independent model; not a consensus)" : "Consensus";
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
  parts.push(`${topItemPrefix(v)}: ${v.topConsensus}`);

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
  parts.push(`${topItemPrefix(v)}: ${firstSentence(v.topConsensus)}`);

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
  parts.push(`${topItemPrefix(v)}: ${v.topConsensus}`);

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
