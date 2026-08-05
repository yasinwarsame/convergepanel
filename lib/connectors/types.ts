/**
 * LLM connector adapter: provider-specific HTTP, auth, and response shaping.
 */

export type ConnectorCallOptions = {
  systemPromptOverride?: string;
  /** When set (e.g. claim verification), Gemini uses this as generationConfig.maxOutputTokens. */
  maxOutputTokens?: number;
  /**
   * Gemini-only: caps internal "thinking" tokens, which otherwise share the
   * same budget as maxOutputTokens on 2.5-series models and can silently
   * consume it entirely (finishReason MAX_TOKENS with an empty/truncated
   * visible response) on a small maxOutputTokens value. Set to 0 for
   * short, structured, non-reasoning outputs (e.g. classification JSON)
   * where thinking has no benefit and only risks starving the real answer.
   */
  thinkingBudget?: number;
};
