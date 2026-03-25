/**
 * Claim verification pipeline: parsing, scoring, audit bundles, and prompts.
 */

import type { ModelId, ModelResult } from "@/lib/types";
import { CONNECTOR_MAP } from "@/lib/connectors";
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

  const outcomes = await Promise.allSettled(
    selectedModels.map((modelId) => {
      const connector = CONNECTOR_MAP[modelId];
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
      return r.modelId === modelId ? r : { ...r, modelId };
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
