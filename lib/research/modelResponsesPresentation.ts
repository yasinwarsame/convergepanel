/**
 * Saved-response and comparison presentation (2026-11-11) — pure, client-safe helpers for the Model Responses section
 * of a Milestone-2 report (components/adaptive/ModelResponsesSection.tsx).
 *
 * Display only. Nothing here is read by scoring, consensus, gates, certainty or governance; nothing calls a provider,
 * fetches or writes. Model text is returned as data for React to escape; nothing is parsed beyond what the validator
 * already produced.
 */
import type { AdaptiveModelResult, ComparisonCell } from "@/lib/adaptiveSchema/types";
import { SAVED_COPY_NOTICES } from "@/lib/adaptiveSchema/savedCopyNotice";

// ─── Comparison table (one model's own cells) ───────────────────────────────

export const COMPARISON_VERDICT_LABEL: Record<NonNullable<ComparisonCell["verdict"]>, string> = {
  better: "Better",
  worse: "Worse",
  even: "Even",
};

/** One entry in a table position: the cell's value, with its exact verdict when it has one. */
export interface ComparisonTableEntry {
  value: string;
  verdict?: ComparisonCell["verdict"];
}

export interface ComparisonTableModel {
  /** Subjects in first-appearance order (exact strings, never merged or renamed). */
  subjects: string[];
  /** Attributes in first-appearance order (exact strings, never merged or renamed). */
  attributes: string[];
  /** entries[subjectIndex][attributeIndex]: every cell for that position, in input order; more than one when the model repeated it. */
  entries: ComparisonTableEntry[][][];
  /** Cells with an empty subject or attribute: they have no table position, so they are listed separately, never dropped. */
  unpaired: ComparisonCell[];
  /** Cells placed in the table + unpaired cells; always equals the input length. */
  cellCount: number;
}

/** `value (Verdict)`, or the value alone when the cell has no verdict. */
export function comparisonEntryText(entry: ComparisonTableEntry): string {
  const verdict = entry.verdict ? COMPARISON_VERDICT_LABEL[entry.verdict] : undefined;
  return verdict ? `${entry.value} (${verdict})` : entry.value;
}

const isBlank = (s: unknown) => typeof s !== "string" || s.trim().length === 0;

/**
 * Rows = subjects, columns = attributes, deterministic by first appearance. Every input cell is kept: a repeated
 * (subject, attribute) position keeps all its entries, and a cell without a subject or attribute goes to `unpaired`.
 */
export function buildComparisonTable(cells: readonly ComparisonCell[]): ComparisonTableModel {
  const subjects: string[] = [];
  const attributes: string[] = [];
  const subjectIndex = new Map<string, number>();
  const attributeIndex = new Map<string, number>();
  const placed: { s: number; a: number; entry: ComparisonTableEntry }[] = [];
  const unpaired: ComparisonCell[] = [];
  for (const cell of cells) {
    if (isBlank(cell.subject) || isBlank(cell.attribute)) {
      unpaired.push(cell);
      continue;
    }
    if (!subjectIndex.has(cell.subject)) {
      subjectIndex.set(cell.subject, subjects.length);
      subjects.push(cell.subject);
    }
    if (!attributeIndex.has(cell.attribute)) {
      attributeIndex.set(cell.attribute, attributes.length);
      attributes.push(cell.attribute);
    }
    placed.push({
      s: subjectIndex.get(cell.subject)!,
      a: attributeIndex.get(cell.attribute)!,
      entry: { value: cell.value, ...(cell.verdict ? { verdict: cell.verdict } : {}) },
    });
  }
  const entries: ComparisonTableEntry[][][] = subjects.map(() => attributes.map(() => []));
  for (const { s, a, entry } of placed) entries[s][a].push(entry);
  return { subjects, attributes, entries, unpaired, cellCount: placed.length + unpaired.length };
}

/** Human names for comparison_matrix's per-model fields (the JSON keys are never shown). */
export const COMPARISON_FIELD_LABEL: Record<string, string> = {
  cells: "Comparison",
  directConclusion: "Conclusion",
  tradeoffs: "Trade-offs",
  bestUseRecommendations: "Best for",
  uncertainties: "Uncertainties",
};

// ─── Counts ─────────────────────────────────────────────────────────────────

/** Recorded call statuses that mean the slot produced an answer. Any other recorded status means it did not. */
const ANSWERED_STATUSES = new Set(["ok", "substituted"]);

const NO_SLOTS: ReadonlySet<string> = new Set();

/**
 * Slots the run's provenance facts record as the stored no-API-key placeholder (J02: `invalidProviderOutput === true`,
 * written by `withPlaceholderFact` from the single `placeholderClass` oracle). Same predicate FailedResultsNote reads.
 */
export function invalidProviderOutputSlots(provenance: readonly ({ modelId?: unknown; invalidProviderOutput?: unknown } | null | undefined)[] | null): ReadonlySet<string> {
  const out = new Set<string>();
  for (const f of provenance ?? []) if (f && typeof f.modelId === "string" && f.invalidProviderOutput === true) out.add(f.modelId);
  return out;
}

