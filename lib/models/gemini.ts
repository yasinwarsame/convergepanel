/**
 * Google Gemini model identity — the ONE place the Gemini model id and its
 * customer label are defined. Client-safe: no server imports.
 *
 * Every Gemini call (research panel slot, claim verification, every adaptive
 * stage via callGemini, and video vision) sends GEMINI_MODEL_ID, and the panel
 * records GEMINI_MODEL_ID as the run's requestedModel for the gemini slot.
 *
 * Why gemini-3.5-flash-lite: Google's deprecations page (fetched
 * 2026-11-09T19:57:52Z) states "Effective December 1, 2026, all API requests
 * to `gemini-2.5-flash` will automatically route to `gemini-3.5-flash-lite`
 * and be billed at Gemini 3.5 Flash-Lite rates." Calling it by name keeps the
 * recorded model truthful and applies the 3.x request rules ourselves instead
 * of relying on the auto-route. Same price as gemini-2.5-flash ($0.30 in /
 * $2.50 out per 1M tokens, aistudio.google.com/docs/pricing).
 */

export const GEMINI_MODEL_ID = "gemini-3.5-flash-lite" as const;

/** Customer-facing label for the gemini slot. Must name the model actually called. */
export const GEMINI_DISPLAY_NAME = "Gemini 3.5 Flash-Lite" as const;

/**
 * generationConfig.thinkingConfig.thinkingLevel values, as listed in the
 * generateContent API reference (aistudio.google.com/api-reference/generate-content):
 * "Possible values: THINKING_LEVEL_UNSPECIFIED, MINIMAL, LOW, MEDIUM, HIGH" —
 * "Recommended for Gemini 3 or later models."
 */
export type GeminiThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
