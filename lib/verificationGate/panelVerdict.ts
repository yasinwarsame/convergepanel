/**
 * Panel Verdict Builder
 *
 * Assembles a compact, shareable summary from existing synthesis
 * and Verification Gate data. Picks the highest-signal items.
 */

import { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";
import { VerificationGateResult } from "@/lib/verificationGate/verificationGate";
import { classifyGrounding, GroundingResult } from "./sourceGrounding";
import { executingVoiceName, independentVoiceCount, type ExecutingIdentityRow } from "@/lib/panel/executingVoiceLabel";
import { rowsRecordExecutionIdentity, type ClientSynthesisRow } from "@/lib/panel/independentVoices";
import {
  classifyDisagreementAgainstRows,
  QUALIFIED_DISAGREEMENT_TEXT,
  rowsCollapsed,
  type QualifiedDisagreementBasis,
} from "@/lib/panel/storedDisagreementIndependence";

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
 * Verdict heading of the top item when the run's rows do not record which models executed
 * (`rowsRecordExecutionIdentity` false) although two or more slots answered: the item may be one model's output repeated,
 * so it is never presented as a consensus.
 */
export const PANEL_VERDICT_INDEPENDENCE_UNVERIFIED_HEADING =
  "Top finding (model independence unverified; not confirmed as a consensus)";

/** Share / copy prefix of the top item under unknown model independence. */
export const INDEPENDENCE_UNVERIFIED_FINDING_PREFIX = "Finding (model independence unverified; not confirmed as a consensus)";

/** Verdict card text in place of "No major disagreements detected." under unknown model independence with no stored item. */
export const INDEPENDENCE_UNVERIFIED_NO_DISAGREEMENT_TEXT =
  "No disagreements recorded, but model independence is unverified: this is not evidence of agreement between models.";

/** Share / memo line in place of a consensus score under unknown model independence. */
export const INDEPENDENCE_UNVERIFIED_SCORE_SHARE_LINE =
  "Consensus score withheld: which models actually answered could not be established (model independence unverified).";

/** Share-post closing line in place of a multi-model tagline under unknown model independence. */
export const INDEPENDENCE_UNVERIFIED_SHARE_TAGLINE =
  "Model independence is unverified, so this is not presented as a cross-model comparison.";

/**
 * Heading of the separate evidence section that keeps every stored difference which is NOT a disagreement between
 * independent executing models (repeated output from one executing model, one independent model, or unknown model
 * independence) — the governance queue's wording (components/governance/GovernanceDashboard.tsx
 * QUALIFIED_DISAGREEMENTS_HEADING). Never shown under "Disagreements" / "Key disagreement".
 */
export const RECORDED_DIFFERENCES_HEADING = "Recorded differences not counted as model disagreements";

/** One line explaining the section, on the view and in long-form text. */
export const RECORDED_DIFFERENCES_NOTE =
  "The synthesis recorded these differing positions, but they are not counted as disagreements between independent models. Each position is named by the model that actually answered.";

/**
 * A stored disagreement item that is NOT a disagreement between independent executing models, kept as evidence: its
 * topic, why the positions differ, the reason it is not counted (`QUALIFIED_DISAGREEMENT_TEXT`, the queue's wording) and
 * every recorded position named by the EXECUTING model of its slot (`executingVoiceName`: "DeepSeek (substituting
 * ChatGPT)"). Stored text is never rewritten.
 */
export type RecordedDifference = {
  topic: string;
  whyTheyDiffer: string | null;
  basis: QualifiedDisagreementBasis;
  basisText: string;
  positions: { voice: string; position: string }[];
};

type DisagreementLike = { topic?: unknown; whyTheyDiffer?: unknown; positionsByModel?: Record<string, string> | null };

/**
 * Every stored item that `crossModelDisagreements` does NOT keep, with the reason (the complement, item for item, in
 * order): below two independent executing models every item is one model's ("single_independent_model"); rows that do
 * not record execution identity make every item "independence_unverified"; otherwise the queue's rule
 * (`classifyDisagreementAgainstRows`). Empty for a run whose items are all genuine — so unaffected runs carry nothing.
 */
export function recordedDifferences<T extends DisagreementLike>(
  items: readonly T[] | null | undefined,
  rows: readonly ExecutingIdentityRow[] | null | undefined,
  crossModel: boolean
): RecordedDifference[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const genuine = new Set<T>(crossModelDisagreements(items, rows, crossModel));
  const identityRecorded = !!rows && rowsRecordExecutionIdentity(rows);
  const ctx = rows && identityRecorded && crossModel ? liveRunContext(rows) : null;
  const out: RecordedDifference[] = [];
  for (const item of items) {
    if (!item || genuine.has(item)) continue;
    const basis: QualifiedDisagreementBasis = !crossModel
      ? "single_independent_model"
      : !rows || !identityRecorded
        ? "independence_unverified"
        : (classifyDisagreementAgainstRows(item, ctx!) as QualifiedDisagreementBasis);
    const pbm = item.positionsByModel && typeof item.positionsByModel === "object" ? item.positionsByModel : {};
    out.push({
      topic: typeof item.topic === "string" ? item.topic : "",
      whyTheyDiffer: typeof item.whyTheyDiffer === "string" && item.whyTheyDiffer.trim() ? item.whyTheyDiffer : null,
      basis,
      basisText: QUALIFIED_DISAGREEMENT_TEXT[basis],
      positions: Object.entries(pbm as Record<string, unknown>)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .map(([slot, position]) => ({ voice: executingVoiceName(slot, rows), position })),
    });
  }
  return out;
}


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
  /**
   * Present (true) only when at least two slots answered but the rows do not record which models executed
   * (`rowsRecordExecutionIdentity` false — the gate's coverage "unverified"): no consensus, no "agreed by" / "split"
   * counts, and no absence-of-disagreement claim on any surface.
   */
  independenceUnverified?: true;
  /**
   * Present only when the run has stored disagreement items that are NOT genuine disagreements between independent
   * executing models (`recordedDifferences`): each kept with its topic, reason and positions named by executing model,
   * presented in its own "Recorded differences not counted as model disagreements" section on every surface — never as
   * a disagreement, never reduced to a count. Absent when every stored item is genuine (unaffected runs).
   */
  recordedDifferences?: RecordedDifference[];
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
  // At least two slots answered but which models executed is not recorded: nothing may be presented as cross-model.
  const independenceUnverified = crossModel && !!rows && !rowsRecordExecutionIdentity(rows);
  const topFinding = report.keyFindings?.[0];
  const topConsensus = topFinding?.claim ?? report.executiveSummary?.slice(0, 200) ?? "No consensus identified.";
  const consensusModelCount = independentVoiceCount(topFinding?.modelsSupporting ?? [], rows);

  // Only real cross-model disagreements (crossModelDisagreements): never one model's positions presented as a split.
  const genuineDisagreements = crossModelDisagreements(report.disagreements, rows, crossModel);
  const topDisagreementItem = genuineDisagreements[0];
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

  // Evidence grounding reads the first STORED disagreement topic, as before the independent-voice rule: grounding is a
  // decision label, so the cross-model reduction above changes only what is presented as a disagreement.
  const grounding = classifyGrounding(
    topConsensus,
    topFinding?.evidenceRefs,
    report.disagreements?.[0]?.topic ?? undefined
  );

  // Every stored item that is not a genuine disagreement between independent models, kept as evidence (never erased,
  // never presented as a disagreement, never reduced to a count).
  const recorded = recordedDifferences(report.disagreements, rows, crossModel);

  return {
    question,
    crossModel,
    ...(independenceUnverified ? { independenceUnverified: true as const } : {}),
    ...(recorded.length > 0 ? { recordedDifferences: recorded } : {}),
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
  if (v.crossModel === false) return "Finding (one independent model; not a consensus)";
  return v.independenceUnverified ? INDEPENDENCE_UNVERIFIED_FINDING_PREFIX : "Consensus";
}

/**
 * The verdict's recorded differences (`recordedDifferences`) under their own heading, in full: topic and reason, why the
 * positions differ, and each position named by its executing model. Empty when none.
 */
export function recordedDifferenceLines(v: Pick<PanelVerdict, "recordedDifferences">, bullet = "-"): string[] {
  const items = v.recordedDifferences ?? [];
  if (items.length === 0) return [];
  const lines = [`${RECORDED_DIFFERENCES_HEADING}:`];
  for (const d of items) {
    lines.push(`${bullet} ${d.topic} — ${d.basisText}`);
    if (d.whyTheyDiffer) lines.push(`  ${d.whyTheyDiffer}`);
    for (const p of d.positions) lines.push(`  ${p.voice}: ${p.position}`);
  }
  return lines;
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
  parts.push(...recordedDifferenceLines(v));

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
  // The first recorded difference (never an absence claim, never under "Disagreement:"): with its positions by executing
  // model, else without them, else dropped — the first optional line to go when over the limit.
  const recorded = v.recordedDifferences?.[0];
  const recordedHead = recorded ? `Recorded difference (${recorded.basisText}): ${firstSentence(recorded.topic)}` : null;
  const recordedPositions = recorded?.positions.map((p) => `${p.voice}: ${firstSentence(p.position)}`).join("; ") ?? "";
  const recordedCandidates = recordedHead ? [...(recordedPositions ? [`${recordedHead} — ${recordedPositions}`] : []), recordedHead] : [];
  let recordedLine: string | null = recordedCandidates[0] ?? null;
  if (recordedLine) parts.push(recordedLine);

  parts.push(`Gate: ${v.gateLabel}`);

  if (v.keyBlindSpot) {
    parts.push(`Caveat: ${firstSentence(v.keyBlindSpot)}`);
  }

  parts.push("");
  parts.push("via ConvergePanel");

  let text = parts.join("\n");

  // If still over 280, drop optional sections one at a time
  for (let i = 1; text.length > 280 && recordedLine !== null; i++) {
    const idx = parts.indexOf(recordedLine);
    recordedLine = recordedCandidates[i] ?? null;
    if (recordedLine !== null) parts[idx] = recordedLine;
    else parts.splice(idx, 1);
    text = parts.join("\n");
  }
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
  parts.push(...recordedDifferenceLines(v));

  parts.push(`Verification Gate: ${v.gateLabel}`);

  if (v.keyBlindSpot) {
    parts.push(`Caveat: ${v.keyBlindSpot}`);
  }

  parts.push("");
  parts.push("via ConvergePanel — multi-model AI synthesis");

  const fullText = parts.join("\n");
  return splitIntoXThread(fullText);
}
