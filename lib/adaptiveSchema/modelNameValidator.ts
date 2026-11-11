/**
 * Model-Name Hallucination Validator (Synthesis Report Polish, B1)
 *
 * Guards free-text model output (executive summary, disagreement
 * explanations) against inventing or misremembering a model name — e.g. a
 * model call producing "Gemini 3 Pro" in prose when the run's actual roster
 * only has "gemini" (display name "Gemini 3.5 Flash-Lite"). This is a defense
 * specifically for LLM-GENERATED prose; the "Gemini 3 Pro" bug actually
 * observed in production had a simpler root cause (a stale static registry
 * entry in lib/modelInfo.ts, fixed directly in verdict.ts) — this validator
 * covers the case a synthesis-model call hallucinates a name on its own.
 *
 * Client-safe: no "server-only" import, since callers may want to reuse the
 * detection logic without pulling in the server-only synthesis pipeline.
 */

import { ModelId } from "@/lib/types";
import { getModelDisplayNameSafe, PANEL_MODELS } from "@/lib/panelModels";
import { runModelFamilyName } from "@/lib/panel/runModelIdentity";

/**
 * Matches common LLM-family name patterns that could plausibly appear as a
 * hallucinated/misremembered model name in generated prose. Heuristic, not
 * exhaustive — good enough to catch the version-number-guessing failure mode
 * ("Gemini 3 Pro", "GPT-4o", "Claude 3.5 Sonnet") without false-triggering on
 * ordinary sentences. "Flash-Lite" / "Flash Lite" (Google's own displayName
 * spelling) is matched whole, and the Gemini suffix may follow a hyphen as in
 * the API id (GEMINI_MODEL_ID, lowercase and hyphenated), so the real roster model is recognised
 * in every spelling rather than flagged as "Gemini 3.5 Flash" or a bare version token.
 */
const MODEL_NAME_TOKEN_PATTERN =
  /\b(GPT[\s-]?\d[\w.]*(?:[\s-]+(?:Turbo|Pro|mini|nano))?|Claude(?:\s+(?:Opus|Sonnet|Haiku))?[\s-]?\d[\w.]*(?:\s+(?:Opus|Sonnet|Haiku))?|Gemini[\s-]?\d[\w.]*(?:[\s-]+(?:Pro|Flash(?:[\s-]+Lite)?|Ultra|Nano))?|Grok[\s-]?\d[\w.]*(?:-\d+)*(?:[\s-]+(?:Fast|Mini|Heavy))?(?:[\s-]+(?:non-)?reasoning)?|Perplexity(?:\s+(?:Pro|Sonar))?|Llama[\s-]?\d[\w.]*|Mistral(?:\s+\w+)?|DeepSeek(?:[\s-]?\w+)?)\b/gi;

/**
 * Comparison key for a model name: lower case, with every run of spaces and
 * hyphens collapsed to one space, so "Gemini 3.5 Flash-Lite", "Gemini 3.5
 * Flash Lite" and the hyphenated lowercase API id are the same model.
 */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[\s-]+/g, " ").trim();
}

/** The run's own names (display name, family name, id, requested API model ID) as comparison keys. */
function allowedNameKeys(roster: ModelId[]): Set<string> {
  const requested = (id: ModelId) => PANEL_MODELS.find((m) => m.id === id)?.requestedModelId ?? id;
  return new Set(roster.flatMap((id) => [getModelDisplayNameSafe(id), runModelFamilyName(id), id, requested(id)]).map(nameKey));
}

/** Returns every model-name-like token in `text` that isn't one of the run's actual display names. */
export function findUnrecognizedModelNames(text: string, roster: ModelId[]): string[] {
  // A roster model may be named by its display name ("Perplexity Sonar"), its family name ("Perplexity") or
  // its ID ("perplexity") — the narrative prompt asks for IDs. Only names outside the roster are flagged.
  const allowed = allowedNameKeys(roster);
  const matches = text.match(MODEL_NAME_TOKEN_PATTERN) || [];
  const unrecognized = new Set<string>();
  for (const match of matches) {
    if (!allowed.has(nameKey(match))) {
      unrecognized.add(match);
    }
  }
  return Array.from(unrecognized);
}

export function containsUnrecognizedModelName(text: string, roster: ModelId[]): boolean {
  return findUnrecognizedModelNames(text, roster).length > 0;
}

/**
 * Last-resort fallback after a failed regenerate: replace any unrecognized model-name token with a neutral phrase.
 * Replaces whole matched tokens only (the same tokens findUnrecognizedModelNames reports), never a substring: a
 * real "Gemini 3.5 Flash-Lite" next to an invalid "Gemini 3.5 Flash" stays intact instead of becoming "the panel-Lite".
 */
export function stripUnrecognizedModelNames(text: string, roster: ModelId[]): string {
  const allowed = allowedNameKeys(roster);
  return text.replace(MODEL_NAME_TOKEN_PATTERN, (match) => (allowed.has(nameKey(match)) ? match : "the panel"));
}
