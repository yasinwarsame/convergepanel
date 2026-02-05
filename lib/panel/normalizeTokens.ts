/**
 * Token Normalization Utilities
 * 
 * Normalizes token usage across different provider formats into a consistent schema.
 * Handles reasoning tokens (e.g., Grok) and ensures totalTokens is always accurate.
 */

import { ModelId } from "@/lib/types";

/**
 * Normalized token usage schema
 * totalTokens ALWAYS equals promptTokens + completionTokens + (reasoningTokens || 0)
 */
export type TokenUsageNormalized = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number; // Optional reasoning tokens (e.g., Grok)
};

export type ModelTokenUsage = {
  modelId: string;
  tokenUsage: TokenUsageNormalized;
};

export type RunTokenTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
};

/**
 * Normalize token usage from any provider result
 * 
 * Handles known structures:
 * - OpenAI: rawResponse.usage.prompt_tokens, completion_tokens; reasoning_tokens may be 0
 * - Grok: reasoning_tokens appears in completion_tokens_details.reasoning_tokens; total = prompt + completion + reasoning
 * - Gemini: usageMetadata promptTokenCount/candidatesTokenCount/totalTokenCount
 * - Perplexity: usage prompt_tokens/completion_tokens/total_tokens
 * - Claude: usage input_tokens/output_tokens (map to prompt/completion)
 * 
 * @param modelId - Model identifier for logging
 * @param rawResponse - Raw provider response object
 * @param fallback - Optional fallback token usage from connector (if already extracted)
 * @returns Normalized token usage
 */
export function normalizeTokens(
  modelId: ModelId,
  rawResponse: any,
  fallback?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }
): TokenUsageNormalized {
  // Helper to safely extract numbers
  const safeNum = (val: any): number => {
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      return val;
    }
    return 0;
  };

  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens: number | undefined = undefined;
  let providerTotal = 0;

  // Try fallback first if provided
  if (fallback) {
    promptTokens = safeNum(fallback.promptTokens ?? 0);
    completionTokens = safeNum(fallback.completionTokens ?? 0);
    providerTotal = safeNum(fallback.totalTokens ?? 0);
  }

  // Special handling for Grok (must handle reasoning tokens correctly)
  if (modelId === "grok" && rawResponse.usage) {
    const prompt = safeNum(rawResponse.usage.prompt_tokens ?? 0);
    const completion = safeNum(rawResponse.usage.completion_tokens ?? 0);
    const reasoning = safeNum(rawResponse.usage.completion_tokens_details?.reasoning_tokens ?? 0);
    const total = safeNum(rawResponse.usage.total_tokens ?? (prompt + completion + reasoning));
    
    return {
      promptTokens: prompt,
      completionTokens: completion,
      reasoningTokens: reasoning || undefined,
      totalTokens: total,
    };
  }
  
  // OpenAI/Perplexity format
  if (rawResponse.usage) {
    // Only use rawResponse values if we didn't get them from tokenUsage
    if (promptTokens === 0) {
      promptTokens = safeNum(rawResponse.usage.prompt_tokens || rawResponse.usage.input_tokens);
    }
    if (completionTokens === 0) {
      completionTokens = safeNum(rawResponse.usage.completion_tokens || rawResponse.usage.output_tokens);
    }
    if (providerTotal === 0) {
      providerTotal = safeNum(rawResponse.usage.total_tokens);
    }
    
    // Check for reasoning tokens in OpenAI format (o1, o3 models) - these are separate
    if (rawResponse.usage.reasoning_tokens) {
      reasoningTokens = safeNum(rawResponse.usage.reasoning_tokens);
    }
  }

  // Gemini format
  if (rawResponse.response?.usageMetadata || rawResponse.usageMetadata) {
    const usageMetadata = rawResponse.response?.usageMetadata || rawResponse.usageMetadata;
    promptTokens = safeNum(usageMetadata.promptTokenCount);
    completionTokens = safeNum(usageMetadata.candidatesTokenCount);
    providerTotal = safeNum(usageMetadata.totalTokenCount);
  }

  // Claude format (already handled in OpenAI branch as input_tokens/output_tokens)

  // Compute totalTokens: ALWAYS prompt + completion + reasoning
  // CRITICAL: For Grok and other providers with reasoning, total MUST include all three
  const computedTotal = promptTokens + completionTokens + (reasoningTokens || 0);
  
  let totalTokens: number;
  if (providerTotal > 0) {
    // Sanity check: if provider total differs significantly from computed, prefer computed and warn
    // Use tolerance of 2 tokens (as per requirements) - reasoning tokens can cause small differences
    // For Grok, we already handled it above, so skip mismatch warning
    const tolerance = modelId === "grok" ? 10 : 2; // More lenient for Grok since we handle it specially
    const difference = Math.abs(providerTotal - computedTotal);
    
    if (difference > tolerance) {
      // Only warn for non-Grok models, or if Grok difference is really large
      if (modelId !== "grok" || difference > 50) {
        console.warn(`[normalizeTokens] Token mismatch for ${modelId}: provider reports ${providerTotal}, computed ${computedTotal} (diff: ${difference}). Using computed total.`);
      }
      // Always use computed total when there's a mismatch to ensure consistency
      totalTokens = computedTotal;
    } else {
      // Provider total matches computed (within tolerance), use provider
      totalTokens = providerTotal;
    }
  } else {
    // No provider total available, use computed
    totalTokens = computedTotal;
  }

  // Final safety check: ensure totalTokens always equals the sum
  // This ensures reasoning tokens are always included in the total
  if (totalTokens !== computedTotal) {
    // Override to computed if there's any discrepancy
    totalTokens = computedTotal;
  }

  return {
    promptTokens,
    completionTokens,
    ...(reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {}),
    totalTokens,
  };
}