export interface ModelResponsesSummary {
  /** Panel slots the run requested (one result per slot). */
  requested: number;
  /** Slots that produced an answer (recorded status ok/substituted). */
  answered: number;
  /** Of those, slots answered by a substitute model. */
  substituted: number;
  /** Slots that failed, timed out, were refused or rate-limited: no answer. */
  didNotRespond: number;
  /** Slots whose stored text is the no-API-key placeholder (the J02 fact): not a model response, never counted as answered. */
  notAModelResponse: number;
  /** Answers shown as a structured response. */
  structuredShown: number;
  /** Saved answers shown as saved text (a reopened report whose copy can't be read in the report's format). */
  savedTextShown: number;
  /** Saved answers with nothing to show (a reopened report). Not model failures. */
  savedCopyUnavailable: number;
  /** Live answers that could not be used in the report's format. */
  unusable: number;
}

/**
 * Each slot is counted once. Whether a slot answered comes from its recorded call status when the surface holds it;
 * without one, a slot whose result is the validator's "Empty response" with no saved text did not respond. Text is
 * never inspected (a response that merely mentions "mock response" is an answer like any other).
 */
export function summarizeModelResponses(
  results: readonly AdaptiveModelResult[],
  statuses: ReadonlyMap<string, string> | null,
  invalidOutputSlots: ReadonlySet<string> = NO_SLOTS
): ModelResponsesSummary {
  const summary: ModelResponsesSummary = {
    requested: results.length,
    answered: 0,
    substituted: 0,
    didNotRespond: 0,
    notAModelResponse: 0,
    structuredShown: 0,
    savedTextShown: 0,
    savedCopyUnavailable: 0,
    unusable: 0,
  };
  for (const r of results) {
    if (invalidOutputSlots.has(r.modelId)) {
      summary.notAModelResponse += 1;
      continue;
    }
    const status = statuses?.get(r.modelId);
    const recorded = typeof status === "string" && status.length > 0;
    const answered = recorded ? ANSWERED_STATUSES.has(status) : !(r.parseError === "Empty response" && !r.ok && r.savedResponseText === undefined);
    if (!answered) {
      summary.didNotRespond += 1;
      continue;
    }
    summary.answered += 1;
    if (status === "substituted") summary.substituted += 1;
    if (r.ok && r.data) summary.structuredShown += 1;
    else if (typeof r.savedResponseText === "string") summary.savedTextShown += 1;
    else if (r.parseError && SAVED_COPY_NOTICES.has(r.parseError)) summary.savedCopyUnavailable += 1;
    else summary.unusable += 1;
  }
  return summary;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The two count lines: what the panel did, then what this section shows. Zero-count parts are omitted (except the first of each line). */
export function modelResponsesCountLines(s: ModelResponsesSummary): [string, string] {
  const panel = [
    `${plural(s.requested, "model", "models")} requested`,
    `${s.answered} answered${s.substituted > 0 ? ` (${s.substituted} by a substitute model)` : ""}`,
    ...(s.didNotRespond > 0 ? [`${s.didNotRespond} did not respond`] : []),
    ...(s.notAModelResponse > 0 ? [`${s.notAModelResponse} not a model response (no API key configured)`] : []),
  ];
  const shown = [
    `${plural(s.structuredShown, "structured response", "structured responses")} shown`,
    ...(s.savedTextShown > 0 ? [`${s.savedTextShown} shown as saved text`] : []),
    ...(s.savedCopyUnavailable > 0 ? [`${plural(s.savedCopyUnavailable, "saved copy", "saved copies")} can't be shown`] : []),
    ...(s.unusable > 0 ? [`${s.unusable} answered in a format that couldn't be used`] : []),
  ];
  return [panel.join(" · "), shown.join(" · ")];
}

/**
 * Which slots the section shows as a card: a structured result, or a saved copy shown as saved text. Everything else
 * (no response, a saved copy with nothing to show, a live answer in an unusable format) goes to the failure note, which
 * states each once.
 */
export function partitionModelResponses(
  results: readonly AdaptiveModelResult[],
  statuses: ReadonlyMap<string, string> | null,
  invalidOutputSlots: ReadonlySet<string> = NO_SLOTS
) {
  const cards: AdaptiveModelResult[] = [];
  const notes: AdaptiveModelResult[] = [];
  for (const r of results) {
    // A stored no-API-key placeholder is never shown as an answer: the failure note states it (J02 notice).
    if (invalidOutputSlots.has(r.modelId)) {
      notes.push(r);
      continue;
    }
    const status = statuses?.get(r.modelId);
    const recordedNoAnswer = typeof status === "string" && status.length > 0 && !ANSWERED_STATUSES.has(status);
    if (!recordedNoAnswer && ((r.ok && r.data) || typeof r.savedResponseText === "string")) cards.push(r);
    else notes.push(r);
  }
  return { cards, notes };
}
