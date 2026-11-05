/**
 * Fail-closed handling for a connector whose provider API key is not configured.
 *
 * A missing key must never produce a model response: no fabricated text, status
 * "error", and a typed `errorCode` so aggregation, retry and fallback logic can
 * tell a configuration gap apart from a provider failure. Identical in every
 * environment (Production, Preview, development).
 *
 * Never logs or returns the key value.
 */

import type { ModelId, ModelResult } from "@/lib/types";
import { logger } from "@/lib/logger";

/** True only for a non-empty, non-whitespace string key. */
export function isApiKeyConfigured(apiKey: string | null | undefined): apiKey is string {
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

export function providerNotConfiguredResult(
  modelId: ModelId,
  providerLabel: string,
  envVarName: string
): ModelResult {
  logger.warn(`[${modelId} connector] Provider not configured; returning error result without calling the provider`, {
    modelId,
    errorCode: "provider_not_configured",
  });
  return {
    modelId,
    status: "error",
    rawText: null,
    errorCode: "provider_not_configured",
    errorMessage: `${providerLabel} is not available: ${envVarName} is not configured.`,
    latencyMs: 0,
    tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
  };
}
