/**
 * Token Extraction Utilities
 * 
 * Extracts token usage from provider API responses in a provider-agnostic way.
 * Handles different response formats from OpenAI, Anthropic, Perplexity, and X.AI (Grok).
 */

export type ProviderKey = "openai" | "anthropic" | "perplexity" | "xai" | "google";

export interface TokenUsage {
  totalTokens: number; // Always a number (0 if unavailable)
  promptTokens: number | null; // null if unavailable
  completionTokens: number | null; // null if unavailable
}

/**
 * Safe number helper: converts any value to a number, defaulting to 0 if invalid
 * Used to ensure totalTokens is always a number (never null/undefined/NaN)
 * 
 * Exported for use in instrumentation and verification
 */
export function safeNum(val: any): number {
  if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
    return val;
  }
  return 0; // Default to 0 for null, undefined, NaN, or negative values
}

/**
 * Safe number or null helper: preserves null for prompt/completion tokens
 * Returns null if value is not a valid number
 */
function safeNumOrNull(val: any): number | null {
  if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
    return val;
  }
  return null;
}

/**
 * Extract token usage from OpenAI-compatible response (OpenAI, Perplexity, X.AI/Grok)
 * 
 * OpenAI format:
 * {
 *   usage: {
 *     prompt_tokens: number,
 *     completion_tokens: number,
 *     total_tokens: number
 *   }
 * }
 */
function extractOpenAIUsage(response: any): TokenUsage {
  if (!response || typeof response !== "object") {
    return { totalTokens: 0, promptTokens: null, completionTokens: null };
  }

  const usage = response.usage;
  if (!usage || typeof usage !== "object") {
    return { totalTokens: 0, promptTokens: null, completionTokens: null };
  }

  const promptTokens = safeNumOrNull(usage.prompt_tokens);
  const completionTokens = safeNumOrNull(usage.completion_tokens);
  const totalTokens = safeNumOrNull(usage.total_tokens);

  // If we have total_tokens, use it; otherwise sum prompt + completion (use 0 for null)
  const finalTotalTokens = totalTokens ?? 
    ((promptTokens ?? 0) + (completionTokens ?? 0));

  return {
    totalTokens: safeNum(finalTotalTokens), // Always a number (0 if unavailable)
    promptTokens,
    completionTokens,
  };
}

/**
 * Extract token usage from Gemini response
 * 
 * Gemini SDK response format:
 * {
 *   response: {
 *     usageMetadata: {
 *       promptTokenCount: number,
 *       candidatesTokenCount: number,
 *       totalTokenCount: number
 *     }
 *   }
 * }
 * 
 * OR the usageMetadata might be directly on the response object passed in.
 */
