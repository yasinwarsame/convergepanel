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
 *    voice (fail closed: never more independence than can be proven).
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
    return `substitute:${recordedProvider(row.provider) ?? "unknown"}`;
  }
  // Slot ids are lower-case everywhere; normalising here as the provider key
  // is normalised means a case variant can only merge (fewer voices), never split.
  return `slot:${String(row.modelId).trim().toLowerCase()}`;
}

/**
 * Reduce rows to independent voices: the first row per executing model is
 * kept, every later row with the same executor is dropped. Callers pass rows
 * already filtered to usable (ok / substituted with text).
 */
export function independentVoices<T extends VoiceRow>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = executingModelKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
