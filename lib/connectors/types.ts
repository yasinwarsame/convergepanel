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
  /**
   * Gemini-only, diagnostics only: which stage made the call. It goes into the
   * sanitized failure log and changes no request behaviour. Absent means a
   * panel call.
   */
  diagnosticOperation?: GeminiDiagnosticOperation;
};

/** Closed set, so a log can never carry free text through this field. */
export type GeminiDiagnosticOperation =
  | "panel"
  | "classification"
  | "claim_cluster"
  | "stance_backfill"
  | "bias_detection"
  | "coverage_audit"
  | "synthesis_narrative";
