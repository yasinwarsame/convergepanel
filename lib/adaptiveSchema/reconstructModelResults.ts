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
 *     never saved, so neither implies the model answered in the wrong format.
 */
import "server-only";
import type { AdaptiveModelResult } from "./types";
import type { ModelId } from "@/lib/types";
import { SCHEMA_REGISTRY, getResultSchema } from "./schemaRegistry";
import { validateAdaptiveResponse } from "./validator";
import { SAVED_COPY_SHORTENED, SAVED_COPY_UNSTRUCTURED } from "./savedCopyNotice";

export { SAVED_COPY_SHORTENED, SAVED_COPY_UNSTRUCTURED };

export type SavedPanelRow = { modelId: string; status?: unknown; rawText?: unknown; wasTruncatedForStorage?: unknown };

export function reconstructModelResults(schemaId: string, rows: readonly SavedPanelRow[]): AdaptiveModelResult[] {
  // getResultSchema() falls back to `generic` for an unknown id; validating against the wrong schema would be a guess.
  if (!Object.prototype.hasOwnProperty.call(SCHEMA_REGISTRY, schemaId)) return [];
  const schema = getResultSchema(schemaId as never);
  return rows.map((row) => {
    const modelId = row.modelId as ModelId;
    const responded = row.status === "ok" || row.status === "substituted";
    const text = typeof row.rawText === "string" ? row.rawText : null;
    if (!responded) return { modelId, schemaId: schema.id, ok: false, data: null, parseError: "Empty response" };
    // Silent: a read emits no log lines (the parse-error message can quote model text).
    const result = validateAdaptiveResponse(modelId, schema, text, { silent: true });
    if (!result.ok && row.wasTruncatedForStorage === true) return { ...result, parseError: SAVED_COPY_SHORTENED };
    // Review R2 MINOR-A: a live corrective retry is never saved, so a non-validating saved copy proves nothing about exclusion.
    if (!result.ok) return { ...result, parseError: SAVED_COPY_UNSTRUCTURED };
    return result;
  });
}
