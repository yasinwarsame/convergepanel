/**
 * Independent-voice rule for agreement / consensus aggregation.
 *
 * A panel slot answered by the DeepSeek fallback (`status: "substituted"`) is
 * still displayed as a labelled substitute, but its text was written by the
 * substitute provider, not by the slot's own provider. Several substituted
 * slots answered by the same substitute are ONE underlying model: counting
 * them separately would manufacture agreement (N copies of one model "agree"
 * with each other).
 *
 * Rule: every aggregator that counts agreeing/supporting models first reduces
 * its usable rows to independent voices — one per executing model:
 *  - a non-substituted row is its own voice, keyed by its slot (`modelId`,
 *    trimmed and lower-cased like the provider key);
 *  - a substituted row is keyed by the provider that actually executed it
 *    (`provider`, e.g. "deepseek"). The first such row in panel order is kept;
 *    later rows with the same executor are dropped from agreement counting.
 *    A substituted row that recorded no provider (older saved runs) is keyed
 *    "unknown" — all unrecorded substitutes together count as at most one
 *    voice, and when the same set also holds a substitute with a recorded
 *    provider the unrecorded ones merge into it (`resolveExecutingModelKeys`):
 *    an unrecorded substitute may have been that same model, so it never adds
 *    a voice (fail closed: never more independence than can be proven).
 *
 * The provider, not `actualModel`, is the key because `actualModel` is not
 * persisted on saved runs (runtimeModelProvenance, S2) and the DeepSeek
 * fallback serves a single model; keying by provider makes the live result
 * and a reloaded run agree, and can only merge more, never less.
 *
 * Pure and client-safe. Never mutates its input; preserves input order.
 */

import { coerceStatus } from "./normalize";

/** Why a later slot answered by an already-counted substitute model is not an agreement input (adaptive runs). */
export const REPEATED_SUBSTITUTE_EXCLUDED =
  "Not counted as an independent model: answered by the same substitute model as another panel slot.";

export type VoiceRow = {
  modelId: string;
  status: string;
  provider?: unknown;
};

function recordedProvider(provider: unknown): string | null {
  if (typeof provider !== "string") return null;
  const p = provider.trim().toLowerCase();
  return p.length > 0 && p !== "unknown" ? p : null;
}

/** The identity of the model that actually wrote this row's text. */
export function executingModelKey(row: VoiceRow): string {
  if (coerceStatus(row.status) === "substituted") {
    const p = recordedProvider(row.provider);
    return p ? `substitute:${p}` : UNRECORDED_SUBSTITUTE_KEY;
  }
  // Slot ids are lower-case everywhere; normalising here as the provider key
  // is normalised means a case variant can only merge (fewer voices), never split.
  return `slot:${String(row.modelId).trim().toLowerCase()}`;
}

/** `executingModelKey` of a substituted row whose provider was not recorded. */
export const UNRECORDED_SUBSTITUTE_KEY = "substitute:unknown";

/**
 * Resolve the executing-model keys of ONE set of rows (same order, same length): an unrecorded substitute
 * (`UNRECORDED_SUBSTITUTE_KEY`) is merged into the first recorded substitute key of the set, because the unrecorded row
 * may have been answered by that same substitute model. With no recorded substitute in the set the keys are unchanged
 * (all unrecorded substitutes already share one key). Can only merge, never split.
 */
export function resolveExecutingModelKeys(keys: readonly string[]): string[] {
  const firstRecorded = keys.find((k) => k.startsWith("substitute:") && k !== UNRECORDED_SUBSTITUTE_KEY);
  return firstRecorded ? keys.map((k) => (k === UNRECORDED_SUBSTITUTE_KEY ? firstRecorded : k)) : [...keys];
}

/**
 * Reduce rows to independent voices: the first row per executing model is
 * kept, every later row with the same executor is dropped. Callers pass rows
 * already filtered to usable (ok / substituted with text).
 */
export function independentVoices<T extends VoiceRow>(rows: readonly T[]): T[] {
  const keys = resolveExecutingModelKeys(rows.map((row) => executingModelKey(row)));
  const seen = new Set<string>();
  const out: T[] = [];
  rows.forEach((row, i) => {
    const key = keys[i];
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  });
  return out;
}

/** The panel's synthesis minimum: at least this many INDEPENDENT executing models among the usable responses. */
export const MIN_INDEPENDENT_SYNTHESIS_MODELS = 2;

