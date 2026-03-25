/**
 * LLM connector adapter: provider-specific HTTP, auth, and response shaping.
 */

export type ConnectorCallOptions = {
  systemPromptOverride?: string;
  /** When set (e.g. claim verification), Gemini uses this as generationConfig.maxOutputTokens. */
  maxOutputTokens?: number;
};
