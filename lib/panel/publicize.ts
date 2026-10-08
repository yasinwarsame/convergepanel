/**
 * Public boundary helpers for panel results.
 *
 * Use these functions at EVERY public boundary (API responses, UI hydration,
 * synthesis input building) to guarantee:
 *  - status ∈ {"ok", "substituted", "failed"}
 *  - saved-run reads never manufacture requestedModel/provider/actualModel (S1)
 *  - substitutedFrom in "<provider>:<model>" format
 *  - substitutionReason is a sanitized code-like string
 *  - No internal/legacy statuses ever leak to consumers
 */

import type { ModelStatus } from "@/lib/types";
import type { PersistedPanelResultPublic } from "./schemas";
import { normalizePersistedModelResult, assertPublicStatus, coerceStatus } from "./normalize";

/**
 * Normalize a run's legacy stored top-level `results[]` (the pre-`runDocument`
 * format) for the saved-run read APIs — its only callers.
 *
 * Saved-run provenance honesty (S1): status is coerced, but runtime provenance
 * is kept only as stored and never filled (see `normalizePersistedModelResult`);
 * `actualModel` is not returned. The LIVE contract that guarantees those fields
 * is `normalizeModelResultPublic`, used by run execution, not this function.
 */
export function publicizePanelResults(rawResults: unknown[]): PersistedPanelResultPublic[] {
  if (!Array.isArray(rawResults)) return [];

  return rawResults
    .filter((r): r is Record<string, unknown> =>
      r != null && typeof r === "object" && typeof (r as any).modelId === "string"
    )
    .map((raw) => {
      const normalized = normalizePersistedModelResult(raw as any);
      assertPublicStatus(normalized.status, `publicizePanelResults(${String(normalized.modelId)})`);
      return normalized as unknown as PersistedPanelResultPublic;
    });
}

/**
 * Check whether a result status counts as "usable" (has valid model text).
 * Substituted results contain valid DeepSeek text and should be included
 * alongside "ok" results in synthesis, consensus, and agreement map logic.
 */
export function isUsableResult(result: { status: string }): boolean {
  const s = coerceStatus(result.status);
  return s === "ok" || s === "substituted";
}

/**
 * Coerce a status for UI consumption. Guarantees the result is one of
 * "ok" | "substituted" | "failed". Safe for use in state, props, rendering.
 */
export function publicStatus(raw: string): ModelStatus {
  return assertPublicStatus(raw, "publicStatus");
}
