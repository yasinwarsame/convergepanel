/**
 * OpenAI Token Parameter Utilities
 * 
 * Determines which token parameter to use based on OpenAI model name.
 * 
 * Some models (GPT-5.x, o1, o3, o4) require max_completion_tokens instead of max_tokens.
 * This utility ensures we use the correct parameter for each model.
 */

/**
 * Get token limit parameters for OpenAI API call
 * 
 * Different OpenAI models require different token parameters:
 * - GPT-5.x, o1, o3, o4: Use max_completion_tokens
 * - GPT-4, GPT-3.5, others: Use max_tokens
 * 
 * This prevents "Unsupported parameter: 'max_tokens'" errors.
 * 
 * @param model - OpenAI model name (e.g., "gpt-5.1", "gpt-4o", "o1-preview")
 * @param defaultTokens - Default token limit (default: 3000)
 * @returns Object with either max_tokens or max_completion_tokens property
 * 
 * @example
 * ```ts
 * const params = getTokenParams("gpt-5.1", 3000);
 * // Returns: { max_completion_tokens: 3000 }
 * 
 * const params = getTokenParams("gpt-4o", 3000);
 * // Returns: { max_tokens: 3000 }
 * ```
 */
export function getTokenParams(
  model: string,
  defaultTokens: number = 3000
): { max_tokens?: number; max_completion_tokens?: number } {
  const modelLower = model.toLowerCase();
  
  // Models that require max_completion_tokens
  // GPT-5.x series and reasoning models (o1, o3, o4)
  if (
    modelLower.startsWith("gpt-5") ||
    modelLower.startsWith("o1") ||
    modelLower.startsWith("o3") ||
    modelLower.startsWith("o4")
  ) {
    return { max_completion_tokens: defaultTokens };
  }
  
  // All other models use max_tokens (GPT-4, GPT-3.5, etc.)
  return { max_tokens: defaultTokens };
}

