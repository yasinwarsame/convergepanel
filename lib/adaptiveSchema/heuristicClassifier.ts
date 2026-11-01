/**
 * D-2 (shared Adaptive Schema architecture, 2026-11-02): a deterministic fallback classifier.
 *
 * It is used ONLY when the model classifier could not complete: a connector error (Production 2026-11-01: Gemini HTTP
 * 402 on every call), a timeout, malformed JSON or a schema-invalid answer. It is never used for a model verdict of
 * low confidence; that remains `generic`, as before.
 *
 * Contract:
 *   - Maps to EXISTING `QueryType`s only. It has no taxonomy of its own and no provider call, so it costs nothing.
 *   - Precision over recall: a rule fires only on an unambiguous surface pattern. Anything else returns null, and the
 *     caller keeps `generic`. A mis-route only changes presentation: every model response still renders.
 *   - First matching rule wins. The order is fixed below and pinned by tests.
 *   - Never produces a handoff, disabled, limitation or clarification type.
 */

import type { QueryType } from "./types";

export type HeuristicRule = { id: string; queryType: QueryType; pattern: RegExp };

/** Ordered. "What are the risks of …" must reach checklist before any "what is/are" rule could claim it. */
export const HEURISTIC_RULES: readonly HeuristicRule[] = [
  { id: "comparison", queryType: "comparison_matrix", pattern: /\b(compare|comparing|comparison of|versus|vs\.?)\b|\bdifferences? between\b/i },
  { id: "risks_or_tradeoffs", queryType: "checklist_taxonomy", pattern: /\b(what are the (main |key |biggest )?risks|risks of|pros and cons|advantages and disadvantages)\b/i },
  { id: "decision", queryType: "decision_support", pattern: /^\s*(should (i|we|our|my|the|a|an)\b|is it worth\b|would it be (wise|better)\b)/i },
  { id: "causal", queryType: "causal_explanation", pattern: /^\s*(why (did|do|does|is|are|was|were|has|have)\b|what (caused|causes|led to|drives|drove)\b)/i },
  // A time horizon, or "Will …" with a change verb. A bare "Will this compile?" or "Will you help?" is not a forecast.
  {
    id: "forecast",
    queryType: "forecast_speculative",
    pattern: /\bin the next \d+ (years?|months?|decades?)\b|\bby (19|20)\d\d\b|\bforecast\b|^\s*will\b.*\b(eliminate|replace|increase|decrease|rise|fall|grow|decline|overtake|surpass|outnumber|collapse|recover|disappear)\b/i,
  },
  { id: "procedure", queryType: "procedural", pattern: /^\s*(how (do|can|should) (i|we|you)\b|how to\b|what are the steps\b|steps to\b)/i },
  { id: "ranking", queryType: "ranked_enumeration", pattern: /\btop \d+\b|^\s*(what are the )?best \d+\b|\brank (the )?\w+/i },
  { id: "definition", queryType: "definition_explanation", pattern: /^\s*(define\b|definition of\b|what does .{1,80} mean\b)/i },
];

/** The rule that matches, or null (keep generic). Pure. */
export function heuristicClassify(query: string): { queryType: QueryType; ruleId: string } | null {
  const q = query.trim();
  if (!q) return null;
  for (const rule of HEURISTIC_RULES) {
    if (rule.pattern.test(q)) return { queryType: rule.queryType, ruleId: rule.id };
  }
  return null;
}
