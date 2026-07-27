/**
 * Model-Name Hallucination Validator (Synthesis Report Polish, B1)
 *
 * Guards free-text model output (executive summary, disagreement
 * explanations) against inventing or misremembering a model name — e.g. a
 * model call producing "Gemini 3 Pro" in prose when the run's actual roster
 * only has "gemini" (display name "Gemini 2.0 Flash"). This is a defense
 * specifically for LLM-GENERATED prose; the "Gemini 3 Pro" bug actually
 * observed in production had a simpler root cause (a stale static registry
 * entry in lib/modelInfo.ts, fixed directly in verdict.ts) — this validator
 * covers the case a synthesis-model call hallucinates a name on its own.
 *
 * Client-safe: no "server-only" import, since callers may want to reuse the
 * detection logic without pulling in the server-only synthesis pipeline.
 */

import { ModelId } from "@/lib/types";
import { getModelDisplayNameSafe } from "@/lib/panelModels";

/**
 * Matches common LLM-family name patterns that could plausibly appear as a
 * hallucinated/misremembered model name in generated prose. Heuristic, not
 * exhaustive — good enough to catch the version-number-guessing failure mode
 * ("Gemini 3 Pro", "GPT-4o", "Claude 3.5 Sonnet") without false-triggering on
 * ordinary sentences.
 */
const MODEL_NAME_TOKEN_PATTERN =
  /\b(GPT[\s-]?\d[\w.]*(?:\s+(?:Turbo|Pro|mini|nano))?|Claude(?:\s+(?:Opus|Sonnet|Haiku))?[\s-]?\d[\w.]*(?:\s+(?:Opus|Sonnet|Haiku))?|Gemini[\s-]?\d[\w.]*(?:\s+(?:Pro|Flash|Ultra|Nano))?|Grok[\s-]?\d[\w.]*|Perplexity(?:\s+(?:Pro|Sonar))?|Llama[\s-]?\d[\w.]*|Mistral(?:\s+\w+)?|DeepSeek(?:[\s-]?\w+)?)\b/gi;

/** Returns every model-name-like token in `text` that isn't one of the run's actual display names. */
export function findUnrecognizedModelNames(text: string, roster: ModelId[]): string[] {
  const allowed = new Set(roster.map((id) => getModelDisplayNameSafe(id).toLowerCase()));
  const matches = text.match(MODEL_NAME_TOKEN_PATTERN) || [];
  const unrecognized = new Set<string>();
  for (const match of matches) {
    if (!allowed.has(match.toLowerCase())) {
      unrecognized.add(match);
    }
  }
  return Array.from(unrecognized);
}

export function containsUnrecognizedModelName(text: string, roster: ModelId[]): boolean {
  return findUnrecognizedModelNames(text, roster).length > 0;
}

/** Last-resort fallback after a failed regenerate: replace any unrecognized model-name token with a neutral phrase. */
export function stripUnrecognizedModelNames(text: string, roster: ModelId[]): string {
  const unrecognized = findUnrecognizedModelNames(text, roster);
  let cleaned = text;
  for (const name of unrecognized) {
    cleaned = cleaned.split(name).join("the panel");
  }
  return cleaned;
}
