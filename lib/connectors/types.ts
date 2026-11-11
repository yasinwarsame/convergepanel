/**
 * LLM connector adapter: provider-specific HTTP, auth, and response shaping.
 */

import type { GeminiThinkingLevel } from "@/lib/models/gemini";

export type ConnectorCallOptions = {
  systemPromptOverride?: string;
  /** When set (e.g. claim verification), Gemini uses this as generationConfig.maxOutputTokens. */
  maxOutputTokens?: number;
  /**
   * Gemini-only: generationConfig.thinkingConfig.thinkingLevel (Gemini 3.x;
   * replaces the 2.5-series `thinkingBudget`, which the 3.x migration guide
   * says to replace). Omitted => GEMINI_THINKING_LEVEL (lib/models/gemini.ts,
   * currently "LOW"); the connector always sends a level, never the model's
   * implicit default. Set only to override that level for one call.
   */
  thinkingLevel?: GeminiThinkingLevel;
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
