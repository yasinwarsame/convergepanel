/**
 * Which slots does a run's PERSISTED record establish as "corrective retry succeeded and was included in the report"?
 *
 * Read-time presentation only: pure, no I/O, no writes, never throws. Its answer only selects the wording of a
 * saved-copy notice (SAVED_COPY_RETRIED_INCLUDED); it never feeds counts, consensus, scoring or certainty.
 *
 * What the record holds (verified against the write path, not assumed):
 *   - `adaptiveRetryUsage` (lib/firestore/adaptiveRetryAccounting.ts, written by applyAdaptiveRetryAccounting from
 *     AdaptiveRetryUsageSink.freeze() in retryCorrection.ts): per-slot `byModel[modelId].calls`. A call is recorded
 *     for EVERY issued retry (orchestrate.ts retryModelOnce: guard timeout / thrown call / non-ok status / no_change /
 *     adopted alike). So `calls >= 1` proves a retry was ATTEMPTED, never that it succeeded. The per-slot
 *     `retryOutcome` is not persisted for the Milestone-2 envelope.
 *   - `adaptiveOutput.result` for comparison_matrix: every `cells[].valuesByModel` key is a slot whose ADOPTED
 *     adaptive result had data (orchestrate.ts builds perModelCells only from `r.ok && r.data`; comparisonAlignment.ts
 *     keys valuesByModel by that slot's modelId).
 *
 * The predicate, per slot, all required (anything malformed, absent or wrong-typed fails closed to "not established"):
 *   (1) the envelope is comparison_matrix (the only schema whose per-slot attribution is read here; every other
 *       schema keeps the neutral notice);
 *   (2) `adaptiveRetryUsage` is a well-formed schemaVersion-1 record whose top-level `calls` equals the sum of its
 *       per-slot calls, and this slot's `calls` is an integer >= 1;
 *   (3) at least one persisted cell attributes a non-empty value to this slot.
 * The caller (reconstructModelResults) adds: (4) the saved row's status is exactly "ok", (5) its saved copy was not
 * shortened for storage, (6) the saved copy does not validate, and (7) the slot id occurs once in the saved rows.
 *
 * Why (2)+(3)+(6) establish success: a retry is only issued for an "ok" slot whose first answer either failed
 * validation (ok=false, data=null → contributes no cells) or validated with invalid fields (ok=true → its saved copy
 * validates again, so (6) excludes it). A slot that needed a retry, whose saved first answer does not validate, but
 * whose data is in the persisted cells can only have had its retry adopted (mergeAdaptiveRetry "adopted_full").
 * Assumption, stated: the saved copy (sanitizeModelText — trim plus a duplicated-halves heuristic — of the same
 * text) validates the same way today as the first answer did live; validator changes since the run are not detected.
 */
import type { PersistedAdaptiveOutputV1 } from "./persistedOutput";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetryCallCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Slot ids with at least one well-formed retry call in a well-formed persisted `adaptiveRetryUsage`; empty otherwise. */
export function slotsWithRecordedRetry(raw: unknown): Set<string> {
  const none = new Set<string>();
  if (!isPlainObject(raw) || raw.schemaVersion !== 1 || !isRetryCallCount(raw.calls) || !isPlainObject(raw.byModel)) return none;
  const slots = new Set<string>();
  let sum = 0;
  for (const [modelId, entry] of Object.entries(raw.byModel)) {
    if (!isPlainObject(entry) || !isRetryCallCount(entry.calls)) return none;
    sum += entry.calls;
    slots.add(modelId);
  }
  // The sink writes calls = number of recorded slots = Σ byModel calls; anything else is not a record it wrote.
  return sum === raw.calls ? slots : none;
}

/** Slot ids the persisted comparison_matrix result attributes at least one non-empty cell value to; empty for any other schema. */
export function slotsAttributedInResult(output: PersistedAdaptiveOutputV1): Set<string> {
  const slots = new Set<string>();
  if (output.schemaId !== "comparison_matrix") return slots;
  const cells: unknown = output.result.cells;
  if (!Array.isArray(cells)) return slots;
  for (const cell of cells) {
    if (!isPlainObject(cell) || !isPlainObject(cell.valuesByModel)) continue;
    for (const [modelId, value] of Object.entries(cell.valuesByModel)) {
      if (typeof value === "string" && value.trim().length > 0) slots.add(modelId);
    }
  }
  return slots;
}

/** Conditions (1)–(3) above: the slots whose retry the persisted record establishes as successful and included. */
export function retriedIncludedSlotsFromRecord(adaptiveRetryUsage: unknown, output: PersistedAdaptiveOutputV1): Set<string> {
  const retried = slotsWithRecordedRetry(adaptiveRetryUsage);
  if (retried.size === 0) return retried;
  const attributed = slotsAttributedInResult(output);
  return new Set(Array.from(retried).filter((modelId) => attributed.has(modelId)));
}
