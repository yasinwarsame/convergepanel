/**
 * Item 7B — provider termination reasons, normalized. Pure, client-safe, never throws.
 *
 * Each connector reports WHY its provider stopped generating, as a separate fact from the connector `status`. This
 * module never changes a status: a provider call that stopped at its output budget may still be "ok" (text returned)
 * or "error" (no text returned), exactly as before, so runPanel's retry and substitution contracts are unchanged.
 *
 * Only a value the provider itself reports is mapped:
 *   - "output_budget": the provider says it stopped because the requested output-token limit was reached.
 *   - "natural": the provider says it finished on its own (end of turn / stop / completed).
 *   - "other": the provider reported some other reason (safety, refusal, context window, tool call, ...).
 * A missing or non-string value maps to undefined (unknown). Malformed JSON is never evidence of either.
 *
 * Provider evidence (checked 2026-11-24):
 *   - Anthropic Messages `stop_reason`: "max_tokens" = "reached the max_tokens limit specified in your request";
 *     "end_turn", "stop_sequence" = natural (platform.claude.com/docs/en/api/handling-stop-reasons).
 *   - OpenAI Chat Completions `finish_reason`: "length" = "the maximum number of tokens specified in the request was
 *     reached"; "stop" = natural (developers.openai.com/api/reference/resources/chat/subresources/completions).
 *   - xAI chat completions: OpenAI-compatible `finish_reason` (the same "length" / "stop" values).
 *   - Gemini `finishReason`: "MAX_TOKENS" = "The maximum number of tokens as specified in the request was reached";
 *     "STOP" = natural (aistudio.google.com/api-reference/generate-content).
 *   - Perplexity Agent API: `status` "completed" = natural; `status` "incomplete" with
 *     `incomplete_details.reason` "max_output_tokens" = the run stopped at its max_output_tokens budget.
 */

export type ProviderTerminationReason = "output_budget" | "natural" | "other";

export const PROVIDER_TERMINATION_REASONS: readonly ProviderTerminationReason[] = ["output_budget", "natural", "other"];

/** Anthropic `stop_reason`. */
export function claudeTermination(stopReason: unknown): ProviderTerminationReason | undefined {
  if (typeof stopReason !== "string" || stopReason.length === 0) return undefined;
  if (stopReason === "max_tokens") return "output_budget";
  if (stopReason === "end_turn" || stopReason === "stop_sequence") return "natural";
  return "other";
}

/** OpenAI-compatible `finish_reason` (OpenAI, xAI). */
export function openAiCompatibleTermination(finishReason: unknown): ProviderTerminationReason | undefined {
  if (typeof finishReason !== "string" || finishReason.length === 0) return undefined;
  if (finishReason === "length") return "output_budget";
  if (finishReason === "stop") return "natural";
  return "other";
}

/** Gemini `candidates[0].finishReason`. */
export function geminiTermination(finishReason: unknown): ProviderTerminationReason | undefined {
  if (typeof finishReason !== "string" || finishReason.length === 0 || finishReason === "FINISH_REASON_UNSPECIFIED") return undefined;
  if (finishReason === "MAX_TOKENS") return "output_budget";
  if (finishReason === "STOP") return "natural";
  return "other";
}

/** Perplexity Agent API run `status` + `incomplete_details.reason` (agent-shaped responses only). */
export function perplexityTermination(status: unknown, incompleteReason: unknown): ProviderTerminationReason | undefined {
  if (status === "completed") return "natural";
  if (status === "incomplete") return incompleteReason === "max_output_tokens" ? "output_budget" : typeof incompleteReason === "string" && incompleteReason.length > 0 ? "other" : undefined;
  return undefined;
}

export function isProviderTerminationReason(v: unknown): v is ProviderTerminationReason {
  return typeof v === "string" && (PROVIDER_TERMINATION_REASONS as readonly string[]).includes(v);
}
