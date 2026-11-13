/**
 * Claim verification pipeline: parsing, scoring, audit bundles, and prompts.
 */

import type { ModelId, ModelResult } from "@/lib/types";
import { CONNECTOR_MAP, connectorProvider } from "@/lib/connectors";
import { buildClaimVerificationPrompt } from "./claimVerificationPrompt";

const VERIFY_USER_MESSAGE =
  "Return ONLY the JSON object specified in your system instructions. No markdown fences or other text.";

/** Gemini verification JSON is large; default panel limit was too low and caused truncation. */
const VERIFY_GEMINI_MAX_OUTPUT_TOKENS = 8192;

export type ApiKeys = Partial<Record<ModelId, string | undefined>>;

export async function runClaimVerificationPanel(
  claim: string,
  selectedModels: ModelId[],
  apiKeys: ApiKeys
): Promise<ModelResult[]> {
  const system = buildClaimVerificationPrompt(claim.trim());

  // The connector function each slot is dispatched to, captured once: the same function is invoked and names the
  // provider recorded for its answer (Order 33).
  const dispatched = selectedModels.map((modelId) => CONNECTOR_MAP[modelId]);

  const outcomes = await Promise.allSettled(
    selectedModels.map((modelId, i) => {
      const connector = dispatched[i];
      if (!connector) {
        return Promise.resolve({
          modelId,
          status: "error" as const,
          rawText: null,
          errorMessage: "No connector",
          latencyMs: 0,
          tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
        } satisfies ModelResult);
      }
      return connector(VERIFY_USER_MESSAGE, null, apiKeys[modelId], {
        systemPromptOverride: system,
        ...(modelId === "gemini" ? { maxOutputTokens: VERIFY_GEMINI_MAX_OUTPUT_TOKENS } : {}),
      });
    })
  );

  return selectedModels.map((modelId, index) => {
    const outcome = outcomes[index];
    if (outcome.status === "fulfilled") {
      const r = outcome.value;
      const row: ModelResult = r.modelId === modelId ? r : { ...r, modelId };
      // Order 33 (owner ruling A): an own-provider ANSWER records the provider of the connector function this dispatch
      // actually invoked (server-owned constant, never the slot name or anything the request carried). Any other
      // outcome records none (a substitute keeps the provider its own result reports, as before).
      if (row.status === "substituted") return row;
      const provider = row.status === "ok" ? connectorProvider(dispatched[index]) : null;
      if (provider) return { ...row, provider };
      const { provider: _notRecorded, ...rest } = row;
      void _notRecorded;
      return rest;
    }
    return {
      modelId,
      status: "error" as const,
      rawText: null,
      errorMessage: String(
        outcome.reason && typeof outcome.reason === "object" && "message" in outcome.reason
          ? (outcome.reason as Error).message
          : outcome.reason || "error"
      ),
      latencyMs: 0,
      tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
    };
  });
}