function extractGeminiUsage(response: any): TokenUsage {
  // CRITICAL: Always return numeric values, never NaN
  // If usageMetadata is missing or invalid, return all zeros
  
  if (!response || typeof response !== "object") {
    return { totalTokens: 0, promptTokens: null, completionTokens: null };
  }

  // Handle both response.response.usageMetadata and response.usageMetadata
  const usageMetadata = response.response?.usageMetadata || response.usageMetadata;
  
  // If usageMetadata is missing or invalid, return zeros (treat Gemini as 0 tokens)
  if (!usageMetadata || typeof usageMetadata !== "object") {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[tokenExtraction] Gemini usageMetadata missing or invalid, treating as 0 tokens`);
    }
    return { totalTokens: 0, promptTokens: null, completionTokens: null };
  }

  // Extract with safeNum to ensure we never get NaN
  // Map Gemini fields: promptTokenCount, candidatesTokenCount, totalTokenCount
  const promptTokens = safeNumOrNull(usageMetadata.promptTokenCount);
  const completionTokens = safeNumOrNull(usageMetadata.candidatesTokenCount);
  const totalTokensRaw = safeNumOrNull(usageMetadata.totalTokenCount);

  // Compute totalTokens: prefer totalTokenCount, otherwise sum prompt + completion
  // Use safeNum to ensure final value is always a finite number
  const totalTokens = totalTokensRaw ?? 
    ((promptTokens ?? 0) + (completionTokens ?? 0));

  // CRITICAL: Use safeNum on finalTotalTokens to catch any NaN that might have slipped through
  const finalTotalTokens = safeNum(totalTokens);

  // Always return a valid TokenUsage object (never null, never NaN)
  return {
    totalTokens: finalTotalTokens, // Always a finite number (0 if unavailable)
    promptTokens: promptTokens ?? null,
    completionTokens: completionTokens ?? null,
  };
}

/**
 * Extract token usage from Anthropic response
 * 
 * Anthropic format:
 * {
 *   usage: {
 *     input_tokens: number,
 *     output_tokens: number
 *   }
 * }
 */
function extractAnthropicUsage(response: any): TokenUsage {
  if (!response || typeof response !== "object") {
    return { totalTokens: 0, promptTokens: null, completionTokens: null };
  }

  const usage = response.usage;
  if (!usage || typeof usage !== "object") {
    return { totalTokens: 0, promptTokens: null, completionTokens: null };
  }

  const inputTokens = safeNumOrNull(usage.input_tokens);
  const outputTokens = safeNumOrNull(usage.output_tokens);

  // Anthropic doesn't provide total_tokens, so we sum input + output
  // Sum what we have (if one is null, use 0 for that part to avoid losing tokens)
  const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);

  return {
    totalTokens: safeNum(totalTokens), // Always a number (0 if both are null)
    promptTokens: inputTokens, // Anthropic uses "input_tokens" for prompt
    completionTokens: outputTokens, // Anthropic uses "output_tokens" for completion
  };
}

/**
 * Get total tokens from a provider response
 * 
 * This is the main entry point for extracting token usage.
 * It handles different provider response formats automatically.
 * 
 * CRITICAL: Always returns a TokenUsage object (never null/undefined).
 * If extraction fails, returns { totalTokens: 0, promptTokens: null, completionTokens: null }
 * 
 * @param providerKey - The provider identifier ("openai", "anthropic", "perplexity", "xai", "google")
 * @param rawResponse - The raw API response object from the provider
 * @returns TokenUsage object with totalTokens (always number), promptTokens, completionTokens
 */
export function getTotalTokensFromProviderResponse(
  providerKey: ProviderKey,
  rawResponse: any
): TokenUsage {
  // Default fallback: return zero tokens if response is invalid
  const defaultUsage: TokenUsage = { totalTokens: 0, promptTokens: null, completionTokens: null };

  if (!rawResponse || typeof rawResponse !== "object") {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[tokenExtraction] Invalid response for ${providerKey}, returning zero tokens`);
    }
    return defaultUsage;
  }

  try {
    switch (providerKey) {
      case "openai":
      case "perplexity":
      case "xai":
        // OpenAI-compatible format (OpenAI, Perplexity, X.AI/Grok)
        return extractOpenAIUsage(rawResponse);
      
      case "anthropic":
        // Anthropic format
        return extractAnthropicUsage(rawResponse);
      
      case "google":
        // Gemini format
        return extractGeminiUsage(rawResponse);
      
      default:
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[tokenExtraction] Unknown provider: ${providerKey}, returning zero tokens`);
        }
        return defaultUsage;
    }
  } catch (error: any) {
    console.error(`[tokenExtraction] Error extracting tokens for ${providerKey}:`, error);
    return defaultUsage; // Return zero tokens on error (never null)
  }
}

/**
 * Map ModelId to ProviderKey for token extraction
 */
export function modelIdToProviderKey(modelId: string): ProviderKey | null {
  const mapping: Record<string, ProviderKey> = {
    chatgpt: "openai",
    claude: "anthropic",
    perplexity: "perplexity",
    grok: "xai",
    gemini: "google",
  };
  return mapping[modelId] || null;
}

