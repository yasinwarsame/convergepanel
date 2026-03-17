/**
 * Public boundary helpers for panel results.
 *
 * Use these functions at EVERY public boundary (API responses, UI hydration,
 * synthesis input building) to guarantee:
 *  - status ∈ {"ok", "substituted", "failed"}
 *  - requestedModel, provider, actualModel always present
 *  - substitutedFrom in "<provider>:<model>" format
 *  - substitutionReason is a sanitized code-like string
 *  - No internal/legacy statuses ever leak to consumers
 */

import type { ModelStatus } from "@/lib/types";
import type { PanelResultPublic } from "./schemas";
import { normalizeModelResultPublic, assertPublicStatus, coerceStatus } from "./normalize";

/**
 * Normalize an array of raw result objects to PanelResultPublic[].
 * Applies full normalization: status coercion, metadata defaults,
 * substitutedFrom format, and dev-only assertion.
 *
 * Use at API response boundaries (run-panel, etc.).
 */
export function publicizePanelResults(rawResults: unknown[]): PanelResultPublic[] {
  if (!Array.isArray(rawResults)) return [];

  return rawResults
    .filter((r): r is Record<string, unknown> =>
      r != null && typeof r === "object" && typeof (r as any).modelId === "string"
    )
    .map((raw) => {
      const normalized = normalizeModelResultPublic(raw as any);
      assertPublicStatus(normalized.status, `publicizePanelResults(${normalized.modelId})`);
      return normalized as unknown as PanelResultPublic;
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