/** A client-held result row: live `ModelResult` or a reloaded run's public row. */
export type ClientSynthesisRow = VoiceRow & { rawTextFull?: unknown; rawText?: unknown; text?: unknown };

/**
 * The text a client row carries: the first NON-EMPTY of `rawTextFull`, `rawText`, `text`. The one text getter for the
 * client synthesis gate and the synthesis payload (`PanelSynthesisView`), so a row the gate counts is never sent empty.
 */
export function clientRowText(row: ClientSynthesisRow): string {
  for (const v of [row.rawTextFull, row.rawText, row.text]) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

/**
 * The independent executing models a client holds usable responses from: rows that answered (ok / substituted) with
 * non-empty text, reduced to one per executing model. The client mirror of the server synthesis gate
 * (`authoritativeSynthesisInputs`, which applies the same reduction to the persisted rows).
 */
export function independentSynthesisResponders<T extends ClientSynthesisRow>(rows: readonly T[]): T[] {
  const usable = rows.filter((r) => {
    if (!r) return false;
    const s = coerceStatus(r.status);
    return (s === "ok" || s === "substituted") && clientRowText(r).trim().length > 0;
  });
  return independentVoices(usable);
}

/** True when the rows meet the synthesis minimum of independent executing models (client pre-flight / auto-trigger). */
export function meetsIndependentSynthesisMinimum(rows: readonly ClientSynthesisRow[]): boolean {
  return independentSynthesisResponders(rows).length >= MIN_INDEPENDENT_SYNTHESIS_MODELS;
}

/**
 * Whether a STORED research run's consensus score may be presented as multi-model agreement, judged only from what the
 * run document persisted (`runDocument.perModel`, else `resultsCompact.perModel`; each row `{ modelId, status,
 * rawTextTruncated, provider? }`):
 *  - "independent": the persisted rows meet `meetsIndependentSynthesisMinimum` (≥ 2 independent executing models);
 *  - "insufficient": the rows carry execution identity (a string `status` on every row) and reduce to fewer than two;
 *  - "unverified": no persisted rows, or rows without a recorded status — execution identity cannot be established, so
 *    nothing is inferred from response slots (fail closed: never presented as agreement).
 * Pure; reads nothing else, never mutates the document.
 */
export type StoredConsensusIndependence = "independent" | "insufficient" | "unverified";

/**
 * The persisted execution-identity rows of a STORED research run (`runDocument.perModel`, else `resultsCompact.perModel`),
 * or null when execution identity cannot be established: no rows, or any row without a non-empty string `modelId` and a
 * string `status`. Each row keeps its recorded `provider` and its stored text. Pure; never mutates the document.
 */
export function storedRunPerModelRows(data: Record<string, unknown> | null | undefined): ClientSynthesisRow[] | null {
  if (!data || typeof data !== "object") return null;
  const fromRunDocument = (data.runDocument as { perModel?: unknown } | undefined)?.perModel;
  const perModel = Array.isArray(fromRunDocument) ? fromRunDocument : (data.resultsCompact as { perModel?: unknown } | undefined)?.perModel;
  if (!Array.isArray(perModel) || perModel.length === 0) return null;
  const rows: ClientSynthesisRow[] = [];
  for (const raw of perModel) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.modelId !== "string" || r.modelId.trim().length === 0 || typeof r.status !== "string") return null;
    rows.push({ modelId: r.modelId, status: r.status, provider: r.provider, rawTextFull: r.rawTextTruncated, rawText: r.rawText, text: r.text });
  }
  return rows;
}

export function storedRunConsensusIndependence(data: Record<string, unknown> | null | undefined): StoredConsensusIndependence {
  const rows = storedRunPerModelRows(data);
  if (!rows) return "unverified";
  return meetsIndependentSynthesisMinimum(rows) ? "independent" : "insufficient";
}

/** Why a stored consensus score is withheld from a list surface (absent when the score is shown). */
export type ConsensusScoreWithheldReason = "insufficient_independent_models" | "independence_unverified";

export function consensusScoreWithheldReason(independence: StoredConsensusIndependence): ConsensusScoreWithheldReason | undefined {
  if (independence === "independent") return undefined;
  return independence === "insufficient" ? "insufficient_independent_models" : "independence_unverified";
}

/** Short display text for a withheld stored consensus score. */
export const CONSENSUS_WITHHELD_TEXT: Readonly<Record<ConsensusScoreWithheldReason, string>> = Object.freeze({
  insufficient_independent_models: "No consensus score (fewer than two independent models)",
  independence_unverified: "Consensus score withheld (model independence not recorded)",
});
