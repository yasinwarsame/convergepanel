/**
 * Ruling B (2026-11-02): per-model results for a REOPENED Milestone-2 report.
 *
 * The Milestone-2 envelope (`adaptiveOutput`) stores the aggregated result, not each model's parsed answer. Its reader
 * therefore had `results: []`, and the "Model Responses" section said raw responses "aren't saved". But every model's
 * response IS saved, on the run itself (`runDocument.perModel`). This rebuilds each model's structured result from
 * that saved text with the SAME validator a live run uses. It is a pure re-reading:
 *   - no provider call, no write, no new data (the saved text is already in the same read payload);
 *   - a model that did not respond becomes a failed slot, exactly as live (`parseError: "Empty response"`), which the
 *     comparison notes then label "did not respond" from the run's recorded status (D-4);
 *   - a saved copy the validator cannot structure gets a fixed notice: SAVED_COPY_SHORTENED when the storage cap
 *     shortened it, otherwise SAVED_COPY_UNSTRUCTURED. The saved text is the FIRST answer; a live corrective retry is
 *     never saved, so neither implies the model answered in the wrong format;
 *   - owner-authorized (2026-11-07): when the caller passes `retriedIncludedSlots` (savedCopyRetryEvidence.ts — the
 *     persisted record establishes that slot's retry succeeded and was included) and the row is exactly "ok", appears
 *     once, was not shortened, and its saved copy does not validate, the notice is SAVED_COPY_RETRIED_INCLUDED.
 *     No evidence keeps SAVED_COPY_UNSTRUCTURED. (Shortened no longer outranks the record: review D1, case (3) below.)
 *
 * Saved-response presentation (2026-11-11) — `savedResponseText`, display only, carries the saved copy exactly as
 * stored wherever that copy is what the Model Responses section shows:
 *   (1) the copy validates → the structured result, plus the copy (the "Show original response" disclosure);
 *   (2) it is authentic but does not validate, and no record establishes a retry → the copy, shown as saved text;
 *   (3) the storage cap shortened it → the copy, shown as saved text, labelled shortened and as the first answer; but
 *       when the record ties a retry to the slot, no copy and SAVED_COPY_RETRIED_SHORTENED instead (review D1);
 *   (4) the record establishes the retry succeeded and was included → no copy (the saved first answer was superseded);
 *       the notice says the corrected response was not preserved separately;
 *   (5) the slot answered but there is no saved text → SAVED_COPY_MISSING, which claims neither inclusion nor exclusion.
 * Saved text is shown as plain text, never parsed into structure (review D2). Nothing is parsed leniently and nothing is re-requested: the same validator, the same saved text, no provider call.
 */
import "server-only";
import type { AdaptiveModelResult } from "./types";
import type { ModelId } from "@/lib/types";
import { SCHEMA_REGISTRY, getResultSchema } from "./schemaRegistry";
import { validateAdaptiveResponse } from "./validator";
import { SAVED_COPY_MISSING, SAVED_COPY_RETRIED_INCLUDED, SAVED_COPY_RETRIED_SHORTENED, SAVED_COPY_SHORTENED, SAVED_COPY_UNSTRUCTURED } from "./savedCopyNotice";

export { SAVED_COPY_MISSING, SAVED_COPY_RETRIED_INCLUDED, SAVED_COPY_RETRIED_SHORTENED, SAVED_COPY_SHORTENED, SAVED_COPY_UNSTRUCTURED };

export type SavedPanelRow = { modelId: string; status?: unknown; rawText?: unknown; wasTruncatedForStorage?: unknown };

export function reconstructModelResults(
  schemaId: string,
  rows: readonly SavedPanelRow[],
  options: { retriedIncludedSlots?: ReadonlySet<string> } = {}
): AdaptiveModelResult[] {
  // getResultSchema() falls back to `generic` for an unknown id; validating against the wrong schema would be a guess.
  if (!Object.prototype.hasOwnProperty.call(SCHEMA_REGISTRY, schemaId)) return [];
  const schema = getResultSchema(schemaId as never);
  // A slot id seen twice cannot be tied to one record entry: never the retried notice for it.
  const occurrences = new Map<string, number>();
  for (const row of rows) occurrences.set(row.modelId, (occurrences.get(row.modelId) ?? 0) + 1);
  const retriedIncluded = options.retriedIncludedSlots;
  return rows.map((row) => {
    const modelId = row.modelId as ModelId;
    const responded = row.status === "ok" || row.status === "substituted";
    const text = typeof row.rawText === "string" ? row.rawText : null;
    if (!responded) return { modelId, schemaId: schema.id, ok: false, data: null, parseError: "Empty response" };
    // Silent: a read emits no log lines (the parse-error message can quote model text).
    const result = validateAdaptiveResponse(modelId, schema, text, { silent: true });
    // Display only: the saved copy exactly as stored, when there is one.
    const saved = text !== null && text.trim().length > 0 ? { savedResponseText: text } : {};
    if (result.ok) return { ...result, ...saved };
    const retryRecordedAndAttributed = row.status === "ok" && occurrences.get(row.modelId) === 1 && retriedIncluded?.has(row.modelId) === true;
    if (row.wasTruncatedForStorage === true) {
      // Review D1: a retry the record ties to this slot outranks the shortened first answer, which is then not shown.
      // A shortened copy can't show the first answer failed in full, so success is not claimed (SAVED_COPY_RETRIED_SHORTENED).
      if (retryRecordedAndAttributed) return { ...result, parseError: SAVED_COPY_RETRIED_SHORTENED };
      return { ...result, parseError: SAVED_COPY_SHORTENED, ...saved };
    }
    if (retryRecordedAndAttributed) {
      // The saved first answer was superseded by the included retry: it is not shown as this model's response.
      return { ...result, parseError: SAVED_COPY_RETRIED_INCLUDED };
    }
    if (!("savedResponseText" in saved)) return { ...result, parseError: SAVED_COPY_MISSING };
    // Review R2 MINOR-A: a live corrective retry is never saved, so a non-validating saved copy proves nothing about exclusion.
    return { ...result, parseError: SAVED_COPY_UNSTRUCTURED, ...saved };
  });
}
